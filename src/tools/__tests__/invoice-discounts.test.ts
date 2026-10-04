import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { read, write, audit } = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), audit: vi.fn() }));
vi.mock("../../jobber/client.js", () => ({ jobberGraphQL: read, jobberGraphQLWrite: write }));
vi.mock("../../utils/auditLog.js", () => ({ appendAuditLog: audit }));
import { registerFoundationalTools } from "../foundations.js";
import { JobberAuthenticationError, JobberGraphQLRequestError, JobberOutcomeUncertainError } from "../../jobber/errors.js";
import { BudgetUnavailableError } from "../../jobber/cost-governor.js";

const oldReadOnly = process.env.JOBBER_READ_ONLY;
const oldCapabilities = process.env.JOBBER_WRITE_CAPABILITIES;
const lines = [
  { name: "Service charge", quantity: 1, unit_price: 300, taxable: true },
  { name: "Pipe and fittings", quantity: 1, unit_price: 20, taxable: true },
  { name: "Missed-arrival discount", description: "Separate approved discount", quantity: -1, unit_price: 150, taxable: true },
];
const args = { client_id: "client-1", job_id: "job-1", subject: "Repair", due_date: "2026-10-05T00:00:00Z", line_items: lines, confirm_write: true };
function invoice(inputLines = lines) {
  return {
    id: "invoice-1", updatedAt: "version-1", invoiceStatus: "draft", subject: "Repair", message: "",
    client: { id: "client-1" }, jobs: { nodes: [{ id: "job-1" }], pageInfo: { hasNextPage: false } }, properties: { nodes: [{ id: "property-1" }], pageInfo: { hasNextPage: false } },
    dueDate: args.due_date, taxCalculationMethod: "exclusive", taxRate: { id: "hst-13", name: "HST", tax: 13, components: [] },
    amounts: (() => {
      const subtotal = inputLines.reduce((sum, line) => sum + line.quantity * line.unit_price, 0);
      const taxable = inputLines.reduce((sum, line) => sum + (line.taxable === false ? 0 : line.quantity * line.unit_price), 0);
      const taxAmount = Math.round(taxable * 13) / 100;
      const total = Math.round((subtotal + taxAmount) * 100) / 100;
      return { subtotal, taxAmount, total, invoiceBalance: total, discountAmount: 0, legacyDiscountAmount: 0, depositAmount: 0, paymentsTotal: 0, tipsTotal: 0 };
    })(),
    lineItems: { nodes: inputLines.map((line, index) => ({
      id: `line-${index}`, name: line.name, description: line.description ?? "", quantity: line.quantity,
      unitPrice: line.unit_price, totalPrice: line.quantity * line.unit_price, taxable: line.taxable ?? true, linkedProductOrService: null,
    })), pageInfo: { hasNextPage: false } },
  };
}
const taxRates = [
  { id: "hst-13", name: "HST", tax: 13, default: true, components: [] },
  { id: "zero", name: "No tax", tax: 0, default: false, components: [] },
];
function clientPage(nodes: any[] = [], hasNextPage = false, endCursor?: string) {
  return { client: { id: "client-1", updatedAt: "client-version", properties: [{ id: "property-1" }], invoices: { nodes, pageInfo: { hasNextPage, endCursor } } } };
}
function jobPage(nodes: any[] = []) {
  return { job: { id: "job-1", client: { id: "client-1" }, invoices: { nodes, pageInfo: { hasNextPage: false } } } };
}
function defaultReads(observed: any) {
  read.mockImplementation((query: string) => {
    if (query.includes("InvoicePreflight")) return clientPage();
    if (query.includes("JobForInvoice")) return jobPage();
    if (query.includes("InvoiceTaxRates")) return { taxRates: { nodes: taxRates, pageInfo: { hasNextPage: false } } };
    if (query.includes("VerifyCreatedInvoice")) return { invoice: observed };
    throw new Error("Unexpected query in fixture");
  });
}
function setup(observed: any = invoice(), mutation: any = { invoice: invoice(), userErrors: [] }) {
  const handlers: Record<string, any> = {}, configs: Record<string, any> = {};
  registerFoundationalTools({ registerTool(name: string, config: any, handler: any) { configs[name] = config; handlers[name] = handler; } } as any);
  defaultReads(observed);
  write.mockResolvedValueOnce({ invoiceCreate: mutation });
  async function invoke(input: any = args) {
    const validated = await configs.create_draft_invoice.inputSchema["~standard"].validate(input);
    if (validated.issues) return { validation_issues: validated.issues };
    return handlers.create_draft_invoice(validated.value);
  }
  return { handlers, configs, invoke };
}
function payload(result: any) { return JSON.parse(result.content[0].text); }

beforeEach(() => {
  process.env.JOBBER_READ_ONLY = "false";
  process.env.JOBBER_WRITE_CAPABILITIES = "records";
  read.mockReset(); write.mockReset(); audit.mockReset().mockResolvedValue(undefined);
});
afterEach(() => {
  if (oldReadOnly === undefined) delete process.env.JOBBER_READ_ONLY; else process.env.JOBBER_READ_ONLY = oldReadOnly;
  if (oldCapabilities === undefined) delete process.env.JOBBER_WRITE_CAPABILITIES; else process.env.JOBBER_WRITE_CAPABILITIES = oldCapabilities;
});

describe("draft invoice discounts", () => {
  it("creates the three separate approved lines and verifies a 170 pre-tax subtotal", async () => {
    const result = await setup().invoke();
    expect(result.isError).not.toBe(true);
    expect(payload(result)).toMatchObject({ action: "created", outcome: "created", verification: "verified", invoice_id: "invoice-1", results: [
      { quantity: 1, total_price: 300 }, { quantity: 1, total_price: 20 }, { quantity: -1, total_price: -150 },
    ] });
    const input = write.mock.calls[0][1].input;
    expect(input.lineItems.map((line: any) => [line.name, line.quantity, line.unitPrice])).toEqual(lines.map(line => [line.name, line.quantity, line.unit_price]));
    expect(input.lineItems.reduce((sum: number, line: any) => sum + line.quantity * line.unitPrice, 0)).toBe(170);
    expect(input.markSent).toBe(false);
    expect(write).toHaveBeenCalledTimes(1);
    expect(read.mock.calls[3][0]).toContain("VerifyCreatedInvoice");
    expect(audit).toHaveBeenCalledWith(expect.objectContaining({ tool: "create_draft_invoice", outcome: "success" }));
  });

  it.each([-2, -1.5])("supports signed fractional/multiple quantities (%s)", async quantity => {
    const inputLines = [{ name: "Discount", quantity, unit_price: 25, taxable: false }];
    const result = await setup(invoice(inputLines)).invoke({ ...args, line_items: inputLines });
    expect(payload(result).outcome).toBe("created");
    expect(write.mock.calls[0][1].input.lineItems[0].quantity).toBe(quantity);
  });

  it.each([0, -100001, 100001, Infinity, -Infinity, NaN])("rejects invalid quantity %s without an API call", async quantity => {
    const result = await setup().invoke({ ...args, line_items: [{ ...lines[0], quantity }] });
    expect(result.validation_issues).toBeDefined();
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  });

  it("keeps negative prices unavailable and requires explicit confirmation", async () => {
    const { invoke } = setup();
    expect((await invoke({ ...args, line_items: [{ ...lines[0], unit_price: -150 }] })).validation_issues).toBeDefined();
    expect((await invoke({ ...args, confirm_write: false })).validation_issues).toBeDefined();
    expect(write).not.toHaveBeenCalled();
  });

  it("keeps quantities positive on quote and job creation", async () => {
    const { configs } = setup();
    for (const name of ["create_draft_quote", "create_job"]) {
      const result = await configs[name].inputSchema["~standard"].validate({
        client_id: "client-1", property_id: "property-1", line_items: [lines[2]],
        billing_type: "FIXED_PRICE", billing_schedule: "ON_COMPLETION", confirm_write: true,
      });
      expect(result.issues).toBeDefined();
    }
  });

  it("preserves default quantity 1 on ordinary positive invoices", async () => {
    const inputLines = [{ name: "Charge", quantity: 1, unit_price: 100, taxable: true }];
    const result = await setup(invoice(inputLines)).invoke({ ...args, line_items: [{ name: "Charge", unit_price: 100, taxable: true }] });
    expect(payload(result).outcome).toBe("created");
    expect(write.mock.calls[0][1].input.lineItems[0].quantity).toBe(1);
  });

  it("matches reordered lines without conflating repeated identical items", async () => {
    const inputLines = [lines[0], lines[0], lines[2]];
    const observed = invoice(inputLines);
    observed.lineItems.nodes.reverse();
    const result = await setup(observed).invoke({ ...args, line_items: inputLines });
    expect(payload(result).outcome).toBe("created");
  });

  it.each(["quantity", "unitPrice", "totalPrice", "name", "description", "taxable", "linkedProductOrService"])("reports a %s mismatch with the created ID and never repeats the mutation", async field => {
    const observed: any = invoice();
    observed.lineItems.nodes[2][field] = ({ quantity: 1, unitPrice: 151, totalPrice: 150, name: "Different", description: "Changed", taxable: false, linkedProductOrService: { id: "foreign-product" } } as any)[field];
    const input: any = field === "linkedProductOrService" ? { ...args, line_items: [lines[0], lines[1], { ...lines[2], product_or_service_id: "product-1" }] } : args;
    const result = await setup(observed).invoke(input);
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ outcome: "partial_or_uncertain", invoice_id: "invoice-1", verification: "unverified" });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it.each(["missing", "extra", "truncated", "duplicate-id", "malformed"])("does not claim verified success for %s lines", async issue => {
    const observed: any = invoice();
    if (issue === "missing") observed.lineItems.nodes.pop();
    if (issue === "extra") observed.lineItems.nodes.push({ ...observed.lineItems.nodes[0], id: "extra" });
    if (issue === "truncated") observed.lineItems.pageInfo.hasNextPage = true;
    if (issue === "duplicate-id") observed.lineItems.nodes[1].id = observed.lineItems.nodes[0].id;
    if (issue === "malformed") observed.lineItems.nodes[2] = null;
    const result = await setup(observed).invoke();
    expect(payload(result)).toMatchObject({ outcome: "partial_or_uncertain", invoice_id: "invoice-1" });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it.each(["client", "job", "sent", "subject", "message"])("checks the %s after creation", async issue => {
    const observed: any = invoice();
    if (issue === "client") observed.client.id = "foreign-client";
    if (issue === "job") observed.jobs.nodes[0].id = "foreign-job";
    if (issue === "sent") observed.invoiceStatus = "awaiting_payment";
    if (issue === "subject") observed.subject = "Different";
    if (issue === "message") observed.message = "Different";
    const result = await setup(observed).invoke(issue === "message" ? { ...args, message: "Approved" } : args);
    expect(payload(result).outcome).toBe("partial_or_uncertain");
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("preserves returned invoices alongside Jobber userErrors", async () => {
    const result = await setup(invoice(), { invoice: invoice(), userErrors: [{ message: "Some fields were rejected", path: ["input"] }] }).invoke();
    expect(result.isError).toBe(true);
    expect(payload(result)).toMatchObject({ outcome: "partial_or_uncertain", invoice_id: "invoice-1", verification: "verified", user_errors: [{ message: "Some fields were rejected" }] });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("reports a business rejection without a created ID", async () => {
    const result = await setup(null, { invoice: null, userErrors: [{ message: "Invalid invoice" }] }).invoke();
    expect(payload(result).outcome).toBe("rejected");
    expect(read).toHaveBeenCalledTimes(3); expect(write).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "property-1"])("verifies standalone invoices with property %s", async property_id => {
    const observed = invoice();
    observed.jobs.nodes = [];
    if (!property_id) observed.properties.nodes = [];
    const { invoke } = setup(observed);
    defaultReads(observed);
    const result = await invoke({ ...args, job_id: undefined, property_id });
    expect(payload(result).outcome).toBe("created");
    expect(write.mock.calls[0][1].input).toMatchObject({ propertyId: property_id, jobId: undefined });
  });

  it("rejects a mismatched property in standalone invoice readback", async () => {
    const observed = invoice();
    observed.jobs.nodes = [];
    const { invoke } = setup(observed);
    read.mockResolvedValueOnce({ client: { ...clientPage().client, properties: [{ id: "approved-property" }] } });
    const result = await invoke({ ...args, job_id: undefined, property_id: "approved-property" });
    expect(payload(result)).toMatchObject({ outcome: "partial_or_uncertain", invoice_id: "invoice-1", destination_verified: false });
  });

  it("verifies all 100 approved lines without truncating the discount", async () => {
    const inputLines = [...Array.from({ length: 99 }, (_, i) => ({ name: `Charge ${i}`, quantity: 1, unit_price: 10, taxable: true })), lines[2]];
    const result = await setup(invoice(inputLines)).invoke({ ...args, line_items: inputLines });
    expect(payload(result).outcome).toBe("created");
    expect(payload(result).results).toHaveLength(100);
    expect(read.mock.calls[3][0]).toContain("lineItems(first:100)");
  });

  it("does not expose invoice writes in the safe default", () => {
    process.env.JOBBER_READ_ONLY = "true";
    const { handlers } = setup();
    expect(handlers.create_draft_invoice).toBeUndefined();
  });

  it("retains the invoice ID when readback fails", async () => {
    const { invoke } = setup();
    read.mockResolvedValueOnce(clientPage()).mockResolvedValueOnce(jobPage())
      .mockResolvedValueOnce({ taxRates: { nodes: taxRates, pageInfo: { hasNextPage: false } } })
      .mockRejectedValueOnce(new Error("Readback unavailable"));
    const result = await invoke();
    expect(payload(result)).toMatchObject({ outcome: "partial_or_uncertain", invoice_id: "invoice-1", verification_error: "Readback unavailable" });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("does not retry an ambiguous timeout or claim an invoice exists", async () => {
    const { invoke } = setup();
    write.mockReset().mockRejectedValueOnce(new Error("Mutation timed out"));
    const result = await invoke();
    expect(payload(result)).toMatchObject({ outcome: "partial_or_uncertain", mutation_error: "Mutation timed out" });
    expect(payload(result).invoice_id).toBeUndefined();
    expect(payload(result).guidance).toContain("search this client's invoices");
    expect(write).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledTimes(3);
    expect(audit.mock.calls[0][0].error_message).not.toContain("Mutation timed out");
  });

  it("retains an ID even when the mutation payload is incomplete", async () => {
    const result = await setup(invoice(), { invoice: invoice() }).invoke();
    expect(payload(result)).toMatchObject({ outcome: "partial_or_uncertain", invoice_id: "invoice-1", verification: "verified" });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("preserves the existing duplicate-job-invoice guard", async () => {
    const { invoke } = setup();
    read.mockResolvedValueOnce(clientPage()).mockResolvedValueOnce(jobPage([{ id: "existing" }]));
    const result = await invoke();
    expect(result.isError).toBe(true);
    expect(payload(result).error).toContain("already has an invoice");
    expect(write).not.toHaveBeenCalled();
  });

  it("defaults to explicit HST 13% and taxable lines, including the negative discount", async () => {
    const inputLines = lines.map(({ taxable: _taxable, ...line }) => line);
    const { invoke } = setup(invoice(inputLines as any));
    const result = await invoke({ ...args, line_items: inputLines });
    expect(payload(result)).toMatchObject({ outcome: "created", tax_mode: "hst_13", tax_verified: true, amounts_verified: true,
      expected_amounts: { subtotal: 170, tax: 22.1, total: 192.1 } });
    expect(write.mock.calls[0][1].input.tax).toEqual({ taxRateId: "hst-13", taxCalculationMethod: "EXCLUSIVE" });
    expect(write.mock.calls[0][1].input.lineItems.every((line: any) => line.taxable === true)).toBe(true);
  });

  it.each([true, false])("supports explicit no-tax invoices (zero rate present: %s)", async hasZero => {
    const noTaxLines = lines.map(line => ({ ...line, taxable: false }));
    const observed = invoice(noTaxLines);
    if (hasZero) observed.taxRate = { id: "zero", name: "No tax", tax: 0, components: [] };
    const { invoke } = setup(observed);
    read.mockResolvedValueOnce(clientPage()).mockResolvedValueOnce(jobPage())
      .mockResolvedValueOnce({ taxRates: { nodes: hasZero ? taxRates : [taxRates[0]], pageInfo: { hasNextPage: false } } });
    const result = await invoke({ ...args, tax_mode: "none", line_items: lines.map(({ taxable: _taxable, ...line }) => line) });
    expect(payload(result)).toMatchObject({ outcome: "created", tax_mode: "none", expected_amounts: { subtotal: 170, tax: 0, total: 170 } });
    expect(write.mock.calls[0][1].input.lineItems.every((line: any) => line.taxable === false)).toBe(true);
    expect(write.mock.calls[0][1].input.tax.taxRateId).toBe(hasZero ? "zero" : "hst-13");
  });

  it("rejects contradictory no-tax input before any API call", async () => {
    const result = await setup().invoke({ ...args, tax_mode: "none" });
    expect(result.isError).toBe(true);
    expect(payload(result).error_type).toBe("invalid_request");
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  });

  it("preserves explicitly exempt lines while applying HST to other lines", async () => {
    const mixed = [{ ...lines[0], taxable: false }, lines[1], lines[2]];
    const result = await setup(invoice(mixed)).invoke({ ...args, line_items: mixed });
    expect(payload(result)).toMatchObject({ outcome: "created", expected_amounts: { subtotal: 170, tax: -16.9, total: 153.1 } });
  });

  it.each(["subtotal", "taxAmount", "total", "invoiceBalance", "discountAmount", "legacyDiscountAmount", "depositAmount", "paymentsTotal", "tipsTotal"])("does not verify mismatched invoice %s", async field => {
    const observed: any = invoice();
    observed.amounts[field] += 1;
    const result = await setup(observed).invoke();
    expect(payload(result)).toMatchObject({ outcome: "partial_or_uncertain", amounts_verified: false, invoice_id: "invoice-1" });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("does not verify missing financial amounts", async () => {
    const observed: any = invoice(); observed.amounts = null;
    expect(payload(await setup(observed).invoke())).toMatchObject({ amounts_verified: false, outcome: "partial_or_uncertain" });
  });

  it.each(["2026-11-05T00:00:00Z", null, "invalid"])("rejects saved due date %s", async dueDate => {
    const observed: any = invoice(); observed.dueDate = dueDate;
    expect(payload(await setup(observed).invoke())).toMatchObject({ outcome: "partial_or_uncertain", header_verified: false, due_date_verified: false });
  });

  it("accepts equivalent due-date timestamp offsets", async () => {
    const observed = invoice(); observed.dueDate = "2026-10-04T20:00:00-04:00";
    expect(payload(await setup(observed).invoke())).toMatchObject({ outcome: "created", due_date_verified: true });
  });

  it.each(["id", "percent", "method"])("rejects a changed invoice tax %s", async field => {
    const observed: any = invoice();
    if (field === "id") observed.taxRate.id = "foreign-rate";
    if (field === "percent") observed.taxRate.tax = 5;
    if (field === "method") observed.taxCalculationMethod = "INCLUSIVE";
    expect(payload(await setup(observed).invoke())).toMatchObject({ outcome: "partial_or_uncertain", tax_verified: false });
  });

  it.each(["missing", "wrong-percent", "compound", "ambiguous", "foreign-id"])("fails closed for %s HST catalogue", async issue => {
    const rates: any[] = issue === "missing" ? [] : [{ ...taxRates[0] }];
    if (issue === "wrong-percent") rates[0].tax = 5;
    if (issue === "compound") rates[0].components = [{ id: "part", tax: 13 }];
    if (issue === "ambiguous") rates.push({ ...taxRates[0], id: "second", default: true });
    const { invoke } = setup();
    read.mockResolvedValueOnce(clientPage()).mockResolvedValueOnce(jobPage())
      .mockResolvedValueOnce({ taxRates: { nodes: rates, pageInfo: { hasNextPage: false } } });
    const result = await invoke({ ...args, ...(issue === "foreign-id" ? { tax_rate_id: "not-in-account" } : {}) });
    expect(result.isError).toBe(true); expect(write).not.toHaveBeenCalled();
  });

  it("finds HST beyond the first tax page instead of using a different default", async () => {
    const { invoke } = setup();
    read.mockResolvedValueOnce(clientPage()).mockResolvedValueOnce(jobPage())
      .mockResolvedValueOnce({ taxRates: { nodes: [{ ...taxRates[0], id: "gst", name: "GST", tax: 5 }], pageInfo: { hasNextPage: true, endCursor: "tax-2" } } })
      .mockResolvedValueOnce({ taxRates: { nodes: [taxRates[0]], pageInfo: { hasNextPage: false } } });
    expect(payload(await invoke()).outcome).toBe("created");
    expect(read.mock.calls[3][1]).toEqual({ after: "tax-2" });
  });

  it.each(["missing-page-info", "missing-cursor", "repeated-cursor", "scan-limit"])("blocks %s tax catalogue without writing", async issue => {
    const { invoke } = setup();
    read.mockResolvedValueOnce(clientPage()).mockResolvedValueOnce(jobPage());
    const page: any = { taxRates: { nodes: [], pageInfo: { hasNextPage: true, endCursor: "tax-2" } } };
    if (issue === "missing-page-info") delete page.taxRates.pageInfo;
    if (issue === "missing-cursor") delete page.taxRates.pageInfo.endCursor;
    if (issue === "scan-limit") {
      read.mockImplementation((_query: string, variables: any) => ({ taxRates: { nodes: [], pageInfo: { hasNextPage: true, endCursor: String(variables.after ? Number(variables.after) + 1 : 1) } } }));
    } else read.mockResolvedValueOnce(page).mockResolvedValueOnce(page);
    expect((await invoke()).isError).toBe(true); expect(write).not.toHaveBeenCalled();
  });

  it.each([1.5, -1.5])("verifies cent rounding for fractional quantity %s", async quantity => {
    const inputLines = [{ name: "Fractional charge/discount", quantity, unit_price: 0.01, taxable: true }];
    const observed: any = invoice(inputLines);
    const subtotal = quantity > 0 ? 0.02 : -0.02;
    observed.lineItems.nodes[0].totalPrice = subtotal;
    observed.amounts = { ...observed.amounts, subtotal, taxAmount: 0, total: subtotal, invoiceBalance: subtotal };
    expect(payload(await setup(observed).invoke({ ...args, line_items: inputLines })).outcome).toBe("created");
  });

  it.each([undefined, "", "   "])("requires a reviewed subject (%s) before duplicate checking", async subject => {
    const result = await setup().invoke({ ...args, subject });
    expect(result.validation_issues).toBeDefined();
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  });

  it("finds a matching draft on page two before mutation", async () => {
    const { invoke } = setup();
    read.mockResolvedValueOnce(clientPage(Array.from({ length: 50 }, (_, i) => ({ id: `old-${i}`, subject: "Other", invoiceStatus: "paid" })), true, "page-2"))
      .mockResolvedValueOnce(clientPage([{ id: "matching", subject: " repair ", invoiceStatus: "draft" }]));
    const result = await invoke();
    expect(payload(result).error).toContain("matching draft");
    expect(read.mock.calls[1][1].after).toBe("page-2"); expect(write).not.toHaveBeenCalled();
  });

  it.each(["missing-page-info", "missing-cursor", "repeated-cursor", "changed-version", "duplicate-id", "scan-limit"])("blocks %s duplicate preflight without writing", async issue => {
    const { invoke } = setup();
    const page: any = clientPage([{ id: "old", subject: "Other", invoiceStatus: "paid" }], true, "page-2");
    if (issue === "missing-page-info") delete page.client.invoices.pageInfo;
    if (issue === "missing-cursor") delete page.client.invoices.pageInfo.endCursor;
    if (issue === "scan-limit") read.mockImplementation((_query: string, variables: any) => {
      const n = variables.after ? Number(variables.after) : 0;
      return clientPage([{ id: `invoice-${n}`, subject: "Other", invoiceStatus: "paid" }], true, String(n + 1));
    });
    else {
      read.mockResolvedValueOnce(page);
      const next = clientPage([{ id: issue === "duplicate-id" ? "old" : "old-2", subject: "Other", invoiceStatus: "paid" }], issue === "repeated-cursor", "page-2");
      if (issue === "changed-version") next.client.updatedAt = "changed";
      read.mockResolvedValueOnce(next);
    }
    expect((await invoke()).isError).toBe(true); expect(write).not.toHaveBeenCalled();
  });

  it.each([
    [new JobberAuthenticationError("Token rejected"), "connection_unavailable", "connection_unavailable"],
    [new BudgetUnavailableError(10), "connection_unavailable", "connection_unavailable"],
    [new JobberGraphQLRequestError("Invalid tax input"), "rejected", "jobber_rejected"],
    [new JobberOutcomeUncertainError("Timeout after sending"), "partial_or_uncertain", "outcome_uncertain"],
  ])("preserves mutation exception classification: %s", async (error, outcome, error_type) => {
    const { invoke } = setup(); write.mockReset().mockRejectedValueOnce(error);
    expect(payload(await invoke())).toMatchObject({ outcome, error_type });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("retains created IDs and connection classification when verification fails", async () => {
    const { invoke } = setup();
    read.mockResolvedValueOnce(clientPage()).mockResolvedValueOnce(jobPage())
      .mockResolvedValueOnce({ taxRates: { nodes: taxRates, pageInfo: { hasNextPage: false } } })
      .mockRejectedValueOnce(new JobberAuthenticationError("Token rejected on read"));
    expect(payload(await invoke())).toMatchObject({ outcome: "partial_or_uncertain", error_type: "connection_unavailable", invoice_id: "invoice-1" });
    expect(write).toHaveBeenCalledTimes(1);
  });
});
