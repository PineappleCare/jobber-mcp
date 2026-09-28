import { beforeEach, describe, expect, it, vi } from "vitest";
const { read, write, audit } = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), audit: vi.fn() }));
vi.mock("../../jobber/client.js", () => ({ jobberGraphQL: read, jobberGraphQLWrite: write }));
vi.mock("../../utils/auditLog.js", () => ({ appendAuditLog: audit }));
import { registerJobLineItemDescriptions } from "../job-line-item-descriptions.js";

const args = { job_id: "job-1", expected_updated_at: "v1", line_items: [
  { line_item_id: "line-1", description: "Customer description" },
], confirm_write: true };
function line(description = "Internal note") {
  return { id: "line-1", description, name: "Labour", quantity: 2, unitPrice: 100,
    totalPrice: 200, taxable: true, unitCost: 50, category: "SERVICE", linkedProductOrService: { id: "product-1" } };
}
function job(lines = [line()], updatedAt = "v1") {
  return { job: { id: "job-1", updatedAt, jobberWebUri: "https://example.invalid/job-1",
    lineItems: { nodes: lines, pageInfo: { hasNextPage: false, endCursor: null } } } };
}
function setup() {
  let config: any, handler: any;
  vi.stubEnv("JOBBER_READ_ONLY", "false");
  vi.stubEnv("JOBBER_WRITE_CAPABILITIES", "records");
  registerJobLineItemDescriptions({ registerTool: (_n: string, c: any, h: any) => { config = c; handler = h; } } as any);
  return { config, handler };
}
beforeEach(() => {
  vi.unstubAllEnvs(); read.mockReset(); write.mockReset(); audit.mockReset().mockResolvedValue(undefined);
  read.mockResolvedValueOnce(job()).mockResolvedValueOnce({ job: { id: "job-1", updatedAt: "v1" } })
    .mockResolvedValueOnce(job([line("Customer description")], "v2"));
  write.mockResolvedValue({ jobEditLineItems: { job: { id: "job-1", updatedAt: "v2" },
    modifiedLineItems: [{ id: "line-1", description: "Customer description" }], userErrors: [] } });
});

describe("job description-only updates", () => {
  it("sends only approved descriptions and verifies unchanged financial fields", async () => {
    const { handler, config } = setup();
    const result = await handler(args);
    expect(result.isError).toBeUndefined();
    expect(JSON.parse(result.content[0].text)).toMatchObject({ outcome: "verified", record_version: "v2",
      results: [{ description_verified: true, other_fields_unchanged: true }] });
    expect(write).toHaveBeenCalledTimes(1);
    expect(write.mock.calls[0][1]).toEqual({ jobId: "job-1", input: { lineItems: [
      { lineItemId: "line-1", description: "Customer description" },
    ] } });
    expect(config.annotations.readOnlyHint).toBe(false);
  });
  it("requires confirmation and rejects financial fields in line inputs", async () => {
    const { config } = setup();
    for (const input of [{ ...args, confirm_write: false }, { ...args, line_items: [{ ...args.line_items[0], unit_price: 0 }] }]) {
      expect((await config.inputSchema["~standard"].validate(input)).issues).toBeDefined();
    }
    expect(write).not.toHaveBeenCalled();
  });
  it.each(["stale", "foreign", "duplicate", "changed-before-write"])("blocks %s selections before mutation", async kind => {
    const { handler } = setup();
    read.mockReset().mockResolvedValueOnce(kind === "foreign" ? job([]) : job([line()], kind === "stale" ? "v0" : "v1"))
      .mockResolvedValueOnce({ job: { id: "job-1", updatedAt: "v2" } });
    const input = kind === "duplicate" ? { ...args, line_items: [...args.line_items, ...args.line_items] } : args;
    expect((await handler(input)).isError).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });
  it("rejects incomplete verification fields before mutation", async () => {
    const { handler } = setup();
    read.mockReset().mockResolvedValueOnce(job([{ id: "line-1", description: "old" } as any]));
    expect((await handler(args)).isError).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });
  it("paginates membership beyond the first 50 lines", async () => {
    const { handler } = setup();
    const first = job([]); first.job.lineItems.pageInfo = { hasNextPage: true, endCursor: "cursor-1" } as any;
    read.mockReset().mockResolvedValueOnce(first).mockResolvedValueOnce(job())
      .mockResolvedValueOnce({ job: { id: "job-1", updatedAt: "v1" } })
      .mockResolvedValueOnce(job([line("Customer description")], "v2"));
    expect((await handler(args)).isError).toBeUndefined();
    expect(read.mock.calls[1][1].after).toBe("cursor-1");
  });
  it.each(["response-lost", "partial", "readback-failed", "price-changed"])("reconciles %s without retrying the mutation", async kind => {
    const { handler } = setup();
    if (kind === "response-lost") write.mockRejectedValueOnce(new Error("Connection closed after dispatch"));
    if (kind === "partial") write.mockResolvedValueOnce({ jobEditLineItems: { userErrors: [{ message: "Partial rejection", path: ["lineItems"] }] } });
    if (kind === "readback-failed" || kind === "price-changed") {
      read.mockReset().mockResolvedValueOnce(job()).mockResolvedValueOnce({ job: { id: "job-1", updatedAt: "v1" } });
      if (kind === "readback-failed") read.mockRejectedValueOnce(new Error("Read unavailable"));
      else read.mockResolvedValueOnce(job([{ ...line("Customer description"), unitPrice: 110 }], "v2"));
    }
    const result = await handler(args);
    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).outcome).toBe("partial_or_uncertain");
    expect(write).toHaveBeenCalledTimes(1);
    expect(read).toHaveBeenCalledTimes(3);
  });
});
