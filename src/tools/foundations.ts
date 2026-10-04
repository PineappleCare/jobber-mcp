import { z } from "zod";
import { registerJobLineItemDescriptions } from "./job-line-item-descriptions.js";
import { noteFields, recordWithNoteVersions } from "./notes.js";
import { createHash } from "node:crypto";
import type { McpServer } from "@modelcontextprotocol/server";
import { appendAuditLog } from "../utils/auditLog.js";
import { assertMutationAccepted, assertPresent, type MutationPayload } from "../jobber/mutations.js";
import { cursorSchema, isReadOnly, isWriteCapabilityEnabled, pageSizeSchema, registerReadOnlyTool, registerWriteTool, returnedSoFarSchema, pageProgress } from "../tool-helpers.js";

const PAGE_CAP = 20;
const READ_COST = 800;
const WRITE_COST = 300;

const recordTypeSchema = z.enum(["client", "property", "request", "quote", "job", "invoice", "visit"]);
const addressSchema = z.object({
  street1: z.string().trim().min(1).max(200),
  street2: z.string().trim().max(200).optional(),
  city: z.string().trim().min(1).max(100),
  province: z.string().trim().max(100).optional(),
  postal_code: z.string().trim().max(32).optional(),
  country: z.string().trim().min(2).max(2).default("CA"),
});
const emailSchema = z.object({ address: z.string().trim().email().max(320), primary: z.boolean().default(false) });
const phoneSchema = z.object({ number: z.string().trim().min(3).max(40), primary: z.boolean().default(false) });
const lineItemSchema = z.object({
  name: z.string().trim().min(1).max(250),
  description: z.string().trim().max(4000).optional(),
  quantity: z.number().positive().max(100000).default(1),
  unit_price: z.number().finite().min(0).max(1_000_000),
  taxable: z.boolean().optional(),
  product_or_service_id: z.string().trim().min(1).optional(),
});
// Jobber can represent discount lines as signed quantities with a nonnegative price.
// Keep this contract specific to invoices; other creation tools retain their bounds.
const invoiceLineItemSchema = lineItemSchema.extend({
  quantity: z.number().finite().min(-100000).max(100000).refine(value => value !== 0, "Quantity must not be zero").default(1)
    .describe("Positive quantity for charges; negative quantity for a separate discount, e.g. -1 at unit_price 150 deducts 150"),
});
const confirmSchema = z.literal(true).describe("Must be true after reviewing the proposed external change");

type Node = Record<string, any>;

const summaryFields = `id updatedAt jobberWebUri`;
const clientFields = `${summaryFields} name firstName lastName companyName email phone billingAddress { street1 street2 city province postalCode country }`;
const propertyFields = `id name street1 street2 city province postalCode country jobberWebUri`;
const requestFields = `${summaryFields} title requestStatus createdAt client { id name } property { id name }`;
const quoteFields = `${summaryFields} quoteNumber title quoteStatus sentAt message amounts { total } client { id name } property { id name }`;
const jobFields = `${summaryFields} jobNumber title jobStatus instructions total client { id name } property { id name } quote { id } request { id }`;
const invoiceFields = `${summaryFields} invoiceNumber subject invoiceStatus issuedDate dueDate receivedDate amounts { total invoiceBalance } client { id name }`;
const visitFields = `id title visitStatus isComplete completedAt allDay startAt endAt instructions job { id jobNumber title } client { id name } assignedUsers(first: 20) { nodes { id name { full } } }`;

const SEARCHES: Record<z.infer<typeof recordTypeSchema>, string> = {
  client: `query SearchClients($term:String,$first:Int!,$after:String){ clients(searchTerm:$term,first:$first,after:$after){ totalCount nodes { ${clientFields} } pageInfo { hasNextPage endCursor } } }`,
  property: `query SearchProperties($term:String,$after:String){ clients(searchTerm:$term,first:1,after:$after){ nodes { id name properties { ${propertyFields} } } pageInfo { hasNextPage endCursor } } }`,
  request: `query SearchRequests($term:String,$first:Int!,$after:String){ requests(searchTerm:$term,first:$first,after:$after){ totalCount nodes { ${requestFields} } pageInfo { hasNextPage endCursor } } }`,
  quote: `query SearchQuotes($term:String,$first:Int!,$after:String){ quotes(searchTerm:$term,first:$first,after:$after){ totalCount nodes { ${quoteFields} } pageInfo { hasNextPage endCursor } } }`,
  job: `query SearchJobs($term:String,$first:Int!,$after:String){ jobs(searchTerm:$term,first:$first,after:$after){ totalCount nodes { ${jobFields} } pageInfo { hasNextPage endCursor } } }`,
  invoice: `query SearchInvoices($term:String,$first:Int!,$after:String){ invoices(searchTerm:$term,first:$first,after:$after){ totalCount nodes { ${invoiceFields} } pageInfo { hasNextPage endCursor } } }`,
  visit: `query SearchVisits($first:Int!,$after:String){ visits(first:$first,after:$after){ totalCount nodes { ${visitFields} } pageInfo { hasNextPage endCursor } } }`,
};
const GETS: Record<z.infer<typeof recordTypeSchema>, string> = {
  client: `query GetClient($id:EncodedId!){ client(id:$id){ ${clientFields} tags(first:20){nodes{label}} customFields { ... on CustomFieldText { valueText } } notes(first:20){nodes{ ${noteFields} }} } }`,
  property: `query GetProperty($id:EncodedId!){ property(id:$id){ ${propertyFields} client { id name } customFields { ... on CustomFieldText { valueText } } } }`,
  request: `query GetRequest($id:EncodedId!){ request(id:$id){ ${requestFields} lineItems(first:50){nodes{id name description quantity unitPrice totalPrice}} notes(first:20){nodes{... on NoteInterface {${noteFields}}}} } }`,
  quote: `query GetQuote($id:EncodedId!){ quote(id:$id){ ${quoteFields} contractDisclaimer lineItems(first:50){nodes{id name description quantity unitPrice totalPrice taxable}} notes(first:20){nodes{... on NoteInterface {${noteFields}}}} customFields { ... on CustomFieldText { valueText } } } }`,
  job: `query GetJob($id:EncodedId!){ job(id:$id){ ${jobFields} visits(first:50){nodes{${visitFields}}} lineItems(first:50){nodes{id name description quantity unitPrice totalPrice taxable}} notes(first:20){nodes{... on NoteInterface {${noteFields}}}} customFields { ... on CustomFieldText { valueText } } } }`,
  invoice: `query GetInvoice($id:EncodedId!){ invoice(id:$id){ ${invoiceFields} message contractDisclaimer lineItems(first:50){nodes{id name description quantity unitPrice totalPrice taxable}} notes(first:20){nodes{... on NoteInterface {${noteFields}}}} customFields { ... on CustomFieldText { valueText } } } }`,
  visit: `query GetVisit($id:EncodedId!){ visit(id:$id){ ${visitFields} lineItems(first:50){nodes{id name description quantity unitPrice totalPrice taxable}} } }`,
};

function addressToJobber(address: z.infer<typeof addressSchema>) {
  return { street1: address.street1, street2: address.street2, city: address.city, province: address.province, postalCode: address.postal_code, country: address.country };
}
function linesToQuote(lines: z.infer<typeof lineItemSchema>[]) {
  return lines.map((line) => ({ name: line.name, description: line.description, quantity: line.quantity, unitPrice: line.unit_price, taxable: line.taxable, productOrServiceId: line.product_or_service_id, saveToProductsAndServices: false }));
}
function linesToJob(lines: z.infer<typeof lineItemSchema>[]) {
  return lines.map((line) => ({ name: line.name, description: line.description, quantity: line.quantity, unitPrice: line.unit_price, taxable: line.taxable, productOrServiceId: line.product_or_service_id, saveToProductsAndServices: false }));
}
function linesToInvoice(lines: z.infer<typeof invoiceLineItemSchema>[]) {
  return lines.map((line) => ({ name: line.name, description: line.description, quantity: line.quantity, unitPrice: line.unit_price, taxable: line.taxable, productOrServiceId: line.product_or_service_id }));
}

/** Match a multiset, rather than array positions: Jobber may reorder lines. */
function verifyInvoiceLines(expected: z.infer<typeof invoiceLineItemSchema>[], invoice: Node) {
  const connection = invoice.lineItems;
  const complete = Array.isArray(connection?.nodes) && connection.pageInfo?.hasNextPage === false &&
    new Set(connection.nodes.map((line: Node) => line?.id)).size === connection.nodes.length;
  const remaining: Node[] = Array.isArray(connection?.nodes) ? [...connection.nodes] : [];
  const results = expected.map((line, index) => {
    const matchIndex = remaining.findIndex(saved =>
      saved && typeof saved.id === "string" && !!saved.id && saved.name === line.name &&
      (saved.description ?? "") === (line.description ?? "") &&
      saved.quantity === line.quantity && saved.unitPrice === line.unit_price &&
      typeof saved.totalPrice === "number" && Number.isFinite(saved.totalPrice) &&
      Math.abs(saved.totalPrice - line.quantity * line.unit_price) <= 0.0050001 &&
      (line.taxable === undefined || saved.taxable === line.taxable) &&
      (line.product_or_service_id === undefined || saved.linkedProductOrService?.id === line.product_or_service_id)
    );
    const saved = matchIndex < 0 ? undefined : remaining.splice(matchIndex, 1)[0];
    return { index, verification: saved ? "verified" : "mismatch", ...(saved ? { line_item_id: saved.id, quantity: saved.quantity, unit_price: saved.unitPrice, total_price: saved.totalPrice } : {}) };
  });
  return {
    verified: complete && remaining.length === 0 && results.every(result => result.verification === "verified"),
    complete, unexpected_line_count: remaining.length, results,
  };
}
function normalized(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}
function normalizedPhone(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}
function assertRelationship(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function visitWithSchedule(record: Node): Node {
  const mode = !record.startAt && !record.endAt ? "unscheduled" : record.allDay ? "anytime" : "timed";
  return {
    ...record,
    schedule: {
      mode,
      ...(mode !== "unscheduled" ? { start_at: record.startAt, end_at: record.endAt } : {}),
    },
  };
}
function recordWithSchedules(recordType: string, record: Node): Node {
  if (recordType === "visit") return visitWithSchedule(record);
  if (recordType === "job" && Array.isArray(record.visits?.nodes)) {
    return recordWithNoteVersions({ ...record, visits: { ...record.visits, nodes: record.visits.nodes.map(visitWithSchedule) } });
  }
  return recordWithNoteVersions(record);
}
function response(action: string, recordType: string, record: Node) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ action, record_type: recordType, record_version: recordVersion(recordType, record), record: recordWithSchedules(recordType, record) }) }] };
}
function recordVersion(recordType: string, record: Node): string {
  if (typeof record.updatedAt === "string" && record.updatedAt) return record.updatedAt;
  const versionView = recordType === "property"
    ? Object.fromEntries(["id", "name", "street1", "street2", "city", "province", "postalCode", "country"].map((key) => [key, record[key] ?? null]))
    : recordType === "visit"
      ? {
          id: record.id,
          title: record.title ?? null,
          visitStatus: record.visitStatus,
          isComplete: record.isComplete,
          completedAt: record.completedAt ?? null,
          allDay: record.allDay ?? null,
          startAt: record.startAt ?? null,
          endAt: record.endAt ?? null,
          instructions: record.instructions ?? null,
          jobId: record.job?.id,
          clientId: record.client?.id,
          assignedUserIds: (record.assignedUsers?.nodes ?? []).map((user: Node) => user.id).sort(),
        }
      : record;
  return `sha256:${createHash("sha256").update(JSON.stringify(versionView)).digest("hex")}`;
}
function encodePropertyCursor(clientAfter: string | undefined, propertyOffset: number): string {
  return Buffer.from(JSON.stringify({ clientAfter, propertyOffset }), "utf8").toString("base64url");
}
function decodePropertyCursor(cursor: string | undefined): { clientAfter?: string; propertyOffset: number } {
  if (!cursor) return { propertyOffset: 0 };
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if ((parsed.clientAfter !== undefined && typeof parsed.clientAfter !== "string") || !Number.isInteger(parsed.propertyOffset) || parsed.propertyOffset < 0) throw new Error();
    return parsed;
  } catch {
    throw new Error("Invalid property cursor; restart the property search without a cursor.");
  }
}
function mutationRecord(action: string, data: Node, payloadName: string, recordName: string): Node {
  const payload = assertMutationAccepted(action, data[payloadName] as MutationPayload) as Node;
  return assertPresent(action, payload[recordName]) as Node;
}
function singleCreatedRecord(action: string, records: unknown): Node {
  if (!Array.isArray(records) || records.length !== 1 || !records[0] || typeof records[0] !== "object") {
    throw new Error(`${action} returned an unexpected number of records; verify the Jobber record before retrying.`);
  }
  return records[0] as Node;
}
async function audit(tool: string, args: Record<string, unknown>, record?: Node) {
  const recordType = tool
    .replace(/^(create|update|mark|complete|set)_/, "")
    .replace(/^draft_/, "")
    .replace(/_status$/, "")
    .replace(/_sent$/, "");
  const sourceIds = Object.fromEntries(
    Object.entries(args).filter(([key]) => key.endsWith("_id"))
  );
  const changedFields = Object.keys(args)
    .filter((key) => !key.endsWith("_id") && !key.startsWith("expected_") && key !== "confirm_write")
    .sort();
  await appendAuditLog({
    tool,
    args: {
      action: tool,
      record_type: recordType,
      ...(record?.id ? { record_id: record.id } : {}),
      ...(Object.keys(sourceIds).length ? { source_record_ids: sourceIds } : {}),
      changed_fields: changedFields,
    },
    outcome: "success",
    result_count: 1,
  });
}

export function registerFoundationalTools(server: McpServer): void {
  registerReadOnlyTool(server, "search_records", {
    description: "Search a bounded Jobber record type using fixed reviewed queries. Use get_record before any write.",
    inputSchema: { record_type: recordTypeSchema, search_term: z.string().trim().max(250).optional(), page_size: pageSizeSchema(PAGE_CAP), cursor: cursorSchema(), returned_so_far: returnedSoFarSchema() },
    maxCost: READ_COST,
  }, async ({ record_type, search_term, page_size, cursor, returned_so_far = 0 }: any, run) => {
    if (record_type === "property") {
      const propertyCursor = decodePropertyCursor(cursor);
      const data = await run<Node>(SEARCHES.property, { term: search_term, after: propertyCursor.clientAfter });
      const connection = data.clients;
      const client = connection.nodes[0];
      const properties = (client?.properties ?? []).slice(propertyCursor.propertyOffset, propertyCursor.propertyOffset + page_size)
        .map((property: Node) => ({ ...property, client: { id: client.id, name: client.name } }));
      const nextOffset = propertyCursor.propertyOffset + properties.length;
      const hasMoreForClient = nextOffset < (client?.properties?.length ?? 0);
      const nextCursor = hasMoreForClient
        ? encodePropertyCursor(propertyCursor.clientAfter, nextOffset)
        : connection.pageInfo.hasNextPage
          ? encodePropertyCursor(connection.pageInfo.endCursor, 0)
          : undefined;
      const totalReturned = returned_so_far + properties.length;
      await appendAuditLog({ tool: "search_records", args: { record_type, search_term, page_size, cursor }, outcome: "success", result_count: properties.length });
      return { content: [{ type: "text", text: JSON.stringify({ record_type, returned_so_far: totalReturned, records: properties, ...(nextCursor ? { next_cursor: nextCursor } : {}) }) }] };
    }
    const data = await run<Node>(SEARCHES[record_type as z.infer<typeof recordTypeSchema>], { term: search_term, first: page_size, after: cursor });
    const connection = data[record_type === "client" ? "clients" : `${record_type}s`];
    const nodes = record_type === "visit" ? connection.nodes.map(visitWithSchedule) : connection.nodes;
    const progress = pageProgress(connection.totalCount, connection.nodes.length, returned_so_far);
    await appendAuditLog({ tool: "search_records", args: { record_type, search_term, page_size, cursor }, outcome: "success", result_count: nodes.length });
    return { content: [{ type: "text", text: JSON.stringify({ record_type, total_count: connection.totalCount, returned_so_far: progress.returned_so_far, records: nodes, ...(connection.pageInfo.hasNextPage ? { next_cursor: connection.pageInfo.endCursor, remaining: progress.remaining } : {}) }) }] };
  });

  registerReadOnlyTool(server, "get_record", {
    description: "Get one Jobber client, property, request, quote, job, invoice, or visit with the workflow fields needed to prepare a safe change.",
    inputSchema: { record_type: recordTypeSchema, record_id: z.string().trim().min(1) },
    maxCost: READ_COST,
  }, async ({ record_type, record_id }: any, run) => {
    const data = await run<Node>(GETS[record_type as z.infer<typeof recordTypeSchema>], { id: record_id });
    const record = assertPresent(`reading ${record_type}`, data[record_type]);
    await appendAuditLog({ tool: "get_record", args: { record_type, record_id }, outcome: "success", result_count: 1 });
    return response("read", record_type, record);
  });

  registerReadOnlyTool(server, "catalog_search", {
    description: "List a bounded page of Jobber products and services for selecting approved line items.",
    inputSchema: { page_size: pageSizeSchema(PAGE_CAP), cursor: cursorSchema(), returned_so_far: returnedSoFarSchema() },
    maxCost: READ_COST,
  }, async ({ page_size, cursor, returned_so_far = 0 }: any, run) => {
    const data = await run<Node>(`query Catalog($first:Int!,$after:String){ productOrServices(first:$first,after:$after){totalCount nodes{id name description category defaultUnitCost taxable visible} pageInfo{hasNextPage endCursor}}}`, { first: page_size, after: cursor });
    const progress = pageProgress(data.productOrServices.totalCount, data.productOrServices.nodes.length, returned_so_far);
    return { content: [{ type: "text", text: JSON.stringify({ total_count: data.productOrServices.totalCount, returned_so_far: progress.returned_so_far, products_and_services: data.productOrServices.nodes, ...(data.productOrServices.pageInfo.hasNextPage ? { next_cursor: data.productOrServices.pageInfo.endCursor, remaining: progress.remaining } : {}) }) }] };
  });

  registerReadOnlyTool(server, "team_list", {
    description: "List Jobber team members available for assignment.",
    inputSchema: { page_size: pageSizeSchema(PAGE_CAP), cursor: cursorSchema() },
    maxCost: READ_COST,
  }, async ({ page_size, cursor }: any, run) => {
    const data = await run<Node>(`query Team($first:Int!,$after:String){ users(first:$first,after:$after){totalCount nodes{id name{full} email{raw} availableForScheduling status} pageInfo{hasNextPage endCursor}}}`, { first: page_size, after: cursor });
    return { content: [{ type: "text", text: JSON.stringify({ total_count: data.users.totalCount, users: data.users.nodes, ...(data.users.pageInfo.hasNextPage ? { next_cursor: data.users.pageInfo.endCursor } : {}) }) }] };
  });

  if (!isReadOnly() && isWriteCapabilityEnabled("records")) registerRecordWrites(server);
  if (!isReadOnly() && isWriteCapabilityEnabled("scheduling")) registerSchedulingWrites(server);
  if (!isReadOnly() && isWriteCapabilityEnabled("communications")) registerCommunicationWrites(server);
}

function registerRecordWrites(server: McpServer): void {
  registerWriteTool(server, "create_client", { description: "Create a Jobber client after approval. Exact email or phone duplicates are refused by the server-side preflight.", capability: "records", inputSchema: { first_name: z.string().trim().min(1).max(100), last_name: z.string().trim().min(1).max(100), company_name: z.string().trim().max(200).optional(), emails: z.array(emailSchema).max(10).default([]), phones: z.array(phoneSchema).max(10).default([]), billing_address: addressSchema.optional(), confirm_write: confirmSchema }, maxCost: WRITE_COST }, async (args: any, run) => {
    const duplicate = await run<Node>(`query ClientDuplicate($term:String!){clients(searchTerm:$term,first:50){nodes{id name emails{address} phones{number}}}}`, { term: args.emails[0]?.address ?? args.phones[0]?.number ?? `${args.first_name} ${args.last_name}` });
    const wantedName = normalized(args.company_name || `${args.first_name} ${args.last_name}`);
    if (duplicate.clients.nodes.some((client: Node) => client.emails.some((email: Node) => args.emails.some((wanted: Node) => normalized(wanted.address) === normalized(email.address))) || client.phones.some((phone: Node) => args.phones.some((wanted: Node) => normalizedPhone(wanted.number) === normalizedPhone(phone.number))) || normalized(client.name) === wantedName)) throw new Error("Potential duplicate client found; use update_client or resolve the record in Jobber.");
    const data = await run<Node>(`mutation CreateClient($input:ClientCreateInput!){clientCreate(input:$input){client{${clientFields}} userErrors{message path}}}`, { input: { firstName: args.first_name, lastName: args.last_name, companyName: args.company_name, emails: args.emails.map((email: Node) => ({ address: email.address, primary: email.primary })), phones: args.phones.map((phone: Node) => ({ number: phone.number, primary: phone.primary })), ...(args.billing_address ? { billingAddress: addressToJobber(args.billing_address) } : {}) } });
    const client = mutationRecord("creating client", data, "clientCreate", "client"); await audit("create_client", args, client); return response("created", "client", client);
  });

  registerWriteTool(server, "update_client", { description: "Update a reviewed Jobber client. Provide the updated_at returned by get_record to prevent stale changes.", capability: "records", inputSchema: { client_id: z.string().min(1), expected_updated_at: z.string().min(1), first_name: z.string().trim().min(1).max(100).optional(), last_name: z.string().trim().min(1).max(100).optional(), company_name: z.string().trim().max(200).nullable().optional(), billing_address: addressSchema.optional(), confirm_write: confirmSchema }, maxCost: WRITE_COST }, async (args: any, run) => {
    const current = await run<Node>(`query ClientVersion($id:EncodedId!){client(id:$id){updatedAt}}`, { id: args.client_id }); if (current.client?.updatedAt !== args.expected_updated_at) throw new Error("Client changed since it was reviewed; fetch it again before updating.");
    if (args.first_name === undefined && args.last_name === undefined && args.company_name === undefined && args.billing_address === undefined) throw new Error("Provide at least one client field to update.");
    const input: Node = {}; for (const [from, to] of [["first_name", "firstName"], ["last_name", "lastName"], ["company_name", "companyName"]] as const) if (args[from] !== undefined) input[to] = args[from]; if (args.billing_address) input.billingAddress = addressToJobber(args.billing_address);
    const data = await run<Node>(`mutation EditClient($clientId:EncodedId!,$input:ClientEditInput!){clientEdit(clientId:$clientId,input:$input){client{${clientFields}} userErrors{message path}}}`, { clientId: args.client_id, input }); const client = mutationRecord("updating client", data, "clientEdit", "client"); await audit("update_client", args, client); return response("updated", "client", client);
  });

  registerWriteTool(server, "create_property", { description: "Create a service property for a known Jobber client.", capability: "records", inputSchema: { client_id: z.string().min(1), name: z.string().trim().max(200).optional(), address: addressSchema, confirm_write: confirmSchema }, maxCost: WRITE_COST }, async (args: any, run) => {
    const source = await run<Node>(`query PropertyPreflight($id:EncodedId!){client(id:$id){id properties{id name street1 street2 city province postalCode country}}}`, { id: args.client_id });
    assertRelationship(source.client, "Client not found; no property was created.");
    const wantedAddress = normalized([args.address.street1, args.address.street2, args.address.city, args.address.province, args.address.postal_code, args.address.country].join("|"));
    const duplicate = source.client.properties.some((property: Node) => {
      const address = normalized([property.street1, property.street2, property.city, property.province, property.postalCode, property.country].join("|"));
      return (args.name && normalized(property.name) === normalized(args.name)) || address === wantedAddress;
    });
    if (duplicate) throw new Error("A matching property already exists for this client; no property was created.");
    const data = await run<Node>(`mutation CreateProperty($clientId:EncodedId!,$input:PropertyCreateInput!){propertyCreate(clientId:$clientId,input:$input){properties{${propertyFields}} userErrors{message path}}}`, { clientId: args.client_id, input: { properties: [{ name: args.name, address: addressToJobber(args.address) }] } }); const properties = mutationRecord("creating property", data, "propertyCreate", "properties"); const property = singleCreatedRecord("creating property", properties); await audit("create_property", args, property); return response("created", "property", property);
  });

  registerWriteTool(server, "update_property", { description: "Update a known Jobber property after approval.", capability: "records", inputSchema: { property_id: z.string().min(1), expected_record_version: z.string().min(1), name: z.string().trim().max(200).optional(), address: addressSchema.optional(), confirm_write: confirmSchema }, maxCost: WRITE_COST }, async (args: any, run) => {
    const current = await run<Node>(`query PropertyCurrent($id:EncodedId!){property(id:$id){${propertyFields}}}`, { id: args.property_id }); if (!current.property || recordVersion("property", current.property) !== args.expected_record_version) throw new Error("Property changed since it was reviewed; fetch it again before updating."); if (args.name === undefined && args.address === undefined) throw new Error("Provide a name or address to update.");
    const data = await run<Node>(`mutation EditProperty($propertyId:EncodedId!,$input:PropertyEditInput!){propertyEdit(propertyId:$propertyId,input:$input){property{${propertyFields}} userErrors{message path}}}`, { propertyId: args.property_id, input: { ...(args.name !== undefined ? { name: args.name } : {}), ...(args.address ? { address: addressToJobber(args.address) } : {}) } }); const property = mutationRecord("updating property", data, "propertyEdit", "property"); await audit("update_property", args, property); return response("updated", "property", property);
  });

  registerWriteTool(server, "create_request", { description: "Create a Jobber work request for a known client and optional property.", capability: "records", inputSchema: { client_id: z.string().min(1), property_id: z.string().min(1).optional(), title: z.string().trim().max(250).optional(), salesperson_id: z.string().min(1).optional(), confirm_write: confirmSchema }, maxCost: WRITE_COST }, async (args: any, run) => {
    const source = await run<Node>(`query RequestPreflight($clientId:EncodedId!){client(id:$clientId){id properties{id} requests(first:50){nodes{id title requestStatus property{id}}}}}`, { clientId: args.client_id });
    assertRelationship(source.client, "Client not found; no request was created.");
    if (args.property_id) assertRelationship(source.client.properties.some((property: Node) => property.id === args.property_id), "Property does not belong to the selected client; no request was created.");
    if (args.title && source.client.requests.nodes.some((request: Node) => normalized(request.title) === normalized(args.title) && request.property?.id === args.property_id && normalized(request.requestStatus) !== "archived")) throw new Error("A matching active request already exists; no request was created.");
    const data = await run<Node>(`mutation CreateRequest($input:RequestCreateInput!){requestCreate(input:$input){request{${requestFields}} userErrors{message path}}}`, { input: { clientId: args.client_id, propertyId: args.property_id, title: args.title, salespersonId: args.salesperson_id } }); const request = mutationRecord("creating request", data, "requestCreate", "request"); await audit("create_request", args, request); return response("created", "request", request);
  });

  registerWriteTool(server, "update_request", { description: "Update a reviewed Jobber request.", capability: "records", inputSchema: { request_id: z.string().min(1), expected_updated_at: z.string().min(1), title: z.string().trim().max(250).optional(), property_id: z.string().min(1).optional(), salesperson_id: z.string().min(1).optional(), confirm_write: confirmSchema }, maxCost: WRITE_COST }, async (args: any, run) => {
    const current = await run<Node>(`query RequestVersion($id:EncodedId!){request(id:$id){updatedAt client{id}}}`, { id: args.request_id }); if (current.request?.updatedAt !== args.expected_updated_at) throw new Error("Request changed since it was reviewed; fetch it again before updating.");
    if (args.title === undefined && args.property_id === undefined && args.salesperson_id === undefined) throw new Error("Provide at least one request field to update.");
    if (args.property_id) { const property = await run<Node>(`query PropertyForRequest($id:EncodedId!){property(id:$id){id client{id}}}`, { id: args.property_id }); assertRelationship(property.property?.client?.id === current.request.client.id, "Property does not belong to the request's client; no request was updated."); }
    const data = await run<Node>(`mutation EditRequest($requestId:EncodedId!,$input:RequestEditInput!){requestEdit(requestId:$requestId,input:$input){request{${requestFields}} userErrors{message path}}}`, { requestId: args.request_id, input: { title: args.title, propertyId: args.property_id, salespersonId: args.salesperson_id } }); const request = mutationRecord("updating request", data, "requestEdit", "request"); await audit("update_request", args, request); return response("updated", "request", request);
  });

  registerQuoteJobInvoiceWrites(server);
}

function registerQuoteJobInvoiceWrites(server: McpServer): void {
  registerWriteTool(server, "create_draft_quote", { description: "Create a draft Jobber quote with explicit structured line items. It does not send the quote.", capability: "records", inputSchema: { client_id: z.string().min(1), property_id: z.string().min(1), request_id: z.string().min(1).optional(), title: z.string().trim().max(250).optional(), message: z.string().trim().max(10000).optional(), contract_disclaimer: z.string().trim().max(20000).optional(), line_items: z.array(lineItemSchema).min(1).max(100), confirm_write: confirmSchema }, maxCost: WRITE_COST }, async (args: any, run) => {
    const source = await run<Node>(`query QuotePreflight($clientId:EncodedId!){client(id:$clientId){id properties{id} quotes(first:50){nodes{id title quoteStatus property{id}}}}}`, { clientId: args.client_id });
    assertRelationship(source.client, "Client not found; no quote was created.");
    assertRelationship(source.client.properties.some((property: Node) => property.id === args.property_id), "Property does not belong to the selected client; no quote was created.");
    if (args.request_id) {
      const requestSource = await run<Node>(`query RequestForQuote($id:EncodedId!){request(id:$id){id client{id} property{id} requestStatus}}`, { id: args.request_id });
      assertRelationship(requestSource.request?.client?.id === args.client_id && requestSource.request?.property?.id === args.property_id, "Request, client, and property do not belong to the same workflow; no quote was created.");
      assertRelationship(normalized(requestSource.request.requestStatus) !== "archived", "The source request is archived; no quote was created.");
    }
    if (args.title && source.client.quotes.nodes.some((quote: Node) => normalized(quote.title) === normalized(args.title) && quote.property?.id === args.property_id && normalized(quote.quoteStatus) === "draft")) throw new Error("A matching draft quote already exists; no quote was created.");
    const data = await run<Node>(`mutation CreateQuote($attributes:QuoteCreateAttributes!){quoteCreate(attributes:$attributes){quote{${quoteFields}} userErrors{message path}}}`, { attributes: { clientId: args.client_id, propertyId: args.property_id, requestId: args.request_id, title: args.title, message: args.message, contractDisclaimer: args.contract_disclaimer, lineItems: linesToQuote(args.line_items) } }); const quote = mutationRecord("creating draft quote", data, "quoteCreate", "quote"); await audit("create_draft_quote", args, quote); return response("created", "quote", quote);
  });
  registerWriteTool(server, "update_draft_quote", { description: "Update header fields on a reviewed draft quote. Existing quote line items have their own reviewed IDs and are intentionally not bulk-replaced.", capability: "records", inputSchema: { quote_id: z.string().min(1), expected_updated_at: z.string().min(1), title: z.string().trim().max(250).optional(), message: z.string().trim().max(10000).optional(), contract_disclaimer: z.string().trim().max(20000).optional(), confirm_write: confirmSchema }, maxCost: WRITE_COST }, async (args: any, run) => {
    const current = await run<Node>(`query QuoteVersion($id:EncodedId!){quote(id:$id){updatedAt quoteStatus}}`, { id: args.quote_id }); if (current.quote?.updatedAt !== args.expected_updated_at) throw new Error("Quote changed since it was reviewed; fetch it again before updating."); if (String(current.quote.quoteStatus).toLowerCase() !== "draft") throw new Error("Only draft quotes can be edited by this tool.");
    if (args.title === undefined && args.message === undefined && args.contract_disclaimer === undefined) throw new Error("Provide at least one quote field to update.");
    const data = await run<Node>(`mutation EditQuote($quoteId:EncodedId!,$attributes:QuoteEditAttributes!){quoteEdit(quoteId:$quoteId,attributes:$attributes){quote{${quoteFields}} userErrors{message path}}}`, { quoteId: args.quote_id, attributes: { title: args.title, message: args.message, contractDisclaimer: args.contract_disclaimer } }); const quote = mutationRecord("updating draft quote", data, "quoteEdit", "quote"); await audit("update_draft_quote", args, quote); return response("updated", "quote", quote);
  });
  registerWriteTool(server, "create_job", { description: "Create a Jobber fixed-price or visit-based job from a property and optional request or quote.", capability: "records", inputSchema: { property_id: z.string().min(1), quote_id: z.string().min(1).optional(), request_id: z.string().min(1).optional(), title: z.string().trim().max(250).optional(), instructions: z.string().trim().max(10000).optional(), billing_type: z.enum(["FIXED_PRICE", "VISIT_BASED"]), billing_schedule: z.enum(["ON_COMPLETION", "PERIODIC", "PER_VISIT", "NEVER"]), line_items: z.array(lineItemSchema).max(100).default([]), confirm_write: confirmSchema }, maxCost: WRITE_COST }, async (args: any, run) => {
    if (args.quote_id && args.request_id) throw new Error("Choose either a source quote or source request, not both.");
    const source = await run<Node>(`query JobPreflight($propertyId:EncodedId!){property(id:$propertyId){id client{id} jobs(first:50){nodes{id title jobStatus}}}}`, { propertyId: args.property_id });
    assertRelationship(source.property, "Property not found; no job was created.");
    if (args.quote_id) {
      const quoteSource = await run<Node>(`query QuoteForJob($id:EncodedId!){quote(id:$id){id property{id} client{id} jobs(first:1){nodes{id}}}}`, { id: args.quote_id });
      assertRelationship(quoteSource.quote?.property?.id === args.property_id && quoteSource.quote?.client?.id === source.property.client.id, "Quote does not belong to the selected property and client; no job was created.");
      assertRelationship(quoteSource.quote.jobs.nodes.length === 0, "The source quote already has a job; no duplicate job was created.");
    }
    if (args.request_id) {
      const requestSource = await run<Node>(`query RequestForJob($id:EncodedId!){request(id:$id){id property{id} client{id} jobs(first:1){nodes{id}} requestStatus}}`, { id: args.request_id });
      assertRelationship(requestSource.request?.property?.id === args.property_id && requestSource.request?.client?.id === source.property.client.id, "Request does not belong to the selected property and client; no job was created.");
      assertRelationship(requestSource.request.jobs.nodes.length === 0 && normalized(requestSource.request.requestStatus) !== "archived", "The source request is archived or already has a job; no duplicate job was created.");
    }
    if (args.title && source.property.jobs.nodes.some((job: Node) => normalized(job.title) === normalized(args.title) && !["closed", "archived"].includes(normalized(job.jobStatus)))) throw new Error("A matching active job already exists at this property; no job was created.");
    const data = await run<Node>(`mutation CreateJob($input:JobCreateAttributes!){jobCreate(input:$input){job{${jobFields}} userErrors{message path}}}`, { input: { propertyId: args.property_id, quoteId: args.quote_id, requestId: args.request_id, title: args.title, instructions: args.instructions, lineItems: linesToJob(args.line_items), invoicing: { invoicingType: args.billing_type, invoicingSchedule: args.billing_schedule }, scheduling: { createVisits: false, notifyTeam: false } } }); const job = mutationRecord("creating job", data, "jobCreate", "job"); await audit("create_job", args, job); return response("created", "job", job);
  });
  registerJobLineItemDescriptions(server);
  registerWriteTool(server, "update_job", { description: "Update title or instructions on a reviewed Jobber job.", capability: "records", inputSchema: { job_id: z.string().min(1), expected_updated_at: z.string().min(1), title: z.string().trim().max(250).optional(), instructions: z.string().trim().max(10000).optional(), confirm_write: confirmSchema }, maxCost: WRITE_COST }, async (args: any, run) => {
    const current = await run<Node>(`query JobVersion($id:EncodedId!){job(id:$id){updatedAt}}`, { id: args.job_id }); if (current.job?.updatedAt !== args.expected_updated_at) throw new Error("Job changed since it was reviewed; fetch it again before updating."); if (args.title === undefined && args.instructions === undefined) throw new Error("Provide a title or instructions to update."); const data = await run<Node>(`mutation EditJob($jobId:EncodedId!,$input:JobEditInput!){jobEdit(jobId:$jobId,input:$input){job{${jobFields}} userErrors{message path}}}`, { jobId: args.job_id, input: { title: args.title, instructions: args.instructions } }); const job = mutationRecord("updating job", data, "jobEdit", "job"); await audit("update_job", args, job); return response("updated", "job", job);
  });
  registerWriteTool(server, "create_draft_invoice", {
    description: "Create and read back an unsent Jobber invoice with explicit line items. Use a negative quantity and nonnegative unit_price for a separate named discount (quantity -1, unit_price 150 deducts 150). Review every line and taxability. An existing invoice on the source job still requires manual reconciliation. Payments are never created or captured. Partial or uncertain results must be reconciled, never automatically retried.",
    capability: "records",
    redactAuditErrors: true,
    inputSchema: {
      client_id: z.string().min(1), property_id: z.string().min(1).optional(), job_id: z.string().min(1).optional(),
      subject: z.string().trim().max(250).optional(), message: z.string().trim().max(10000).optional(),
      due_date: z.string().datetime(), line_items: z.array(invoiceLineItemSchema).min(1).max(100), confirm_write: confirmSchema,
    },
    maxCost: READ_COST,
  }, async (args, run) => {
    if (args.property_id && args.job_id) throw new Error("A Jobber invoice can be sourced from a property or a job, not both.");
    const source = await run<Node>(`query InvoicePreflight($clientId:EncodedId!){client(id:$clientId){id properties{id} invoices(first:50){nodes{id subject invoiceStatus}}}}`, { clientId: args.client_id });
    assertRelationship(source.client, "Client not found; no invoice was created.");
    if (args.property_id) assertRelationship(source.client.properties.some((property: Node) => property.id === args.property_id), "Property does not belong to the selected client; no invoice was created.");
    if (args.job_id) {
      const jobSource = await run<Node>(`query JobForInvoice($id:EncodedId!){job(id:$id){id client{id} invoices(first:1){nodes{id}}}}`, { id: args.job_id });
      assertRelationship(jobSource.job?.client?.id === args.client_id, "Job does not belong to the selected client; no invoice was created.");
      assertRelationship(jobSource.job.invoices.nodes.length === 0, "The source job already has an invoice; no duplicate invoice was created.");
    }
    if (args.subject && source.client.invoices.nodes.some((invoice: Node) => normalized(invoice.subject) === normalized(args.subject) && normalized(invoice.invoiceStatus) === "draft")) throw new Error("A matching draft invoice already exists; no invoice was created.");
    let invoice: Node | undefined;
    let mutationError: string | undefined;
    let userErrors: unknown[] = [];
    try {
      const data = await run<Node>(`mutation CreateInvoice($input:InvoiceCreateInput!){invoiceCreate(input:$input){invoice{${invoiceFields}} userErrors{message path}}}`, {
        input: { clientId: args.client_id, propertyId: args.property_id, jobId: args.job_id, subject: args.subject, message: args.message, dueDetails: { dueDate: args.due_date }, tax: { taxCalculationMethod: "EXCLUSIVE" }, lineItems: linesToInvoice(args.line_items), markSent: false },
      });
      const payload = data.invoiceCreate;
      // Keep the returned ID even if Jobber reports errors alongside it.
      invoice = payload?.invoice;
      if (!payload || !Array.isArray(payload.userErrors)) mutationError = "Jobber returned an incomplete mutation response.";
      else userErrors = payload.userErrors;
      if (!invoice?.id && !userErrors.length) mutationError = "Jobber did not return an invoice ID.";
    } catch (error) {
      mutationError = error instanceof Error ? error.message : String(error);
    }
    let observed: Node | undefined;
    let verificationError: string | undefined;
    if (invoice?.id) {
      try {
        const data = await run<Node>(`query VerifyCreatedInvoice($id:EncodedId!){invoice(id:$id){${invoiceFields} message jobs(first:2){nodes{id} pageInfo{hasNextPage}} properties(first:2){nodes{id} pageInfo{hasNextPage}} lineItems(first:100){nodes{id name description quantity unitPrice totalPrice taxable linkedProductOrService{id}} pageInfo{hasNextPage}}}}`, { id: invoice.id });
        if (data.invoice?.id !== invoice.id) throw new Error("Created invoice could not be read back.");
        observed = data.invoice;
      } catch (error) {
        verificationError = error instanceof Error ? error.message : String(error);
      }
    }
    const lines = observed ? verifyInvoiceLines(args.line_items, observed) : undefined;
    const destinationVerified = !!observed && observed.client?.id === args.client_id &&
      observed.jobs?.pageInfo?.hasNextPage === false && Array.isArray(observed.jobs?.nodes) &&
      (args.job_id ? observed.jobs.nodes.length === 1 && observed.jobs.nodes[0]?.id === args.job_id : observed.jobs.nodes.length === 0) &&
      (!args.property_id || (observed.properties?.pageInfo?.hasNextPage === false && observed.properties.nodes?.length === 1 && observed.properties.nodes[0]?.id === args.property_id));
    const headerVerified = !!observed && observed.invoiceStatus === "draft" &&
      (args.subject === undefined || observed.subject === args.subject) &&
      (args.message === undefined || observed.message === args.message);
    const verified = !!lines?.verified && destinationVerified && headerVerified;
    const successful = verified && !mutationError && !userErrors.length;
    const outcome = successful ? "created" : !invoice?.id && !mutationError && userErrors.length ? "rejected" : "partial_or_uncertain";
    await appendAuditLog({ tool: "create_draft_invoice", args: {
      ...args, invoice_id: invoice?.id,
    }, outcome: successful ? "success" : "error", ...(successful ? {} : { error_message: "Invoice creation requires reconciliation; no mutation retry performed." }) });
    const record = observed ?? invoice;
    return { content: [{ type: "text" as const, text: JSON.stringify({
      action: successful ? "created" : "create_invoice", record_type: "invoice", outcome, verification: verified ? "verified" : "unverified",
      ...(record ? { record, record_version: record.updatedAt } : {}),
      ...(invoice?.id ? { invoice_id: invoice.id } : {}),
      destination_verified: destinationVerified, header_verified: headerVerified,
      ...(lines ? { line_items_complete: lines.complete, unexpected_line_count: lines.unexpected_line_count, results: lines.results } : {}),
      ...(mutationError ? { mutation_error: mutationError } : {}), ...(userErrors.length ? { user_errors: userErrors } : {}),
      ...(verificationError ? { verification_error: verificationError } : {}),
      ...(!successful ? { guidance: "The mutation was not retried. Read the returned invoice ID, or search this client's invoices if no ID was returned, and reconcile before proposing a newly approved write." } : {}),
    }) }], ...(!successful ? { isError: true } : {}) };
  });
  registerWriteTool(server, "update_draft_invoice", { description: "Update header fields on a reviewed unsent invoice. Jobber does not expose invoice line-item editing in this API version.", capability: "records", inputSchema: { invoice_id: z.string().min(1), expected_updated_at: z.string().min(1), subject: z.string().trim().max(250).optional(), message: z.string().trim().max(10000).optional(), due_date: z.string().datetime().optional(), confirm_write: confirmSchema }, maxCost: WRITE_COST }, async (args: any, run) => {
    const current = await run<Node>(`query InvoiceVersion($id:EncodedId!){invoice(id:$id){updatedAt invoiceStatus}}`, { id: args.invoice_id }); if (current.invoice?.updatedAt !== args.expected_updated_at) throw new Error("Invoice changed since it was reviewed; fetch it again before updating."); if (String(current.invoice.invoiceStatus).toLowerCase() !== "draft") throw new Error("Only draft invoices can be edited by this tool."); if (args.subject === undefined && args.message === undefined && args.due_date === undefined) throw new Error("Provide at least one invoice field to update."); const data = await run<Node>(`mutation EditInvoice($invoiceId:EncodedId!,$input:InvoiceEditInput!){invoiceEdit(invoiceId:$invoiceId,input:$input){invoice{${invoiceFields}} userErrors{message path}}}`, { invoiceId: args.invoice_id, input: { subject: args.subject, message: args.message, ...(args.due_date ? { dueDetails: { dueDate: args.due_date } } : {}) } }); const invoice = mutationRecord("updating draft invoice", data, "invoiceEdit", "invoice"); await audit("update_draft_invoice", args, invoice); return response("updated", "invoice", invoice);
  });
}

type NormalizedVisitSchedule =
  | { mode: "unscheduled" }
  | { mode: "anytime"; startAt: { date: string; timezone: string }; endAt: { date: string; timezone: string } }
  | { mode: "timed"; startAt: { date: string; time: string; timezone: string }; endAt: { date: string; time: string; timezone: string }; startInstant: number; endInstant: number };

const timezoneFormatters = new Map<string, Intl.DateTimeFormat>();
function timezoneFormatter(timezone: string): Intl.DateTimeFormat {
  let formatter = timezoneFormatters.get(timezone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat("en-CA", {
        timeZone: timezone,
        calendar: "gregory",
        numberingSystem: "latn",
        hourCycle: "h23",
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
      });
    } catch {
      throw new Error(`Unknown timezone "${timezone}". Use an IANA timezone such as America/Toronto.`);
    }
    timezoneFormatters.set(timezone, formatter);
  }
  return formatter;
}

function localInstant(date: string, time: string, timezone: string, label: string): number {
  const [year, month, day] = date.split("-").map(Number);
  const parts = time.split(":").map(Number);
  const [hour, minute, second = 0] = parts;
  if (hour > 23 || minute > 59 || second > 59) throw new Error(`${label} has an invalid clock time.`);
  const formatter = timezoneFormatter(timezone);
  const localUtc = Date.UTC(year, month - 1, day, hour, minute, second);
  const matches: number[] = [];
  for (let offsetMinutes = -14 * 60; offsetMinutes <= 14 * 60; offsetMinutes += 15) {
    const candidate = localUtc - offsetMinutes * 60_000;
    const shown = Object.fromEntries(formatter.formatToParts(candidate).map((part) => [part.type, part.value]));
    if (Number(shown.year) === year && Number(shown.month) === month && Number(shown.day) === day
      && Number(shown.hour) === hour && Number(shown.minute) === minute && Number(shown.second) === second) matches.push(candidate);
  }
  const unique = [...new Set(matches)];
  if (!unique.length) throw new Error(`${label} does not exist in ${timezone} because of a daylight-saving time change.`);
  if (unique.length > 1) throw new Error(`${label} is ambiguous in ${timezone} because of a daylight-saving time change; choose a different time.`);
  return unique[0];
}

function calendarDateInTimezone(value: unknown, timezone: string): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const instant = Date.parse(value);
  if (!Number.isFinite(instant)) return undefined;
  const shown = Object.fromEntries(
    timezoneFormatter(timezone).formatToParts(instant).map((part) => [part.type, part.value])
  );
  return `${shown.year}-${shown.month}-${shown.day}`;
}

function normalizeVisitSchedule(args: any): NormalizedVisitSchedule {
  if (args.schedule !== undefined && (args.start_at !== undefined || args.end_at !== undefined)) {
    throw new Error("Use schedule or the legacy start_at/end_at fields, not both.");
  }
  if (args.schedule?.mode === "unscheduled" || (args.schedule === undefined && args.start_at === undefined && args.end_at === undefined)) {
    return { mode: "unscheduled" };
  }
  if (args.schedule?.mode === "anytime") {
    const startDate = args.schedule.start_date;
    const endDate = args.schedule.end_date ?? startDate;
    const tz = args.schedule.timezone ?? "America/Toronto";
    timezoneFormatter(tz);
    if (endDate < startDate) throw new Error("Anytime visit end_date must be on or after start_date.");
    return { mode: "anytime", startAt: { date: startDate, timezone: tz }, endAt: { date: endDate, timezone: tz } };
  }
  if (args.schedule?.mode === "timed") {
    const value = { ...args.schedule, timezone: args.schedule.timezone ?? "America/Toronto" };
    const startInstant = localInstant(value.start_date, value.start_time, value.timezone, "Visit start time");
    const endInstant = localInstant(value.end_date, value.end_time, value.timezone, "Visit end time");
    if (endInstant <= startInstant) throw new Error("Timed visit end must be after its start.");
    return { mode: "timed", startAt: { date: value.start_date, time: value.start_time, timezone: value.timezone }, endAt: { date: value.end_date, time: value.end_time, timezone: value.timezone }, startInstant, endInstant };
  }
  if ((args.start_at === undefined) !== (args.end_at === undefined)) throw new Error("Legacy start_at and end_at must be supplied together.");
  if (args.start_at.time === undefined && args.end_at.time === undefined) {
    const startTimezone = args.start_at.timezone ?? "America/Toronto";
    const endTimezone = args.end_at.timezone ?? "America/Toronto";
    if (startTimezone !== endTimezone) throw new Error("Legacy Anytime start and end must use the same timezone.");
    timezoneFormatter(startTimezone);
    if (args.end_at.date < args.start_at.date) throw new Error("Anytime visit end date must be on or after its start date.");
    return { mode: "anytime", startAt: { date: args.start_at.date, timezone: startTimezone }, endAt: { date: args.end_at.date, timezone: endTimezone } };
  }
  if (args.start_at.time === undefined || args.end_at.time === undefined) throw new Error("Legacy timed visits require a time on both start_at and end_at.");
  const startTimezone = args.start_at.timezone ?? "America/Toronto";
  const endTimezone = args.end_at.timezone ?? "America/Toronto";
  if (startTimezone !== endTimezone) throw new Error("Legacy timed start and end must use the same timezone.");
  const startInstant = localInstant(args.start_at.date, args.start_at.time, startTimezone, "Visit start time");
  const endInstant = localInstant(args.end_at.date, args.end_at.time, endTimezone, "Visit end time");
  if (endInstant <= startInstant) throw new Error("Timed visit end must be after its start.");
  return { mode: "timed", startAt: { ...args.start_at, timezone: startTimezone }, endAt: { ...args.end_at, timezone: endTimezone }, startInstant, endInstant };
}

function jobberSchedule(schedule: NormalizedVisitSchedule, assignedUserIds: string[]): Node | undefined {
  const assignment = { teamMemberIdsToAssign: assignedUserIds, notifyTeam: false };
  if (schedule.mode === "unscheduled") return assignedUserIds.length ? assignment : undefined;
  return { startAt: schedule.startAt, endAt: schedule.endAt, ...assignment };
}

function visitMatchesSchedule(visit: Node, schedule: NormalizedVisitSchedule, title?: string): boolean {
  if (schedule.mode === "unscheduled") {
    return !visit.startAt && !visit.endAt && (!title || normalized(visit.title) === normalized(title));
  }
  if (!visit.startAt || !visit.endAt) return false;
  if (schedule.mode === "anytime") {
    return visit.allDay === true
      && calendarDateInTimezone(visit.startAt, schedule.startAt.timezone) === schedule.startAt.date
      && calendarDateInTimezone(visit.endAt, schedule.endAt.timezone) === schedule.endAt.date;
  }
  return visit.allDay !== true && Date.parse(visit.startAt) === schedule.startInstant && Date.parse(visit.endAt) === schedule.endInstant;
}

function visitSpecKey(item: any): string {
  const schedule = item.normalizedSchedule as NormalizedVisitSchedule;
  if (schedule.mode === "unscheduled") return `unscheduled:${normalized(item.title)}`;
  if (schedule.mode === "anytime") return `anytime:${schedule.startAt.date}:${schedule.endAt.date}:${schedule.startAt.timezone}`;
  return `timed:${schedule.startInstant}:${schedule.endInstant}`;
}

function rejectRepeatedVisitSpecs(items: any[]): void {
  const seen = new Set<string>();
  for (const item of items) {
    const key = visitSpecKey(item);
    if (seen.has(key)) throw new Error("The request contains repeated visit schedules; no visits were created.");
    seen.add(key);
  }
}

async function loadVisitPreflight(jobId: string, run: any): Promise<{ job: Node | null; visits: Node[] }> {
  let cursor: string | undefined;
  let job: Node | null = null;
  const visits: Node[] = [];
  for (let page = 0; page < 200; page++) {
    const data = await run(`query VisitPreflight($id:EncodedId!,$after:String){job(id:$id){id jobStatus visits(first:50,after:$after){nodes{${visitFields}} pageInfo{hasNextPage endCursor}}}}`, { id: jobId, after: cursor });
    if (!data.job) return { job: null, visits: [] };
    job = data.job;
    visits.push(...data.job.visits.nodes);
    if (!data.job.visits.pageInfo.hasNextPage) return { job, visits };
    cursor = data.job.visits.pageInfo.endCursor;
    if (!cursor) throw new Error("Jobber did not provide a cursor while listing existing visits; no write was attempted.");
  }
  throw new Error("The job has too many visits to safely complete duplicate checking; no write was attempted.");
}

async function assertSchedulableUsers(requestedIds: string[], run: any): Promise<void> {
  let cursor: string | undefined;
  let complete = false;
  const users = new Map<string, Node>();
  for (let page = 0; page < 200; page++) {
    const data = await run(`query SchedulableUsers($after:String){users(first:50,after:$after){nodes{id availableForScheduling status} pageInfo{hasNextPage endCursor}}}`, { after: cursor });
    for (const user of data.users.nodes) users.set(user.id, user);
    if (!data.users.pageInfo.hasNextPage) {
      complete = true;
      break;
    }
    cursor = data.users.pageInfo.endCursor;
    if (!cursor) throw new Error("Jobber did not provide a cursor while validating team members; no write was attempted.");
  }
  if (!complete) throw new Error("The account has too many team members to safely validate assignments; no write was attempted.");
  const invalid = requestedIds.filter((id) => {
    const user = users.get(id);
    return !user || user.availableForScheduling !== true || normalized(user.status) !== "activated";
  });
  if (invalid.length) throw new Error(`These team member IDs are missing or unavailable for scheduling: ${invalid.join(", ")}. No write was attempted.`);
}

function sameIds(actual: string[], expected: string[]): boolean {
  return JSON.stringify([...new Set(actual)].sort()) === JSON.stringify([...new Set(expected)].sort());
}

function errorInputIndex(error: Node): number | undefined {
  for (const part of error.path ?? []) if (/^\d+$/.test(String(part))) return Number(part);
}

function matchVisitResults(prepared: any[], created: Node[], errors: Node[]): { results: any[]; unmatchedCreated: Node[] } {
  const remaining = [...created];
  const results = prepared.map((item, inputIndex) => {
    const createdIndex = remaining.findIndex((visit) => visitMatchesSchedule(visit, item.normalizedSchedule, item.title));
    if (createdIndex >= 0) {
      const [record] = remaining.splice(createdIndex, 1);
      return { input_index: inputIndex, status: "created", verification: "pending", record: visitWithSchedule(record) };
    }
    const itemErrors = errors.filter((error) => errorInputIndex(error) === inputIndex);
    return itemErrors.length
      ? { input_index: inputIndex, status: "rejected", errors: itemErrors }
      : { input_index: inputIndex, status: "uncertain", errors };
  });
  return { results, unmatchedCreated: remaining.map(visitWithSchedule) };
}

function toolResult(payload: Node, isError = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], ...(isError ? { isError: true } : {}) };
}

async function auditVisitBatch(
  tool: string,
  jobId: string,
  specs: any[],
  created: Node[],
  outcome: "success" | "partial" | "error",
  errorMessage?: string
): Promise<void> {
  await appendAuditLog({
    tool,
    args: { action: tool, record_type: "visit", source_record_ids: { job_id: jobId }, requested_count: specs.length, created_record_ids: created.map((visit) => visit.id) },
    outcome,
    ...(errorMessage ? { error_message: errorMessage } : {}),
    result_count: created.length,
  });
}

function visitUpdateMatches(record: Node, args: any, schedule?: NormalizedVisitSchedule): boolean {
  if (args.title !== undefined && record.title !== args.title) return false;
  if (args.instructions !== undefined && record.instructions !== args.instructions) return false;
  if (schedule !== undefined && !visitMatchesSchedule(record, schedule)) return false;
  if (args.assigned_user_ids !== undefined) {
    const actual = record.assignedUsers?.nodes?.map((user: Node) => user.id) ?? [];
    if (!sameIds(actual, args.assigned_user_ids)) return false;
  }
  return true;
}

async function auditVisitUpdateConcern(args: any, record: Node | undefined, message: string): Promise<void> {
  await appendAuditLog({
    tool: "update_visit",
    args: {
      action: "update_visit",
      record_type: "visit",
      ...(record?.id ? { record_id: record.id } : {}),
      source_record_ids: { visit_id: args.visit_id },
    },
    outcome: "partial",
    error_message: message,
    result_count: record?.id ? 1 : 0,
  });
}

function registerSchedulingWrites(server: McpServer): void {
  const timezone = z.string().trim().min(1).default("America/Toronto");
  const localTime = z.object({ date: z.string().date(), time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(), timezone });
  const schedule = z.discriminatedUnion("mode", [
    z.object({ mode: z.literal("anytime"), start_date: z.string().date(), end_date: z.string().date().optional(), timezone }),
    z.object({ mode: z.literal("timed"), start_date: z.string().date(), start_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/), end_date: z.string().date(), end_time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/), timezone }),
    z.object({ mode: z.literal("unscheduled") }),
  ]).describe("Use anytime for a date without a time, timed for exact times, or unscheduled for no date.");
  const visitSpec = z.object({
    title: z.string().trim().max(250).optional(),
    instructions: z.string().trim().max(10000).optional(),
    schedule: schedule.optional(),
    start_at: localTime.optional().describe("Legacy schedule input; prefer schedule."),
    end_at: localTime.optional().describe("Legacy schedule input; prefer schedule."),
    assigned_user_ids: z.array(z.string().min(1)).max(20).default([]),
  }).superRefine((value, ctx) => {
    if (value.schedule === undefined && value.start_at === undefined && value.end_at === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["schedule"],
        message: "Choose an explicit schedule mode, including mode=unscheduled when no date is wanted.",
      });
    }
  });

  const createOne = async (tool: string, jobId: string, specs: any[], run: any) => {
    for (const spec of specs) {
      if (spec.schedule === undefined && spec.start_at === undefined && spec.end_at === undefined) {
        throw new Error("Choose an explicit schedule mode, including mode=unscheduled when no date is wanted.");
      }
    }
    const prepared = specs.map((spec) => ({ ...spec, normalizedSchedule: normalizeVisitSchedule(spec) }));
    for (const item of prepared) {
      if (new Set(item.assigned_user_ids).size !== item.assigned_user_ids.length) throw new Error("A visit contains a repeated assigned_user_id; no visits were created.");
    }
    rejectRepeatedVisitSpecs(prepared);
    const before = await loadVisitPreflight(jobId, run);
    assertRelationship(before.job, "Job not found; no visit was created.");
    assertRelationship(!["closed", "archived"].includes(normalized(before.job.jobStatus)), "The job is closed; no visit was created.");
    const requestedUsers = [...new Set(prepared.flatMap((item) => item.assigned_user_ids))];
    if (requestedUsers.length) await assertSchedulableUsers(requestedUsers, run);
    for (const item of prepared) {
      if (before.visits.some((visit: Node) => visitMatchesSchedule(visit, item.normalizedSchedule, item.title))) {
        throw new Error(`A matching ${item.normalizedSchedule.mode} visit already exists on this job; no visits were created.`);
      }
    }

    let data: Node;
    try {
      data = await run(`mutation CreateVisits($jobId:EncodedId!,$input:VisitCreateInput!){visitCreate(jobId:$jobId,input:$input){createdVisits{${visitFields}} userErrors{message path}}}`, {
        jobId,
        input: { visits: prepared.map((item) => ({ title: item.title, instructions: item.instructions, schedule: jobberSchedule(item.normalizedSchedule, item.assigned_user_ids) })) },
      });
    } catch (error: any) {
      if (error?.name !== "JobberOutcomeUncertainError") throw error;
      await auditVisitBatch(tool, jobId, specs, [], "error", "mutation outcome uncertain; reconciliation required");
      return toolResult({ action: "create", record_type: "visit", outcome: "uncertain", error: error.message, guidance: "The write was not retried. Re-read the job and check Jobber before requesting another write." }, true);
    }

    const payload = data.visitCreate;
    if (!payload || !Array.isArray(payload.createdVisits) || !Array.isArray(payload.userErrors)) {
      await auditVisitBatch(tool, jobId, specs, [], "error", "incomplete mutation response; reconciliation required");
      return toolResult({ action: "create", record_type: "visit", outcome: "uncertain", error: "Jobber returned an incomplete visit creation result.", guidance: "Re-read the job and check Jobber before requesting another write." }, true);
    }
    const created = payload.createdVisits as Node[];
    const { results, unmatchedCreated } = matchVisitResults(prepared, created, payload.userErrors);
    let verificationError: string | undefined;
    try {
      const after = await loadVisitPreflight(jobId, run);
      const byId = new Map(after.visits.map((visit: Node) => [visit.id, visit]));
      for (const result of results) {
        if (result.status !== "created" || !result.record?.id) continue;
        const readback = byId.get(result.record.id);
        result.verification = readback && visitMatchesSchedule(readback, prepared[result.input_index].normalizedSchedule, prepared[result.input_index].title)
          && sameIds(readback.assignedUsers?.nodes?.map((user: Node) => user.id) ?? [], prepared[result.input_index].assigned_user_ids)
          ? "verified"
          : "mismatch";
        if (readback) result.record = visitWithSchedule(readback);
      }
    } catch (error: any) {
      verificationError = error instanceof Error ? error.message : String(error);
      for (const result of results) {
        if (result.status !== "created") continue;
        result.verification = "uncertain";
        result.verification_error = verificationError;
      }
    }
    const complete = payload.userErrors.length === 0
      && unmatchedCreated.length === 0
      && results.every((result) => result.status === "created" && result.verification === "verified");
    const auditOutcome = complete ? "success" : created.length ? "partial" : "error";
    const issueSummary = complete
      ? undefined
      : `created=${created.length}, user_errors=${payload.userErrors.length}, unmatched_created=${unmatchedCreated.length}${verificationError ? ", verification_failed=true" : ""}`;
    await auditVisitBatch(tool, jobId, specs, created, auditOutcome, issueSummary);
    return toolResult({
      action: "create",
      record_type: "visit",
      outcome: complete ? "created" : "partial",
      job_id: jobId,
      results,
      user_errors: payload.userErrors,
      ...(unmatchedCreated.length ? { unmatched_created_records: unmatchedCreated } : {}),
      ...(verificationError ? { verification_error: verificationError } : {}),
    }, !complete);
  };

  registerWriteTool(server, "create_visit", { description: "Create one Jobber visit. Use schedule.mode=anytime for a date with no time, timed for exact times, or unscheduled for no date.", capability: "scheduling", inputSchema: { job_id: z.string().min(1), title: z.string().trim().max(250).optional(), instructions: z.string().trim().max(10000).optional(), schedule: schedule.optional(), start_at: localTime.optional(), end_at: localTime.optional(), assigned_user_ids: z.array(z.string().min(1)).max(20).default([]), confirm_write: confirmSchema }, maxCost: WRITE_COST }, async (args: any, run) => createOne("create_visit", args.job_id, [args], run));
  registerWriteTool(server, "create_visits", { description: "Create 1-20 reviewed Jobber visits for one job in one mutation. Prefer this for multiple dates; each visit may be anytime, timed, or unscheduled.", capability: "scheduling", inputSchema: { job_id: z.string().min(1), visits: z.array(visitSpec).min(1).max(20), confirm_write: confirmSchema }, maxCost: WRITE_COST }, async (args: any, run) => createOne("create_visits", args.job_id, args.visits, run));
  registerWriteTool(server, "update_visit", { description: "Update one aspect of a reviewed Jobber visit: details, schedule, or assignments. schedule.mode supports anytime, timed, and unscheduled.", capability: "scheduling", inputSchema: { visit_id: z.string().min(1), expected_record_version: z.string().min(1), title: z.string().trim().max(250).optional(), instructions: z.string().trim().max(10000).optional(), schedule: schedule.optional(), start_at: localTime.optional(), end_at: localTime.optional(), assigned_user_ids: z.array(z.string().min(1)).max(20).optional(), confirm_write: confirmSchema }, maxCost: WRITE_COST }, async (args: any, run) => {
    const hasSchedule = args.schedule !== undefined || args.start_at !== undefined || args.end_at !== undefined;
    const normalizedSchedule = hasSchedule ? normalizeVisitSchedule(args) : undefined;
    const changes = [args.title !== undefined || args.instructions !== undefined, hasSchedule, args.assigned_user_ids !== undefined].filter(Boolean).length;
    if (changes !== 1) throw new Error("Update exactly one visit aspect per call: details, schedule, or assignments.");

    const current = await run<Node>(`query VisitVersion($id:EncodedId!){visit(id:$id){${visitFields}}}`, { id: args.visit_id });
    if (!current.visit || recordVersion("visit", current.visit) !== args.expected_record_version) throw new Error("Visit changed since it was reviewed; fetch it again before updating.");

    let mutationVisit: Node;
    if (args.title !== undefined || args.instructions !== undefined) {
      const data = await run<Node>(`mutation EditVisit($id:EncodedId!,$attributes:VisitEditAttributes!){visitEdit(id:$id,attributes:$attributes){visit{${visitFields}} userErrors{message path}}}`, { id: args.visit_id, attributes: { title: args.title, instructions: args.instructions } });
      mutationVisit = mutationRecord("updating visit", data, "visitEdit", "visit");
    } else if (normalizedSchedule) {
      const data = await run<Node>(`mutation ScheduleVisit($id:EncodedId!,$input:VisitEditScheduleInput!){visitEditSchedule(id:$id,input:$input){visit{${visitFields}} userErrors{message path}}}`, { id: args.visit_id, input: normalizedSchedule.mode === "unscheduled" ? { startAt: null, endAt: null } : { startAt: normalizedSchedule.startAt, endAt: normalizedSchedule.endAt } });
      mutationVisit = mutationRecord("scheduling visit", data, "visitEditSchedule", "visit");
    } else {
      if (new Set(args.assigned_user_ids).size !== args.assigned_user_ids.length) throw new Error("assigned_user_ids contains a repeated team member ID.");
      if (args.assigned_user_ids.length) await assertSchedulableUsers(args.assigned_user_ids, run);
      const data = await run<Node>(`mutation AssignVisit($visitId:EncodedId!,$input:VisitEditAssignedUsersInput!){visitEditAssignedUsers(visitId:$visitId,input:$input){visit{${visitFields}} userErrors{message path}}}`, { visitId: args.visit_id, input: { assignedUserIds: args.assigned_user_ids } });
      mutationVisit = mutationRecord("assigning visit", data, "visitEditAssignedUsers", "visit");
    }

    let readback: Node;
    try {
      const verification = await run<Node>(`query VerifyVisitUpdate($id:EncodedId!){visit(id:$id){${visitFields}}}`, { id: args.visit_id });
      readback = verification.visit;
    } catch (error: any) {
      const message = error instanceof Error ? error.message : String(error);
      await auditVisitUpdateConcern(args, mutationVisit, "verification read failed after mutation");
      return toolResult({ action: "update", record_type: "visit", outcome: "uncertain", record: visitWithSchedule(mutationVisit), verification_error: message, guidance: "The write was not retried. Re-read the visit in Jobber before requesting another update." }, true);
    }

    if (!readback || !visitUpdateMatches(readback, args, normalizedSchedule)) {
      await auditVisitUpdateConcern(args, readback ?? mutationVisit, "updated visit did not match the approved request during readback");
      return toolResult({ action: "update", record_type: "visit", outcome: "mismatch", record: visitWithSchedule(readback ?? mutationVisit), guidance: "Review the visit in Jobber. Do not retry this update until the current record has been read again." }, true);
    }

    await audit("update_visit", args, readback);
    return response("updated", "visit", readback);
  });
  registerWriteTool(server, "complete_visit", { description: "Mark a reviewed Jobber visit complete. This is an operationally consequential action.", capability: "scheduling", inputSchema: { visit_id: z.string().min(1), expected_record_version: z.string().min(1), completed_at: z.string().datetime().optional(), confirm_write: confirmSchema }, maxCost: WRITE_COST }, async (args: any, run) => {
    const current = await run<Node>(`query VisitVersion($id:EncodedId!){visit(id:$id){${visitFields}}}`, { id: args.visit_id }); if (!current.visit || recordVersion("visit", current.visit) !== args.expected_record_version) throw new Error("Visit changed since it was reviewed; fetch it again before completing."); if (current.visit.isComplete) throw new Error("Visit is already complete."); const data = await run<Node>(`mutation CompleteVisit($visitId:EncodedId!,$input:VisitCompleteInput!){visitComplete(visitId:$visitId,input:$input){visit{${visitFields}} userErrors{message path}}}`, { visitId: args.visit_id, input: { completedAt: args.completed_at } }); const visit = mutationRecord("completing visit", data, "visitComplete", "visit"); await audit("complete_visit", args, visit); return response("completed", "visit", visit);
  });
}

function registerCommunicationWrites(server: McpServer): void {
  registerWriteTool(server, "mark_quote_sent", { description: "Record that a reviewed quote was sent outside this connector. This changes Jobber status only and sends no email.", capability: "communications", inputSchema: { quote_id: z.string().min(1), expected_updated_at: z.string().min(1), confirm_write: confirmSchema }, maxCost: WRITE_COST }, async (args: any, run) => {
    const current = await run<Node>(`query QuoteVersion($id:EncodedId!){quote(id:$id){updatedAt quoteStatus}}`, { id: args.quote_id }); if (current.quote?.updatedAt !== args.expected_updated_at) throw new Error("Quote changed since it was reviewed; fetch it again before changing status."); if (String(current.quote.quoteStatus).toLowerCase() !== "draft") throw new Error("Only draft quotes can be marked sent by this tool.");
    const data = await run<Node>(`mutation MarkQuoteSent($quoteId:EncodedId!,$attributes:QuoteEditAttributes!){quoteEdit(quoteId:$quoteId,attributes:$attributes){quote{${quoteFields}} userErrors{message path}}}`, { quoteId: args.quote_id, attributes: { sentAt: new Date().toISOString() } }); const quote = mutationRecord("marking quote sent", data, "quoteEdit", "quote"); await audit("mark_quote_sent", args, quote); return response("marked_sent", "quote", quote);
  });
  registerWriteTool(server, "mark_invoice_sent", { description: "Record that a reviewed invoice was sent outside this connector. This changes Jobber status only and sends no email.", capability: "communications", inputSchema: { invoice_id: z.string().min(1), expected_updated_at: z.string().min(1), confirm_write: confirmSchema }, maxCost: WRITE_COST }, async (args: any, run) => {
    const current = await run<Node>(`query InvoiceVersion($id:EncodedId!){invoice(id:$id){updatedAt invoiceStatus}}`, { id: args.invoice_id }); if (current.invoice?.updatedAt !== args.expected_updated_at) throw new Error("Invoice changed since it was reviewed; fetch it again before changing status."); if (String(current.invoice.invoiceStatus).toLowerCase() !== "draft") throw new Error("Only draft invoices can be marked sent by this tool."); const data = await run<Node>(`mutation MarkInvoiceSent($id:EncodedId!){invoiceMarkAsSent(id:$id){invoice{${invoiceFields}} userErrors{message path}}}`, { id: args.invoice_id }); const invoice = mutationRecord("marking invoice sent", data, "invoiceMarkAsSent", "invoice"); await audit("mark_invoice_sent", args, invoice); return response("marked_sent", "invoice", invoice);
  });
}
