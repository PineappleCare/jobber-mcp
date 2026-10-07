import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { read, write, audit, executionError } = vi.hoisted(() => ({
  read: vi.fn(), write: vi.fn(), audit: vi.fn().mockResolvedValue(undefined), executionError: vi.fn(),
}));
vi.mock("../../jobber/client.js", () => ({ jobberGraphQL: read, jobberGraphQLWrite: write, hasMutationExecutionErrors: executionError }));
vi.mock("../../utils/auditLog.js", () => ({ appendAuditLog: audit }));
import { registerCreateJob } from "../jobs.js";
import { JobberAuthenticationError, JobberGraphQLRequestError, JobberOutcomeUncertainError } from "../../jobber/errors.js";

const oldEnv = { ...process.env };
const connection = (nodes: any[] = [], hasNextPage = false, endCursor: string | null = null) => ({ nodes, pageInfo: { hasNextPage, endCursor } });
const args = { property_id: "property-1", title: "Drain repair", instructions: "Repair and inspect", confirm_write: true };
const lines = [{ name: "Service", description: "Work", quantity: 1, unit_price: 300, taxable: true },
  { name: "ABS", quantity: 2, unit_price: 10, product_or_service_id: "product-1" }];
function job(overrides: Record<string, any> = {}) {
  return { id: "job-1", updatedAt: "v1", jobNumber: 1009, jobType: "ONE_OFF", billingType: "FIXED_PRICE",
    title: args.title, instructions: args.instructions, allowReviewRequest: false, client: { id: "client-1" }, property: { id: args.property_id },
    quote: null, request: null, startAt: null, endAt: null,
    invoiceSchedule: { billingFrequency: "ON_COMPLETION", recurrenceSchedule: null },
    visitSchedule: { recurrenceSchedule: null, assignedTo: connection() }, visits: connection(), lineItems: connection(), ...overrides };
}
function observedLines(input = lines) {
  return input.map((line, index) => ({ id: `line-${index}`, name: line.name, description: line.description ?? null,
    quantity: line.quantity, unitPrice: line.unit_price, taxable: line.taxable ?? false,
    linkedProductOrService: line.product_or_service_id ? { id: line.product_or_service_id } : null }));
}
function source(nodes: any[] = [], more = false, cursor: string | null = null) {
  return { property: { id: args.property_id, client: { id: "client-1" }, jobs: connection(nodes, more, cursor) } };
}
function setup() {
  let config: any, handler: any;
  registerCreateJob({ registerTool(_name: string, c: any, h: any) { config = c; handler = h; } } as any);
  return { config, async invoke(input: any = args) {
    const parsed = await config.inputSchema["~standard"].validate(input);
    return parsed.issues ? { isError: true, content: [{ text: JSON.stringify({ outcome: "invalid_request", issues: parsed.issues }) }] } : handler(parsed.value);
  } };
}
const unpack = (result: any) => JSON.parse(result.content[0].text);
beforeEach(() => {
  process.env.JOBBER_READ_ONLY = "false"; process.env.JOBBER_WRITE_CAPABILITIES = "records";
  read.mockReset(); write.mockReset(); audit.mockReset().mockResolvedValue(undefined); executionError.mockReset().mockReturnValue(false);
  read.mockImplementation(async (query: string) => {
    if (query.includes("JobCreationPreflight")) return source();
    if (query.includes("JobCreationDestination")) return source();
    if (query.includes("VerifyCreatedJob")) return { job: job() };
    if (query.includes("QuoteForJobCreation")) return { quote: { id: "quote-1", client: { id: "client-1" }, property: { id: args.property_id }, request: null, jobs: connection() } };
    if (query.includes("RequestForJobCreation")) return { request: { id: "request-1", requestStatus: "new", client: { id: "client-1" }, property: { id: args.property_id }, jobs: connection() } };
    throw new Error("Unexpected query");
  });
  write.mockResolvedValue({ jobCreate: { job: job(), userErrors: [] } });
});
afterEach(() => { process.env = { ...oldEnv }; });

describe("verified job creation", () => {
  it.each([{}, { job_type: "ONE_OFF", billing_type: "FIXED_PRICE", billing_schedule: "ON_COMPLETION" }])("creates a verified unscheduled one-off for %#", async patch => {
    const result = await setup().invoke({ ...args, ...patch });
    expect(unpack(result)).toMatchObject({ outcome: "created", job_id: "job-1", job_type: "ONE_OFF", billing_type: "FIXED_PRICE", billing_schedule: "ON_COMPLETION", schedule_mode: "unscheduled" });
    expect(result.isError).not.toBe(true); expect(write).toHaveBeenCalledTimes(1);
    const input = write.mock.calls[0][1].input;
    expect(input).toMatchObject({ invoicing: { invoicingType: "FIXED_PRICE", invoicingSchedule: "ON_COMPLETION" }, scheduling: { createVisits: false, notifyTeam: false }, allowReviewRequest: false, lineItems: [] });
    expect(input).not.toHaveProperty("timeframe"); expect(input.scheduling).not.toHaveProperty("recurrence");
    expect(audit.mock.calls.at(-1)?.[0]).toMatchObject({ outcome: "success", args: { job_type: "ONE_OFF", billing_type: "FIXED_PRICE", billing_schedule: "ON_COMPLETION", job_id: "job-1" } });
  });
  it("defaults instructions and quantity, verifies reordered lines and their links", async () => {
    const actual = job({ instructions: null, lineItems: connection(observedLines().reverse()) });
    read.mockResolvedValueOnce(source()).mockResolvedValueOnce(source()).mockResolvedValueOnce({ job: actual });
    const result = await setup().invoke({ ...args, instructions: undefined, line_items: [{ ...lines[0], quantity: undefined }, lines[1]] });
    expect(unpack(result).outcome).toBe("created"); expect(write.mock.calls[0][1].input.lineItems[0].quantity).toBe(1);
  });
  it("keeps explicit recurring/as-needed creation with reviewed billing", async () => {
    const actual = job({ jobType: "RECURRING", billingType: "VISIT_BASED", invoiceSchedule: { billingFrequency: "PER_VISIT", recurrenceSchedule: null } });
    read.mockResolvedValueOnce(source()).mockResolvedValueOnce(source()).mockResolvedValueOnce({ job: actual });
    expect(unpack(await setup().invoke({ ...args, job_type: "RECURRING", billing_type: "VISIT_BASED", billing_schedule: "PER_VISIT" })).outcome).toBe("created");
  });
  it.each([
    { billing_type: "VISIT_BASED" }, { billing_schedule: "PER_VISIT" }, { billing_schedule: "NEVER" },
    { job_type: "RECURRING" }, { job_type: "RECURRING", billing_type: "VISIT_BASED" },
    { job_type: "RECURRING", billing_schedule: "ON_COMPLETION" },
    { job_type: "RECURRING", billing_type: "FIXED_PRICE", billing_schedule: "ON_COMPLETION" },
    { job_type: "RECURRING", billing_type: "VISIT_BASED", billing_schedule: "PERIODIC" },
    { quote_id: "q", request_id: "r" }, { confirm_write: false }, { title: " " },
  ])("rejects contradictory or unapproved input %# before dispatch", async patch => {
    expect((await setup().invoke({ ...args, ...patch })).isError).toBe(true);
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  });
  it("finds duplicates beyond the first page", async () => {
    read.mockResolvedValueOnce(source([{ id: "other", title: "Other", jobStatus: "active" }], true, "next"))
      .mockResolvedValueOnce(source([{ id: "duplicate", title: " DRAIN   repair ", jobStatus: "active" }]));
    expect((await setup().invoke()).isError).toBe(true); expect(write).not.toHaveBeenCalled();
    expect(read.mock.calls[1][1].after).toBe("next");
  });
  it.each([source([], true, null), { property: null }, { property: { id: "foreign", client: { id: "client-1" }, jobs: connection() } },
    source([{ id: "bad", jobStatus: "active" }])])("blocks an incomplete or foreign preflight %#", async page => {
    read.mockResolvedValueOnce(page); expect((await setup().invoke()).isError).toBe(true); expect(write).not.toHaveBeenCalled();
  });
  it("blocks scans beyond the bound and repeated cursors", async () => {
    read.mockImplementation(async (_query, variables) => source([], true, variables.after ? "next" : "next"));
    expect((await setup().invoke()).isError).toBe(true); expect(read).toHaveBeenCalledTimes(2); expect(write).not.toHaveBeenCalled();
    read.mockReset().mockImplementation(async (_query, variables) => source([], true, String(Number(variables.after ?? 0) + 1)));
    expect((await setup().invoke()).isError).toBe(true); expect(read).toHaveBeenCalledTimes(10); expect(write).not.toHaveBeenCalled();
  });
  it("rechecks destination ownership before mutation", async () => {
    read.mockResolvedValueOnce(source()).mockResolvedValueOnce({ property: { id: args.property_id, client: { id: "foreign" } } });
    expect((await setup().invoke()).isError).toBe(true); expect(write).not.toHaveBeenCalled();
  });
  it.each(["quote", "request"])("blocks foreign and already-converted %s sources", async type => {
    for (const record of [null, { id: `${type}-1`, client: { id: "foreign" }, property: { id: args.property_id }, jobs: connection() },
      { id: `${type}-1`, requestStatus: "new", client: { id: "client-1" }, property: { id: args.property_id }, jobs: connection([{ id: "existing" }]) }]) {
      read.mockResolvedValueOnce(source()).mockResolvedValueOnce({ [type]: record });
      expect((await setup().invoke({ ...args, [`${type}_id`]: `${type}-1` })).isError).toBe(true); expect(write).not.toHaveBeenCalled();
    }
  });
  it.each(["quote", "request"])("verifies the requested %s source", async type => {
    const original = read.getMockImplementation()!;
    read.mockImplementation(async (q, vars) => q.includes("VerifyCreatedJob") ? { job: job({ [type]: { id: `${type}-1` } }) } : original(q, vars));
    expect(unpack(await setup().invoke({ ...args, [`${type}_id`]: `${type}-1` })).outcome).toBe("created");
  });
  it.each([
    { allowReviewRequest: true }, { allowReviewRequest: undefined },
    { jobType: "RECURRING" }, { property: { id: "foreign" } }, { client: { id: "foreign" } },
    { title: "Different" }, { instructions: "Different" }, { billingType: "VISIT_BASED" },
    { invoiceSchedule: { billingFrequency: "PER_VISIT", recurrenceSchedule: null } },
    { invoiceSchedule: { billingFrequency: "ON_COMPLETION", recurrenceSchedule: { calendarRule: "FREQ=MONTHLY" } } },
    { startAt: "2026-10-07T12:00:00Z" }, { endAt: "2026-10-07T12:00:00Z" },
    { visits: connection([{ id: "visit-1" }]) }, { visits: { nodes: "", pageInfo: { hasNextPage: false } } },
    { visitSchedule: { recurrenceSchedule: null, assignedTo: connection([{ id: "matt" }]) } },
    { quote: { id: "unrequested" } }, { request: { id: "unrequested" } }, { lineItems: connection([], true) },
  ])("retains the ID and reports uncertain on readback mismatch %#", async patch => {
    read.mockResolvedValueOnce(source()).mockResolvedValueOnce(source()).mockResolvedValueOnce({ job: job(patch) });
    expect(unpack(await setup().invoke())).toMatchObject({ outcome: "uncertain", job_id: "job-1", error_type: "outcome_uncertain" });
    expect(write).toHaveBeenCalledTimes(1); expect(audit.mock.calls.at(-1)?.[0].outcome).toBe("error");
  });
  it.each(["name", "description", "quantity", "unitPrice", "taxable", "linkedProductOrService"])("checks requested line %s", async field => {
    const actual = observedLines(); actual[field === "linkedProductOrService" ? 1 : 0][field] = "wrong";
    read.mockResolvedValueOnce(source()).mockResolvedValueOnce(source()).mockResolvedValueOnce({ job: job({ lineItems: connection(actual) }) });
    expect(unpack(await setup().invoke({ ...args, line_items: lines }))).toMatchObject({ outcome: "uncertain", job_id: "job-1" });
    expect(write).toHaveBeenCalledTimes(1);
  });
  it("does not lose a returned ID on malformed readback lines", async () => {
    read.mockResolvedValueOnce(source()).mockResolvedValueOnce(source()).mockResolvedValueOnce({ job: job({ lineItems: connection([null]) }) });
    expect(unpack(await setup().invoke({ ...args, line_items: lines }))).toMatchObject({ outcome: "uncertain", job_id: "job-1" });
  });
  it("retains partial created records alongside business errors", async () => {
    write.mockResolvedValue({ jobCreate: { job: job(), userErrors: [{ message: "Rejected field", path: ["instructions"] }] } });
    expect(unpack(await setup().invoke())).toMatchObject({ outcome: "uncertain", job_id: "job-1", user_errors: [{ message: "Rejected field" }] });
    expect(write).toHaveBeenCalledTimes(1);
  });
  it("returns business rejection when no record was returned", async () => {
    write.mockResolvedValue({ jobCreate: { job: null, userErrors: [{ message: "Bad title", path: ["title"] }] } });
    expect(unpack(await setup().invoke())).toMatchObject({ outcome: "rejected", error_type: "jobber_rejected" });
    expect(read).toHaveBeenCalledTimes(2); expect(write).toHaveBeenCalledTimes(1);
  });
  it("does not classify merged GraphQL execution errors as a definite rejection", async () => {
    executionError.mockReturnValue(true); write.mockResolvedValue({ jobCreate: { job: null, userErrors: [{ message: "Resolver failed" }] } });
    expect(unpack(await setup().invoke()).outcome).toBe("uncertain"); expect(write).toHaveBeenCalledTimes(1);
  });
  it("retains the returned ID after failed readback", async () => {
    read.mockResolvedValueOnce(source()).mockResolvedValueOnce(source()).mockRejectedValueOnce(new JobberAuthenticationError("expired"));
    expect(unpack(await setup().invoke())).toMatchObject({ outcome: "uncertain", job_id: "job-1", read_error: "expired" });
    expect(write).toHaveBeenCalledTimes(1);
  });
  it("reconciles ambiguous writes without replaying or claiming a candidate was created", async () => {
    write.mockRejectedValue(new JobberOutcomeUncertainError("Timed out"));
    read.mockResolvedValueOnce(source()).mockResolvedValueOnce(source()).mockResolvedValueOnce(source([{ id: "candidate", title: args.title, jobStatus: "active" }]));
    expect(unpack(await setup().invoke())).toMatchObject({ outcome: "uncertain", candidate_job_ids: ["candidate"] });
    expect(write).toHaveBeenCalledTimes(1);
  });
  it.each([new JobberAuthenticationError("expired"), new JobberGraphQLRequestError("bad input")])("classifies definite upstream failure %s", async error => {
    write.mockRejectedValue(error);
    expect(unpack(await setup().invoke()).outcome).toBe(error instanceof JobberAuthenticationError ? "connection_unavailable" : "rejected");
    expect(write).toHaveBeenCalledTimes(1); expect(read).toHaveBeenCalledTimes(2);
  });
});
