import { z } from "zod";
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
const confirmSchema = z.literal(true).describe("Must be true after reviewing the proposed external change");

type Node = Record<string, any>;

const summaryFields = `id updatedAt jobberWebUri`;
const clientFields = `${summaryFields} name firstName lastName companyName email phone billingAddress { street1 street2 city province postalCode country }`;
const propertyFields = `id name street1 street2 city province postalCode country jobberWebUri`;
const requestFields = `${summaryFields} title requestStatus createdAt client { id name } property { id name }`;
const quoteFields = `${summaryFields} quoteNumber title quoteStatus sentAt message amounts { total } client { id name } property { id name }`;
const jobFields = `${summaryFields} jobNumber title jobStatus instructions total client { id name } property { id name } quote { id } request { id }`;
const invoiceFields = `${summaryFields} invoiceNumber subject invoiceStatus issuedDate dueDate receivedDate amounts { total invoiceBalance } client { id name }`;
const visitFields = `id title visitStatus isComplete completedAt startAt endAt instructions job { id jobNumber title } client { id name } assignedUsers(first: 20) { nodes { id name { full } } }`;

const SEARCHES: Record<z.infer<typeof recordTypeSchema>, string> = {
  client: `query SearchClients($term:String,$first:Int!,$after:String){ clients(searchTerm:$term,first:$first,after:$after){ totalCount nodes { ${clientFields} } pageInfo { hasNextPage endCursor } } }`,
  property: `query SearchProperties($term:String,$first:Int!,$after:String){ clients(searchTerm:$term,first:$first,after:$after){ totalCount nodes { id name properties { ${propertyFields} } } pageInfo { hasNextPage endCursor } } }`,
  request: `query SearchRequests($term:String,$first:Int!,$after:String){ requests(searchTerm:$term,first:$first,after:$after){ totalCount nodes { ${requestFields} } pageInfo { hasNextPage endCursor } } }`,
  quote: `query SearchQuotes($term:String,$first:Int!,$after:String){ quotes(searchTerm:$term,first:$first,after:$after){ totalCount nodes { ${quoteFields} } pageInfo { hasNextPage endCursor } } }`,
  job: `query SearchJobs($term:String,$first:Int!,$after:String){ jobs(searchTerm:$term,first:$first,after:$after){ totalCount nodes { ${jobFields} } pageInfo { hasNextPage endCursor } } }`,
  invoice: `query SearchInvoices($term:String,$first:Int!,$after:String){ invoices(searchTerm:$term,first:$first,after:$after){ totalCount nodes { ${invoiceFields} } pageInfo { hasNextPage endCursor } } }`,
  visit: `query SearchVisits($first:Int!,$after:String){ visits(first:$first,after:$after){ totalCount nodes { ${visitFields} } pageInfo { hasNextPage endCursor } } }`,
};
const GETS: Record<z.infer<typeof recordTypeSchema>, string> = {
  client: `query GetClient($id:EncodedId!){ client(id:$id){ ${clientFields} tags(first:20){nodes{label}} customFields { ... on CustomFieldText { valueText } } notes(first:20){nodes{ message createdAt }} } }`,
  property: `query GetProperty($id:EncodedId!){ property(id:$id){ ${propertyFields} client { id name } customFields { ... on CustomFieldText { valueText } } } }`,
  request: `query GetRequest($id:EncodedId!){ request(id:$id){ ${requestFields} lineItems(first:50){nodes{id name description quantity unitPrice totalPrice}} notes(first:20){nodes{message createdAt}} customFields { ... on CustomFieldText { valueText } } } }`,
  quote: `query GetQuote($id:EncodedId!){ quote(id:$id){ ${quoteFields} contractDisclaimer lineItems(first:50){nodes{id name description quantity unitPrice totalPrice taxable}} notes(first:20){nodes{message createdAt}} customFields { ... on CustomFieldText { valueText } } } }`,
  job: `query GetJob($id:EncodedId!){ job(id:$id){ ${jobFields} visits(first:50){nodes{${visitFields}}} lineItems(first:50){nodes{id name description quantity unitPrice totalPrice taxable}} notes(first:20){nodes{message createdAt}} customFields { ... on CustomFieldText { valueText } } } }`,
  invoice: `query GetInvoice($id:EncodedId!){ invoice(id:$id){ ${invoiceFields} message contractDisclaimer lineItems(first:50){nodes{id name description quantity unitPrice totalPrice taxable}} notes(first:20){nodes{message createdAt}} customFields { ... on CustomFieldText { valueText } } } }`,
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
function linesToInvoice(lines: z.infer<typeof lineItemSchema>[]) {
  return lines.map((line) => ({ name: line.name, description: line.description, quantity: line.quantity, unitPrice: line.unit_price, taxable: line.taxable, productOrServiceId: line.product_or_service_id }));
}
function response(action: string, recordType: string, record: Node) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ action, record_type: recordType, record }) }] };
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
  await appendAuditLog({ tool, args, outcome: "success", result_count: 1, ...(record?.id ? { account_id: undefined } : {}) });
}

export function registerFoundationalTools(server: McpServer): void {
  registerReadOnlyTool(server, "search_records", {
    description: "Search a bounded Jobber record type using fixed reviewed queries. Use get_record before any write.",
    inputSchema: { record_type: recordTypeSchema, search_term: z.string().trim().max(250).optional(), page_size: pageSizeSchema(PAGE_CAP), cursor: cursorSchema(), returned_so_far: returnedSoFarSchema() },
    maxCost: READ_COST,
  }, async ({ record_type, search_term, page_size, cursor, returned_so_far = 0 }: any, run) => {
    const data = await run<Node>(SEARCHES[record_type as z.infer<typeof recordTypeSchema>], { term: search_term, first: page_size, after: cursor });
    const connection = data[record_type === "client" || record_type === "property" ? "clients" : `${record_type}s`];
    const nodes = record_type === "property" ? connection.nodes.flatMap((client: Node) => client.properties.map((property: Node) => ({ ...property, client: { id: client.id, name: client.name } }))) : connection.nodes;
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
    const duplicate = await run<Node>(`query ClientDuplicate($term:String!){clients(searchTerm:$term,first:5){nodes{id name emails{address} phones{number}}}}`, { term: args.emails[0]?.address ?? args.phones[0]?.number ?? `${args.first_name} ${args.last_name}` });
    if (duplicate.clients.nodes.some((client: Node) => client.emails.some((email: Node) => args.emails.some((wanted: Node) => wanted.address.toLowerCase() === email.address.toLowerCase())) || client.phones.some((phone: Node) => args.phones.some((wanted: Node) => wanted.number === phone.number)))) throw new Error("Potential duplicate client found; use update_client or resolve the record in Jobber.");
    const data = await run<Node>(`mutation CreateClient($input:ClientCreateInput!){clientCreate(input:$input){client{${clientFields}} userErrors{message path}}}`, { input: { firstName: args.first_name, lastName: args.last_name, companyName: args.company_name, emails: args.emails.map((email: Node) => ({ address: email.address, primary: email.primary })), phones: args.phones.map((phone: Node) => ({ number: phone.number, primary: phone.primary })), ...(args.billing_address ? { billingAddress: addressToJobber(args.billing_address) } : {}) } });
    const client = mutationRecord("creating client", data, "clientCreate", "client"); await audit("create_client", args, client); return response("created", "client", client);
  });

  registerWriteTool(server, "update_client", { description: "Update a reviewed Jobber client. Provide the updated_at returned by get_record to prevent stale changes.", capability: "records", inputSchema: { client_id: z.string().min(1), expected_updated_at: z.string().min(1), first_name: z.string().trim().min(1).max(100).optional(), last_name: z.string().trim().min(1).max(100).optional(), company_name: z.string().trim().max(200).nullable().optional(), billing_address: addressSchema.optional(), confirm_write: confirmSchema }, maxCost: WRITE_COST }, async (args: any, run) => {
    const current = await run<Node>(`query ClientVersion($id:EncodedId!){client(id:$id){updatedAt}}`, { id: args.client_id }); if (current.client?.updatedAt !== args.expected_updated_at) throw new Error("Client changed since it was reviewed; fetch it again before updating.");
    const input: Node = {}; for (const [from, to] of [["first_name", "firstName"], ["last_name", "lastName"], ["company_name", "companyName"]] as const) if (args[from] !== undefined) input[to] = args[from]; if (args.billing_address) input.billingAddress = addressToJobber(args.billing_address);
    const data = await run<Node>(`mutation EditClient($clientId:EncodedId!,$input:ClientEditInput!){clientEdit(clientId:$clientId,input:$input){client{${clientFields}} userErrors{message path}}}`, { clientId: args.client_id, input }); const client = mutationRecord("updating client", data, "clientEdit", "client"); await audit("update_client", args, client); return response("updated", "client", client);
  });

  registerWriteTool(server, "create_property", { description: "Create a service property for a known Jobber client.", capability: "records", inputSchema: { client_id: z.string().min(1), name: z.string().trim().max(200).optional(), address: addressSchema, confirm_write: confirmSchema }, maxCost: WRITE_COST }, async (args: any, run) => {
    const data = await run<Node>(`mutation CreateProperty($clientId:EncodedId!,$input:PropertyCreateInput!){propertyCreate(clientId:$clientId,input:$input){properties{${propertyFields}} userErrors{message path}}}`, { clientId: args.client_id, input: { properties: [{ name: args.name, address: addressToJobber(args.address) }] } }); const properties = mutationRecord("creating property", data, "propertyCreate", "properties"); const property = singleCreatedRecord("creating property", properties); await audit("create_property", args, property); return response("created", "property", property);
  });

  registerWriteTool(server, "update_property", { description: "Update a known Jobber property after approval.", capability: "records", inputSchema: { property_id: z.string().min(1), expected_name: z.string().max(200).nullable(), name: z.string().trim().max(200).optional(), address: addressSchema.optional(), confirm_write: confirmSchema }, maxCost: WRITE_COST }, async (args: any, run) => {
    const current = await run<Node>(`query PropertyCurrent($id:EncodedId!){property(id:$id){name}}`, { id: args.property_id }); if (current.property?.name !== args.expected_name) throw new Error("Property changed since it was reviewed; fetch it again before updating.");
    const data = await run<Node>(`mutation EditProperty($propertyId:EncodedId!,$input:PropertyEditInput!){propertyEdit(propertyId:$propertyId,input:$input){property{${propertyFields}} userErrors{message path}}}`, { propertyId: args.property_id, input: { ...(args.name !== undefined ? { name: args.name } : {}), ...(args.address ? { address: addressToJobber(args.address) } : {}) } }); const property = mutationRecord("updating property", data, "propertyEdit", "property"); await audit("update_property", args, property); return response("updated", "property", property);
  });

  registerWriteTool(server, "create_request", { description: "Create a Jobber work request for a known client and optional property.", capability: "records", inputSchema: { client_id: z.string().min(1), property_id: z.string().min(1).optional(), title: z.string().trim().max(250).optional(), salesperson_id: z.string().min(1).optional(), confirm_write: confirmSchema }, maxCost: WRITE_COST }, async (args: any, run) => {
    const data = await run<Node>(`mutation CreateRequest($input:RequestCreateInput!){requestCreate(input:$input){request{${requestFields}} userErrors{message path}}}`, { input: { clientId: args.client_id, propertyId: args.property_id, title: args.title, salespersonId: args.salesperson_id } }); const request = mutationRecord("creating request", data, "requestCreate", "request"); await audit("create_request", args, request); return response("created", "request", request);
  });

  registerWriteTool(server, "update_request", { description: "Update a reviewed Jobber request.", capability: "records", inputSchema: { request_id: z.string().min(1), expected_updated_at: z.string().min(1), title: z.string().trim().max(250).optional(), property_id: z.string().min(1).optional(), salesperson_id: z.string().min(1).optional(), confirm_write: confirmSchema }, maxCost: WRITE_COST }, async (args: any, run) => {
    const current = await run<Node>(`query RequestVersion($id:EncodedId!){request(id:$id){updatedAt}}`, { id: args.request_id }); if (current.request?.updatedAt !== args.expected_updated_at) throw new Error("Request changed since it was reviewed; fetch it again before updating.");
    const data = await run<Node>(`mutation EditRequest($requestId:EncodedId!,$input:RequestEditInput!){requestEdit(requestId:$requestId,input:$input){request{${requestFields}} userErrors{message path}}}`, { requestId: args.request_id, input: { title: args.title, propertyId: args.property_id, salespersonId: args.salesperson_id } }); const request = mutationRecord("updating request", data, "requestEdit", "request"); await audit("update_request", args, request); return response("updated", "request", request);
  });

  registerQuoteJobInvoiceWrites(server);
}

function registerQuoteJobInvoiceWrites(server: McpServer): void {
  registerWriteTool(server, "create_draft_quote", { description: "Create a draft Jobber quote with explicit structured line items. It does not send the quote.", capability: "records", inputSchema: { client_id: z.string().min(1), property_id: z.string().min(1), request_id: z.string().min(1).optional(), title: z.string().trim().max(250).optional(), message: z.string().trim().max(10000).optional(), contract_disclaimer: z.string().trim().max(20000).optional(), line_items: z.array(lineItemSchema).min(1).max(100), confirm_write: confirmSchema }, maxCost: WRITE_COST }, async (args: any, run) => {
    const data = await run<Node>(`mutation CreateQuote($attributes:QuoteCreateAttributes!){quoteCreate(attributes:$attributes){quote{${quoteFields}} userErrors{message path}}}`, { attributes: { clientId: args.client_id, propertyId: args.property_id, requestId: args.request_id, title: args.title, message: args.message, contractDisclaimer: args.contract_disclaimer, lineItems: linesToQuote(args.line_items) } }); const quote = mutationRecord("creating draft quote", data, "quoteCreate", "quote"); await audit("create_draft_quote", args, quote); return response("created", "quote", quote);
  });
  registerWriteTool(server, "update_draft_quote", { description: "Update header fields on a reviewed draft quote. Existing quote line items have their own reviewed IDs and are intentionally not bulk-replaced.", capability: "records", inputSchema: { quote_id: z.string().min(1), expected_updated_at: z.string().min(1), title: z.string().trim().max(250).optional(), message: z.string().trim().max(10000).optional(), contract_disclaimer: z.string().trim().max(20000).optional(), confirm_write: confirmSchema }, maxCost: WRITE_COST }, async (args: any, run) => {
    const current = await run<Node>(`query QuoteVersion($id:EncodedId!){quote(id:$id){updatedAt quoteStatus}}`, { id: args.quote_id }); if (current.quote?.updatedAt !== args.expected_updated_at) throw new Error("Quote changed since it was reviewed; fetch it again before updating."); if (String(current.quote.quoteStatus).toLowerCase() !== "draft") throw new Error("Only draft quotes can be edited by this tool.");
    if (args.title === undefined && args.message === undefined && args.contract_disclaimer === undefined) throw new Error("Provide at least one quote field to update.");
    const data = await run<Node>(`mutation EditQuote($quoteId:EncodedId!,$attributes:QuoteEditAttributes!){quoteEdit(quoteId:$quoteId,attributes:$attributes){quote{${quoteFields}} userErrors{message path}}}`, { quoteId: args.quote_id, attributes: { title: args.title, message: args.message, contractDisclaimer: args.contract_disclaimer } }); const quote = mutationRecord("updating draft quote", data, "quoteEdit", "quote"); await audit("update_draft_quote", args, quote); return response("updated", "quote", quote);
  });
  registerWriteTool(server, "create_job", { description: "Create a Jobber fixed-price or visit-based job from a property and optional request or quote.", capability: "records", inputSchema: { property_id: z.string().min(1), quote_id: z.string().min(1).optional(), request_id: z.string().min(1).optional(), title: z.string().trim().max(250).optional(), instructions: z.string().trim().max(10000).optional(), billing_type: z.enum(["FIXED_PRICE", "VISIT_BASED"]), billing_schedule: z.enum(["ON_COMPLETION", "PERIODIC", "PER_VISIT", "NEVER"]), line_items: z.array(lineItemSchema).max(100).default([]), confirm_write: confirmSchema }, maxCost: WRITE_COST }, async (args: any, run) => {
    const data = await run<Node>(`mutation CreateJob($input:JobCreateAttributes!){jobCreate(input:$input){job{${jobFields}} userErrors{message path}}}`, { input: { propertyId: args.property_id, quoteId: args.quote_id, requestId: args.request_id, title: args.title, instructions: args.instructions, lineItems: linesToJob(args.line_items), invoicing: { invoicingType: args.billing_type, invoicingSchedule: args.billing_schedule }, scheduling: { createVisits: false, notifyTeam: false } } }); const job = mutationRecord("creating job", data, "jobCreate", "job"); await audit("create_job", args, job); return response("created", "job", job);
  });
  registerWriteTool(server, "update_job", { description: "Update title or instructions on a reviewed Jobber job.", capability: "records", inputSchema: { job_id: z.string().min(1), expected_updated_at: z.string().min(1), title: z.string().trim().max(250).optional(), instructions: z.string().trim().max(10000).optional(), confirm_write: confirmSchema }, maxCost: WRITE_COST }, async (args: any, run) => {
    const current = await run<Node>(`query JobVersion($id:EncodedId!){job(id:$id){updatedAt}}`, { id: args.job_id }); if (current.job?.updatedAt !== args.expected_updated_at) throw new Error("Job changed since it was reviewed; fetch it again before updating."); if (args.title === undefined && args.instructions === undefined) throw new Error("Provide a title or instructions to update."); const data = await run<Node>(`mutation EditJob($jobId:EncodedId!,$input:JobEditInput!){jobEdit(jobId:$jobId,input:$input){job{${jobFields}} userErrors{message path}}}`, { jobId: args.job_id, input: { title: args.title, instructions: args.instructions } }); const job = mutationRecord("updating job", data, "jobEdit", "job"); await audit("update_job", args, job); return response("updated", "job", job);
  });
  registerWriteTool(server, "create_draft_invoice", { description: "Create an unsent Jobber invoice with explicit line items. Payments are never created or captured.", capability: "records", inputSchema: { client_id: z.string().min(1), property_id: z.string().min(1).optional(), job_id: z.string().min(1).optional(), subject: z.string().trim().max(250).optional(), message: z.string().trim().max(10000).optional(), due_date: z.string().datetime(), line_items: z.array(lineItemSchema).min(1).max(100), confirm_write: confirmSchema }, maxCost: WRITE_COST }, async (args: any, run) => {
    const data = await run<Node>(`mutation CreateInvoice($input:InvoiceCreateInput!){invoiceCreate(input:$input){invoice{${invoiceFields}} userErrors{message path}}}`, { input: { clientId: args.client_id, propertyId: args.property_id, jobId: args.job_id, subject: args.subject, message: args.message, dueDetails: { dueDate: args.due_date }, tax: { taxCalculationMethod: "EXCLUSIVE" }, lineItems: linesToInvoice(args.line_items), markSent: false } }); const invoice = mutationRecord("creating draft invoice", data, "invoiceCreate", "invoice"); await audit("create_draft_invoice", args, invoice); return response("created", "invoice", invoice);
  });
  registerWriteTool(server, "update_draft_invoice", { description: "Update header fields on a reviewed unsent invoice. Jobber does not expose invoice line-item editing in this API version.", capability: "records", inputSchema: { invoice_id: z.string().min(1), expected_updated_at: z.string().min(1), subject: z.string().trim().max(250).optional(), message: z.string().trim().max(10000).optional(), due_date: z.string().datetime().optional(), confirm_write: confirmSchema }, maxCost: WRITE_COST }, async (args: any, run) => {
    const current = await run<Node>(`query InvoiceVersion($id:EncodedId!){invoice(id:$id){updatedAt invoiceStatus}}`, { id: args.invoice_id }); if (current.invoice?.updatedAt !== args.expected_updated_at) throw new Error("Invoice changed since it was reviewed; fetch it again before updating."); if (String(current.invoice.invoiceStatus).toLowerCase() !== "draft") throw new Error("Only draft invoices can be edited by this tool."); const data = await run<Node>(`mutation EditInvoice($invoiceId:EncodedId!,$input:InvoiceEditInput!){invoiceEdit(invoiceId:$invoiceId,input:$input){invoice{${invoiceFields}} userErrors{message path}}}`, { invoiceId: args.invoice_id, input: { subject: args.subject, message: args.message, ...(args.due_date ? { dueDetails: { dueDate: args.due_date } } : {}) } }); const invoice = mutationRecord("updating draft invoice", data, "invoiceEdit", "invoice"); await audit("update_draft_invoice", args, invoice); return response("updated", "invoice", invoice);
  });
}

function registerSchedulingWrites(server: McpServer): void {
  const localTime = z.object({ date: z.string().date(), time: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(), timezone: z.string().min(1).default("America/Toronto") });
  registerWriteTool(server, "create_visit", { description: "Create a scheduled or unscheduled Jobber visit for a known job.", capability: "scheduling", inputSchema: { job_id: z.string().min(1), title: z.string().trim().max(250).optional(), instructions: z.string().trim().max(10000).optional(), start_at: localTime.optional(), end_at: localTime.optional(), assigned_user_ids: z.array(z.string().min(1)).max(20).default([]), confirm_write: confirmSchema }, maxCost: WRITE_COST }, async (args: any, run) => {
    if ((args.start_at === undefined) !== (args.end_at === undefined)) throw new Error("start_at and end_at must be supplied together"); const schedule = args.start_at ? { startAt: args.start_at, endAt: args.end_at, teamMemberIdsToAssign: args.assigned_user_ids, notifyTeam: false } : undefined;
    const data = await run<Node>(`mutation CreateVisit($jobId:EncodedId!,$input:VisitCreateInput!){visitCreate(jobId:$jobId,input:$input){createdVisits{${visitFields}} userErrors{message path}}}`, { jobId: args.job_id, input: { visits: [{ title: args.title, instructions: args.instructions, schedule }] } }); const visits = mutationRecord("creating visit", data, "visitCreate", "createdVisits"); const visit = singleCreatedRecord("creating visit", visits); await audit("create_visit", args, visit); return response("created", "visit", visit);
  });
  registerWriteTool(server, "update_visit", { description: "Update a reviewed Jobber visit's title, instructions, schedule, or assignments. Visit records have no updatedAt field in Jobber's schema, so expected schedule values are used for stale-write protection.", capability: "scheduling", inputSchema: { visit_id: z.string().min(1), expected_start_at: z.string().datetime().nullable(), expected_end_at: z.string().datetime().nullable(), title: z.string().trim().max(250).optional(), instructions: z.string().trim().max(10000).optional(), start_at: localTime.optional(), end_at: localTime.optional(), assigned_user_ids: z.array(z.string().min(1)).max(20).optional(), confirm_write: confirmSchema }, maxCost: WRITE_COST }, async (args: any, run) => {
    if ((args.start_at === undefined) !== (args.end_at === undefined)) throw new Error("start_at and end_at must be supplied together");
    const current = await run<Node>(`query VisitVersion($id:EncodedId!){visit(id:$id){startAt endAt}}`, { id: args.visit_id }); if (current.visit?.startAt !== args.expected_start_at || current.visit?.endAt !== args.expected_end_at) throw new Error("Visit schedule changed since it was reviewed; fetch it again before updating.");
    let visit: Node | undefined;
    if (args.title !== undefined || args.instructions !== undefined) { const data = await run<Node>(`mutation EditVisit($id:EncodedId!,$attributes:VisitEditAttributes!){visitEdit(id:$id,attributes:$attributes){visit{${visitFields}} userErrors{message path}}}`, { id: args.visit_id, attributes: { title: args.title, instructions: args.instructions } }); visit = mutationRecord("updating visit", data, "visitEdit", "visit"); }
    if (args.start_at) { const data = await run<Node>(`mutation ScheduleVisit($id:EncodedId!,$input:VisitEditScheduleInput!){visitEditSchedule(id:$id,input:$input){visit{${visitFields}} userErrors{message path}}}`, { id: args.visit_id, input: { startAt: args.start_at, endAt: args.end_at } }); visit = mutationRecord("scheduling visit", data, "visitEditSchedule", "visit"); }
    if (args.assigned_user_ids !== undefined) { const data = await run<Node>(`mutation AssignVisit($visitId:EncodedId!,$input:VisitEditAssignedUsersInput!){visitEditAssignedUsers(visitId:$visitId,input:$input){visit{${visitFields}} userErrors{message path}}}`, { visitId: args.visit_id, input: { assignedUserIds: args.assigned_user_ids } }); visit = mutationRecord("assigning visit", data, "visitEditAssignedUsers", "visit"); }
    if (!visit) throw new Error("Provide at least one visit field to update."); await audit("update_visit", args, visit); return response("updated", "visit", visit);
  });
  registerWriteTool(server, "complete_visit", { description: "Mark a reviewed Jobber visit complete. This is an operationally consequential action.", capability: "scheduling", inputSchema: { visit_id: z.string().min(1), expected_start_at: z.string().datetime().nullable(), expected_end_at: z.string().datetime().nullable(), completed_at: z.string().datetime().optional(), confirm_write: confirmSchema }, maxCost: WRITE_COST }, async (args: any, run) => {
    const current = await run<Node>(`query VisitVersion($id:EncodedId!){visit(id:$id){startAt endAt isComplete}}`, { id: args.visit_id }); if (current.visit?.startAt !== args.expected_start_at || current.visit?.endAt !== args.expected_end_at) throw new Error("Visit schedule changed since it was reviewed; fetch it again before completing."); if (current.visit.isComplete) throw new Error("Visit is already complete."); const data = await run<Node>(`mutation CompleteVisit($visitId:EncodedId!,$input:VisitCompleteInput!){visitComplete(visitId:$visitId,input:$input){visit{${visitFields}} userErrors{message path}}}`, { visitId: args.visit_id, input: { completedAt: args.completed_at } }); const visit = mutationRecord("completing visit", data, "visitComplete", "visit"); await audit("complete_visit", args, visit); return response("completed", "visit", visit);
  });
}

function registerCommunicationWrites(server: McpServer): void {
  registerWriteTool(server, "send_quote", { description: "Mark a reviewed quote as sent through Jobber. This API records the sent timestamp; it does not expose arbitrary-recipient email delivery.", capability: "communications", inputSchema: { quote_id: z.string().min(1), expected_updated_at: z.string().min(1), confirm_write: confirmSchema }, maxCost: WRITE_COST }, async (args: any, run) => {
    const current = await run<Node>(`query QuoteVersion($id:EncodedId!){quote(id:$id){updatedAt quoteStatus}}`, { id: args.quote_id }); if (current.quote?.updatedAt !== args.expected_updated_at) throw new Error("Quote changed since it was reviewed; fetch it again before sending."); if (String(current.quote.quoteStatus).toLowerCase() !== "draft") throw new Error("Only draft quotes can be sent by this tool.");
    const data = await run<Node>(`mutation SendQuote($quoteId:EncodedId!,$attributes:QuoteEditAttributes!){quoteEdit(quoteId:$quoteId,attributes:$attributes){quote{${quoteFields}} userErrors{message path}}}`, { quoteId: args.quote_id, attributes: { sentAt: new Date().toISOString() } }); const quote = mutationRecord("sending quote", data, "quoteEdit", "quote"); await audit("send_quote", args, quote); return response("sent", "quote", quote);
  });
  registerWriteTool(server, "send_invoice", { description: "Send a reviewed invoice through Jobber. Recipients are controlled by Jobber's client contact configuration; no arbitrary email recipient is accepted.", capability: "communications", inputSchema: { invoice_id: z.string().min(1), expected_updated_at: z.string().min(1), confirm_write: confirmSchema }, maxCost: WRITE_COST }, async (args: any, run) => {
    const current = await run<Node>(`query InvoiceVersion($id:EncodedId!){invoice(id:$id){updatedAt invoiceStatus}}`, { id: args.invoice_id }); if (current.invoice?.updatedAt !== args.expected_updated_at) throw new Error("Invoice changed since it was reviewed; fetch it again before sending."); const data = await run<Node>(`mutation SendInvoice($id:EncodedId!){invoiceMarkAsSent(id:$id){invoice{${invoiceFields}} userErrors{message path}}}`, { id: args.invoice_id }); const invoice = mutationRecord("sending invoice", data, "invoiceMarkAsSent", "invoice"); await audit("send_invoice", args, invoice); return response("sent", "invoice", invoice);
  });
}
