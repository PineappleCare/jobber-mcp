import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerWriteTool, toolErrorType, type CostedGraphQL } from "../tool-helpers.js";
import { appendAuditLog } from "../utils/auditLog.js";

type Node = Record<string, any>;
type Run = CostedGraphQL<number>;
const SCAN_PAGES = 10;
const invoiceFields = `id updatedAt jobberWebUri invoiceNumber subject invoiceStatus issuedDate dueDate receivedDate client{id name} taxCalculationMethod taxRate{id name tax components{id tax}} amounts{subtotal taxAmount total invoiceBalance discountAmount legacyDiscountAmount depositAmount paymentsTotal tipsTotal}`;
const taxFields = `id name tax default components{id tax}`;
const invoiceLineItemSchema = z.object({
  name: z.string().trim().min(1).max(250),
  description: z.string().trim().max(4000).optional(),
  quantity: z.number().finite().min(-100000).max(100000).refine(value => value !== 0, "Quantity must not be zero").default(1)
    .describe("Positive for charges; negative for a separate discount (-1 at unit_price 150 deducts 150)"),
  unit_price: z.number().finite().min(0).max(1_000_000),
  taxable: z.boolean().optional().describe("Defaults to true for HST, false for tax_mode none. Set false only for an explicitly requested exempt line."),
  product_or_service_id: z.string().trim().min(1).optional(),
});
type Line = z.infer<typeof invoiceLineItemSchema>;
type ApprovedLine = Line & { taxable: boolean };
type TaxMode = "hst_13" | "none";

function requireCondition(value: unknown, message: string): asserts value {
  if (!value) throw new Error(message);
}
function normalized(value: unknown): string {
  return String(value ?? "").trim().toLowerCase().replace(/\s+/g, " ");
}
function cents(value: number): number {
  // Round negative discounts symmetrically with positive charges.
  return Math.sign(value) * Math.round(Math.abs(value) * 100 + 1e-7);
}
function moneyMatches(actual: unknown, expectedCents: number): boolean {
  return typeof actual === "number" && Number.isFinite(actual) && Math.abs(actual * 100 - expectedCents) < 0.0001;
}
function flatRate(rate: Node | undefined, percent: number): boolean {
  return !!rate && typeof rate.id === "string" && !!rate.id && rate.tax === percent &&
    (rate.components === null || (Array.isArray(rate.components) && rate.components.length === 0));
}

/** Finish the bounded scan before mutating; never treat an incomplete page as empty. */
async function invoicePreflight(args: { client_id: string; property_id?: string; subject: string }, run: Run): Promise<void> {
  let after: string | undefined;
  let version: string | undefined;
  const cursors = new Set<string>();
  const ids = new Set<string>();
  for (let page = 0; page < SCAN_PAGES; page++) {
    const data = await run<Node>(`query InvoicePreflight($clientId:EncodedId!,$after:String){client(id:$clientId){id updatedAt properties{id} invoices(first:50,after:$after){nodes{id subject invoiceStatus} pageInfo{hasNextPage endCursor}}}}`, { clientId: args.client_id, after });
    const client = data.client;
    requireCondition(client?.id === args.client_id && typeof client.updatedAt === "string" && client.updatedAt, "Client not found or version unavailable; no invoice was created.");
    requireCondition(version === undefined || client.updatedAt === version, "Client changed during invoice preflight; review again. No invoice was created.");
    version = client.updatedAt;
    if (args.property_id) requireCondition(Array.isArray(client.properties) && client.properties.some((property: Node) => property?.id === args.property_id), "Property does not belong to the selected client; no invoice was created.");
    const connection = client.invoices;
    requireCondition(Array.isArray(connection?.nodes) && connection.nodes.length <= 50 && typeof connection.pageInfo?.hasNextPage === "boolean", "Invoice duplicate preflight is incomplete; no invoice was created.");
    for (const invoice of connection.nodes) {
      requireCondition(invoice && typeof invoice.id === "string" && !ids.has(invoice.id) && typeof invoice.subject === "string" && typeof invoice.invoiceStatus === "string", "Invoice duplicate preflight is inconsistent; no invoice was created.");
      ids.add(invoice.id);
      if (normalized(invoice.subject) === normalized(args.subject) && normalized(invoice.invoiceStatus) === "draft") throw new Error("A matching draft invoice already exists; no invoice was created.");
    }
    if (!connection.pageInfo.hasNextPage) return;
    const next = connection.pageInfo.endCursor;
    requireCondition(typeof next === "string" && next && !cursors.has(next), "Invoice duplicate preflight has an invalid cursor; no invoice was created.");
    cursors.add(next);
    after = next;
  }
  throw new Error("Invoice duplicate preflight exceeds 500 invoices; reconcile manually. No invoice was created.");
}

async function resolveTax(mode: TaxMode, selectedId: string | undefined, run: Run): Promise<Node> {
  const percent = mode === "hst_13" ? 13 : 0;
  let after: string | undefined;
  const rates: Node[] = [];
  const ids = new Set<string>(), cursors = new Set<string>();
  for (let page = 0; page < SCAN_PAGES; page++) {
    const data = await run<Node>(`query InvoiceTaxRates($after:String){taxRates(first:50,after:$after){nodes{${taxFields}} pageInfo{hasNextPage endCursor}}}`, { after });
    const connection = data.taxRates;
    requireCondition(Array.isArray(connection?.nodes) && connection.nodes.length <= 50 && typeof connection.pageInfo?.hasNextPage === "boolean", "Tax catalogue is incomplete; no invoice was created.");
    for (const rate of connection.nodes) {
      requireCondition(rate && typeof rate.id === "string" && !ids.has(rate.id), "Tax catalogue is inconsistent; no invoice was created.");
      ids.add(rate.id);
      rates.push(rate);
    }
    if (!connection.pageInfo.hasNextPage) {
      const flatRates = rates.filter(rate => typeof rate.tax === "number" && Number.isFinite(rate.tax) && rate.tax >= 0 && rate.tax <= 100 && flatRate(rate, rate.tax));
      const candidates = mode === "none" ? flatRates : flatRates.filter(rate => rate.tax === percent && /\bhst\b/i.test(rate.name));
      if (selectedId) {
        const selected = candidates.find(rate => rate.id === selectedId);
        requireCondition(selected, "Selected tax_rate_id is not an account-owned flat rate matching tax_mode; no invoice was created.");
        return selected;
      }
      // No-tax invoices use only non-taxable lines. Prefer a zero rate if available,
      // otherwise retain the verified account default rather than creating a tax rate.
      const zeroRates = mode === "none" ? candidates.filter(rate => rate.tax === 0) : [];
      const choices = zeroRates.length ? zeroRates : candidates;
      const defaults = choices.filter(rate => rate.default === true);
      const selected = defaults.length === 1 ? defaults[0] : choices.length === 1 ? choices[0] : undefined;
      requireCondition(selected, `No unique flat ${mode === "hst_13" ? "13% HST" : "invoice"} tax rate found. Review the account's tax settings and provide a matching tax_rate_id; no invoice was created.`);
      return selected;
    }
    const next = connection.pageInfo.endCursor;
    requireCondition(typeof next === "string" && next && !cursors.has(next), "Tax catalogue has an invalid cursor; no invoice was created.");
    cursors.add(next); after = next;
  }
  throw new Error("Tax catalogue exceeds 500 rates; no invoice was created.");
}

/** Multiset matching preserves repeated lines and tolerates Jobber reordering. */
function verifyLines(expected: ApprovedLine[], invoice: Node) {
  const connection = invoice.lineItems;
  const complete = Array.isArray(connection?.nodes) && connection.pageInfo?.hasNextPage === false &&
    new Set(connection.nodes.map((line: Node) => line?.id)).size === connection.nodes.length;
  const remaining: Node[] = Array.isArray(connection?.nodes) ? [...connection.nodes] : [];
  const results = expected.map((line, index) => {
    const match = remaining.findIndex(saved => saved && typeof saved.id === "string" && !!saved.id && saved.name === line.name &&
      (saved.description ?? "") === (line.description ?? "") && saved.quantity === line.quantity && saved.unitPrice === line.unit_price &&
      moneyMatches(saved.totalPrice, cents(line.quantity * line.unit_price)) && saved.taxable === line.taxable &&
      (line.product_or_service_id === undefined || saved.linkedProductOrService?.id === line.product_or_service_id));
    const saved = match < 0 ? undefined : remaining.splice(match, 1)[0];
    return { index, verification: saved ? "verified" : "mismatch", ...(saved ? { line_item_id: saved.id, quantity: saved.quantity, unit_price: saved.unitPrice, total_price: saved.totalPrice, taxable: saved.taxable } : {}) };
  });
  return { verified: complete && remaining.length === 0 && results.every(result => result.verification === "verified"), complete, unexpected_line_count: remaining.length, results };
}
function verifyAmounts(lines: ApprovedLine[], invoice: Node, rate: Node) {
  const subtotal = lines.reduce((sum, line) => sum + cents(line.quantity * line.unit_price), 0);
  const taxable = lines.reduce((sum, line) => sum + (line.taxable ? cents(line.quantity * line.unit_price) : 0), 0);
  const tax = cents(taxable / 100 * rate.tax / 100);
  const total = subtotal + tax;
  const actual = invoice.amounts;
  const verified = !!actual && moneyMatches(actual.subtotal, subtotal) && moneyMatches(actual.taxAmount, tax) &&
    moneyMatches(actual.total, total) && moneyMatches(actual.invoiceBalance, total) &&
    ["discountAmount", "legacyDiscountAmount", "depositAmount", "paymentsTotal", "tipsTotal"].every(key => moneyMatches(actual[key], 0));
  return { verified, expected: { subtotal: subtotal / 100, tax: tax / 100, total: total / 100 } };
}

export function registerCreateDraftInvoice(server: McpServer): void {
  registerWriteTool(server, "create_draft_invoice", {
    description: "Create an unsent invoice and verify dates, lines, tax and totals. Default tax_mode hst_13 selects a verified 13% HST rate and taxable lines. Use tax_mode none only when explicitly requested: all lines become non-taxable and tax is zero (the account rate may remain configured). Include the subject, tax_mode, all lines and due date for approval. Negative quantity with positive unit_price makes a separate discount (-1 at 150 deducts 150 before tax). Existing source-job invoices or matching client drafts block creation. Partial/uncertain outcomes must be reconciled; never automatically retry. No sending or payments.",
    capability: "records", redactAuditErrors: true,
    inputSchema: {
      client_id: z.string().min(1), property_id: z.string().min(1).optional(), job_id: z.string().min(1).optional(),
      subject: z.string().trim().min(1).max(250).describe("Required reviewed subject; used in the complete duplicate preflight"),
      message: z.string().trim().max(10000).optional(), due_date: z.string().datetime({ offset: true }),
      tax_mode: z.enum(["hst_13", "none"]).default("hst_13").describe("Normally hst_13. Use none only on the operator's explicit instruction."),
      tax_rate_id: z.string().trim().min(1).optional().describe("Optional account tax ID to disambiguate rates; must match tax_mode"),
      line_items: z.array(invoiceLineItemSchema).min(1).max(100), confirm_write: z.literal(true),
    }, maxCost: 800,
  }, async (args, run) => {
    requireCondition(!(args.property_id && args.job_id), "A Jobber invoice can be sourced from a property or a job, not both.");
    const approvedLines: ApprovedLine[] = args.line_items.map(line => ({ ...line, taxable: line.taxable ?? args.tax_mode === "hst_13" }));
    requireCondition(args.tax_mode !== "none" || approvedLines.every(line => !line.taxable), "tax_mode none cannot include taxable lines; no invoice was created.");
    await invoicePreflight(args, run);
    if (args.job_id) {
      const data = await run<Node>(`query JobForInvoice($id:EncodedId!){job(id:$id){id client{id} invoices(first:1){nodes{id} pageInfo{hasNextPage}}}}`, { id: args.job_id });
      requireCondition(data.job?.id === args.job_id && data.job.client?.id === args.client_id, "Job does not belong to the selected client; no invoice was created.");
      requireCondition(Array.isArray(data.job.invoices?.nodes) && data.job.invoices.nodes.length === 0 && data.job.invoices.pageInfo?.hasNextPage === false, "The source job already has an invoice or its invoice list is incomplete; no invoice was created.");
    }
    const rate = await resolveTax(args.tax_mode, args.tax_rate_id, run);
    let invoice: Node | undefined, observed: Node | undefined;
    let mutationFailure: unknown, verificationFailure: unknown;
    let mutationError: string | undefined, verificationError: string | undefined;
    let userErrors: unknown[] = [];
    try {
      const data = await run<Node>(`mutation CreateInvoice($input:InvoiceCreateInput!){invoiceCreate(input:$input){invoice{${invoiceFields}} userErrors{message path}}}`, { input: {
        clientId: args.client_id, propertyId: args.property_id, jobId: args.job_id, subject: args.subject, message: args.message,
        dueDetails: { dueDate: args.due_date }, tax: { taxRateId: rate.id, taxCalculationMethod: "EXCLUSIVE" },
        lineItems: approvedLines.map(line => ({ name: line.name, description: line.description, quantity: line.quantity, unitPrice: line.unit_price, taxable: line.taxable, productOrServiceId: line.product_or_service_id })), markSent: false,
      } });
      const payload = data?.invoiceCreate;
      invoice = payload?.invoice;
      if (!payload || !Array.isArray(payload.userErrors)) mutationError = "Jobber returned an incomplete mutation response.";
      else userErrors = payload.userErrors;
      if (!invoice?.id && !userErrors.length) mutationError = "Jobber did not return an invoice ID.";
    } catch (error) { mutationFailure = error; mutationError = error instanceof Error ? error.message : String(error); }
    if (invoice?.id) {
      try {
        const data = await run<Node>(`query VerifyCreatedInvoice($id:EncodedId!){invoice(id:$id){${invoiceFields} message jobs(first:2){nodes{id} pageInfo{hasNextPage}} properties(first:2){nodes{id} pageInfo{hasNextPage}} lineItems(first:100){nodes{id name description quantity unitPrice totalPrice taxable linkedProductOrService{id}} pageInfo{hasNextPage}}}}`, { id: invoice.id });
        requireCondition(data.invoice?.id === invoice.id, "Created invoice could not be read back.");
        observed = data.invoice;
      } catch (error) { verificationFailure = error; verificationError = error instanceof Error ? error.message : String(error); }
    }
    const lines = observed ? verifyLines(approvedLines, observed) : undefined;
    const amounts = observed ? verifyAmounts(approvedLines, observed, rate) : undefined;
    const destinationVerified = !!observed && observed.client?.id === args.client_id &&
      observed.jobs?.pageInfo?.hasNextPage === false && Array.isArray(observed.jobs?.nodes) &&
      (args.job_id ? observed.jobs.nodes.length === 1 && observed.jobs.nodes[0]?.id === args.job_id : observed.jobs.nodes.length === 0) &&
      (!args.property_id || (observed.properties?.pageInfo?.hasNextPage === false && observed.properties.nodes?.length === 1 && observed.properties.nodes[0]?.id === args.property_id));
    // Compare instants, so equivalent ISO timestamps with different offsets match.
    const dueDateVerified = typeof observed?.dueDate === "string" && Date.parse(observed.dueDate) === Date.parse(args.due_date);
    const headerVerified = !!observed && observed.invoiceStatus === "draft" && observed.subject === args.subject && dueDateVerified &&
      (args.message === undefined || observed.message === args.message);
    const taxVerified = !!observed && normalized(observed.taxCalculationMethod) === "exclusive" && observed.taxRate?.id === rate.id && flatRate(observed.taxRate, rate.tax);
    const verified = !!lines?.verified && !!amounts?.verified && destinationVerified && headerVerified && taxVerified;
    const successful = verified && !mutationError && !userErrors.length;
    const failureType = mutationFailure ? toolErrorType(mutationFailure) : undefined;
    const definiteRejection = !invoice?.id && (userErrors.length > 0 || failureType === "jobber_rejected");
    const outcome = successful ? "created" : definiteRejection ? "rejected" : !invoice?.id && failureType === "connection_unavailable" ? "connection_unavailable" : "partial_or_uncertain";
    const errorType = successful ? undefined : verificationFailure && toolErrorType(verificationFailure) === "connection_unavailable" ? "connection_unavailable" :
      failureType && failureType !== "invalid_request" ? failureType : definiteRejection ? "jobber_rejected" : "outcome_uncertain";
    await appendAuditLog({ tool: "create_draft_invoice", args: { ...args, tax_rate_id: rate.id, line_items: approvedLines, invoice_id: invoice?.id }, outcome: successful ? "success" : "error", ...(successful ? {} : { error_message: `Invoice outcome: ${outcome}; ${errorType}. Details omitted for sensitive input.` }) });
    const record = observed ?? invoice;
    return { content: [{ type: "text" as const, text: JSON.stringify({
      action: successful ? "created" : "create_invoice", record_type: "invoice", outcome, verification: verified ? "verified" : "unverified",
      ...(record ? { record, record_version: record.updatedAt } : {}), ...(invoice?.id ? { invoice_id: invoice.id } : {}),
      destination_verified: destinationVerified, header_verified: headerVerified, due_date_verified: dueDateVerified, tax_verified: taxVerified,
      amounts_verified: amounts?.verified ?? false, ...(amounts ? { expected_amounts: amounts.expected } : {}),
      tax_mode: args.tax_mode, tax_rate: { id: rate.id, name: rate.name, percent: rate.tax },
      ...(lines ? { line_items_complete: lines.complete, unexpected_line_count: lines.unexpected_line_count, results: lines.results } : {}),
      ...(errorType ? { error_type: errorType } : {}), ...(mutationError ? { mutation_error: mutationError } : {}),
      ...(userErrors.length ? { user_errors: userErrors } : {}), ...(verificationError ? { verification_error: verificationError } : {}),
      ...(!successful ? { guidance: outcome === "connection_unavailable" ? "Resolve the connection/authentication failure before a newly approved request. The mutation was not retried." : outcome === "rejected" ? "Jobber rejected the request. Review and correct it before a newly approved write. The mutation was not retried." : "The mutation was not retried. Read the returned invoice ID, or search this client's invoices if no ID was returned, and reconcile before proposing a newly approved write." } : {}),
    }) }], ...(!successful ? { isError: true } : {}) };
  });
}
