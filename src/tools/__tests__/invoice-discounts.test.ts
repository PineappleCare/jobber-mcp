import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { read, write, audit } = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), audit: vi.fn() }));
vi.mock("../../jobber/client.js", () => ({ jobberGraphQL: read, jobberGraphQLWrite: write }));
vi.mock("../../utils/auditLog.js", () => ({ appendAuditLog: audit }));
import { registerFoundationalTools } from "../foundations.js";

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
    amounts: { total: 192.1, invoiceBalance: 192.1 },
    lineItems: { nodes: inputLines.map((line, index) => ({
      id: `line-${index}`, name: line.name, description: line.description ?? "", quantity: line.quantity,
      unitPrice: line.unit_price, totalPrice: line.quantity * line.unit_price, taxable: line.taxable, linkedProductOrService: null,
    })), pageInfo: { hasNextPage: false } },
  };
}
function setup(observed: any = invoice(), mutation: any = { invoice: invoice(), userErrors: [] }) {
  const handlers: Record<string, any> = {}, configs: Record<string, any> = {};
  registerFoundationalTools({ registerTool(name: string, config: any, handler: any) { configs[name] = config; handlers[name] = handler; } } as any);
  read.mockResolvedValueOnce({ client: { id: "client-1", properties: [{ id: "property-1" }], invoices: { nodes: [] } } })
    .mockResolvedValueOnce({ job: { id: "job-1", client: { id: "client-1" }, invoices: { nodes: [] } } })
    .mockResolvedValueOnce({ invoice: observed });
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
    expect(read.mock.calls[2][0]).toContain("VerifyCreatedInvoice");
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
    expect(read).toHaveBeenCalledTimes(2); expect(write).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "property-1"])("verifies standalone invoices with property %s", async property_id => {
    const observed = invoice();
    observed.jobs.nodes = [];
    if (!property_id) observed.properties.nodes = [];
    const { invoke } = setup(observed);
    read.mockReset().mockResolvedValueOnce({ client: { id: "client-1", properties: [{ id: "property-1" }], invoices: { nodes: [] } } })
      .mockResolvedValueOnce({ invoice: observed });
    const result = await invoke({ ...args, job_id: undefined, property_id });
    expect(payload(result).outcome).toBe("created");
    expect(write.mock.calls[0][1].input).toMatchObject({ propertyId: property_id, jobId: undefined });
  });

  it("rejects a mismatched property in standalone invoice readback", async () => {
    const observed = invoice();
    observed.jobs.nodes = [];
    const { invoke } = setup(observed);
    read.mockReset().mockResolvedValueOnce({ client: { id: "client-1", properties: [{ id: "approved-property" }], invoices: { nodes: [] } } })
      .mockResolvedValueOnce({ invoice: observed });
    const result = await invoke({ ...args, job_id: undefined, property_id: "approved-property" });
    expect(payload(result)).toMatchObject({ outcome: "partial_or_uncertain", invoice_id: "invoice-1", destination_verified: false });
  });

  it("verifies all 100 approved lines without truncating the discount", async () => {
    const inputLines = [...Array.from({ length: 99 }, (_, i) => ({ name: `Charge ${i}`, quantity: 1, unit_price: 10, taxable: true })), lines[2]];
    const result = await setup(invoice(inputLines)).invoke({ ...args, line_items: inputLines });
    expect(payload(result).outcome).toBe("created");
    expect(payload(result).results).toHaveLength(100);
    expect(read.mock.calls[2][0]).toContain("lineItems(first:100)");
  });

  it("does not expose invoice writes in the safe default", () => {
    process.env.JOBBER_READ_ONLY = "true";
    const { handlers } = setup();
    expect(handlers.create_draft_invoice).toBeUndefined();
  });

  it("retains the invoice ID when readback fails", async () => {
    const { invoke } = setup();
    read.mockReset().mockResolvedValueOnce({ client: { id: "client-1", properties: [], invoices: { nodes: [] } } })
      .mockResolvedValueOnce({ job: { client: { id: "client-1" }, invoices: { nodes: [] } } })
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
    expect(write).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledTimes(2);
    expect(audit.mock.calls[0][0].error_message).not.toContain("Mutation timed out");
  });

  it("retains an ID even when the mutation payload is incomplete", async () => {
    const result = await setup(invoice(), { invoice: invoice() }).invoke();
    expect(payload(result)).toMatchObject({ outcome: "partial_or_uncertain", invoice_id: "invoice-1", verification: "verified" });
    expect(write).toHaveBeenCalledTimes(1);
  });

  it("preserves the existing duplicate-job-invoice guard", async () => {
    const { invoke } = setup();
    read.mockReset().mockResolvedValueOnce({ client: { id: "client-1", properties: [], invoices: { nodes: [] } } })
      .mockResolvedValueOnce({ job: { client: { id: "client-1" }, invoices: { nodes: [{ id: "existing" }] } } });
    const result = await invoke();
    expect(result.isError).toBe(true);
    expect(payload(result).error).toContain("already has an invoice");
    expect(write).not.toHaveBeenCalled();
  });
});
