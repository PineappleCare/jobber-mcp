import { beforeEach, describe, expect, it, vi } from "vitest";
const { read, write, audit } = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), audit: vi.fn() }));
vi.mock("../../jobber/client.js", () => ({ jobberGraphQL: read, jobberGraphQLWrite: write }));
vi.mock("../../utils/auditLog.js", () => ({ appendAuditLog: audit }));
import { registerTimesheetTools } from "../timesheets.js";
import { JobberAuthenticationError, JobberGraphQLRequestError, JobberPermissionError } from "../../jobber/errors.js";

const dates = { start_date: "2026-10-08", end_date: "2026-10-08" };
const user = { id: "ryan", name: { full: "Ryan Example" }, status: "ACTIVATED" };
const job = { id: "job-1", jobNumber: 12, title: "Repair", jobberWebUri: "https://example.test/jobs/12" };
const page = (nodes: any[], more = false, cursor: string | null = null) => ({ nodes, pageInfo: { hasNextPage: more, endCursor: cursor } });
const entry = (patch: Record<string, any> = {}) => ({ id: "time-1", createdAt: "2026-10-08T14:00:00Z", updatedAt: "2026-10-08T14:00:00Z",
  startAt: "2026-10-08T11:00:00Z", endAt: "2026-10-08T14:00:00Z", finalDuration: 10800,
  ticking: false, approved: false, payable: true, label: null, note: "Private labour note", user, job,
  targetItem: { __typename: "Visit", id: "visit-1", title: "Inspection" }, ...patch });
function setup() {
  const handlers: Record<string, any> = {}, configs: Record<string, any> = {};
  registerTimesheetTools({ registerTool(name: string, config: any, handler: any) {
    configs[name] = config;
    handlers[name] = async (args: any) => {
      const parsed = await config.inputSchema["~standard"].validate(args);
      return parsed.issues ? { isError: true, content: [{ text: JSON.stringify({ issues: parsed.issues }) }] } : handler(parsed.value);
    };
  } } as any);
  return { handlers, configs };
}
const unpack = (r: any) => JSON.parse(r.content[0].text);
beforeEach(() => { read.mockReset(); write.mockReset(); audit.mockReset().mockResolvedValue(undefined); });

describe("native employee timesheet reads", () => {
  it("registers only read-only, bounded tools without payroll or mutation fields", () => {
    const { configs } = setup();
    expect(Object.keys(configs)).toEqual(["list_timesheet_users", "list_time_entries", "get_time_entry"]);
    for (const config of Object.values(configs)) expect(config.annotations.readOnlyHint).toBe(true);
  });
  it("reads the roster including deactivated staff, retaining pagination", async () => {
    read.mockResolvedValue({ timeSheetUsers: page([{ ...user, status: "DEACTIVATED" }], true, "next") });
    const result = unpack(await setup().handlers.list_timesheet_users({ ...dates, page_size: 1, cursor: "prior" }));
    expect(result).toMatchObject({ employees: [{ id: "ryan", status: "DEACTIVATED" }], has_more: true, next_cursor: "next" });
    expect(read).toHaveBeenCalledWith(expect.stringContaining("timeSheetUsers"), { start: dates.start_date, end: dates.end_date, first: 1, after: "prior" }, 500);
    expect(JSON.stringify(audit.mock.calls)).not.toContain("Ryan Example");
  });
  it("enforces the native seven-day roster limit before querying", async () => {
    expect((await setup().handlers.list_timesheet_users({ start_date: "2026-10-01", end_date: "2026-10-08" })).isError).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });
  it("reads Ryan's 7–10 a.m. entry as three recorded hours in the Toronto date range", async () => {
    read.mockResolvedValue({ timeSheetEntries: page([entry()]) });
    const result = unpack(await setup().handlers.list_time_entries({ ...dates, user_id: "ryan" }));
    expect(result).toMatchObject({ entries: [{ employee: { id: "ryan" }, recorded_duration_seconds: 10800, running: false, note: "Private labour note" }], has_more: false, selection: "entry_start_within_dates", timezone: "America/Toronto" });
    expect(read.mock.calls[0][1].filter).toEqual({ assignedTo: "ryan", startAt: { after: "2026-10-08T03:59:59.999Z", before: "2026-10-09T04:00:00.000Z" } });
    expect(JSON.stringify(audit.mock.calls)).not.toContain("Private labour note");
    expect(read.mock.calls[0][0]).not.toMatch(/labourRate|paidBy|mutation/);
    expect(write).not.toHaveBeenCalled();
  });
  it("uses the 23-hour local day at the DST spring transition", async () => {
    read.mockResolvedValue({ timeSheetEntries: page([]) });
    await setup().handlers.list_time_entries({ start_date: "2026-03-08", end_date: "2026-03-08" });
    expect(read.mock.calls[0][1].filter.startAt).toEqual({ after: "2026-03-08T04:59:59.999Z", before: "2026-03-09T04:00:00.000Z" });
  });
  it("accepts inclusive 31 days and the 25-hour fall transition", async () => {
    read.mockResolvedValue({ timeSheetEntries: page([]) });
    const r = await setup().handlers.list_time_entries({ start_date: "2026-11-01", end_date: "2026-12-01" });
    expect(r.isError).not.toBe(true);
    expect(read.mock.calls[0][1].filter.startAt).toEqual({ after: "2026-11-01T03:59:59.999Z", before: "2026-12-02T05:00:00.000Z" });
  });
  it("includes midnight, excludes the next midnight, and does not clip overnight durations", async () => {
    read.mockResolvedValue({ timeSheetEntries: page([
      entry({ startAt: "2026-10-08T04:00:00Z" }),
      entry({ id: "next", startAt: "2026-10-09T04:00:00Z" }),
      entry({ id: "overnight", startAt: "2026-10-08T23:00:00Z", endAt: "2026-10-09T07:00:00Z", finalDuration: 28800 }),
      entry({ id: "earlier", startAt: "2026-10-08T03:59:59Z" }),
    ]) });
    const r = unpack(await setup().handlers.list_time_entries(dates));
    expect(r.entries.map((e: any) => e.id)).toEqual(["time-1", "overnight"]);
    expect(r.entries[1].recorded_duration_seconds).toBe(28800);
  });
  it("reads a running timer without claiming zero or estimated recorded hours", async () => {
    read.mockResolvedValue({ timeSheetEntry: entry({ ticking: true, endAt: null, finalDuration: 0 }) });
    expect(unpack(await setup().handlers.get_time_entry({ entry_id: "time-1" })).entry).toMatchObject({ running: true, recorded_duration_seconds: null, end_at: null });
  });
  it("retains stopped duration-only entries, null targets, and general time without a job", async () => {
    read.mockResolvedValue({ timeSheetEntry: entry({ endAt: null, job: null, targetItem: null }) });
    expect(unpack(await setup().handlers.get_time_entry({ entry_id: "time-1" })).entry).toMatchObject({ recorded_duration_seconds: 10800, job: null, target: null, end_at: null });
  });
  it.each(["Visit", "Assessment", "Job"])("preserves native %s target links", async type => {
    read.mockResolvedValue({ timeSheetEntry: entry({ targetItem: { __typename: type, id: "target-1", title: "Work" } }) });
    expect(unpack(await setup().handlers.get_time_entry({ entry_id: "time-1" })).entry.target).toEqual({ type, id: "target-1", title: "Work" });
  });
  it("keeps an empty job-filtered page pageable and verifies the account's job", async () => {
    read.mockResolvedValueOnce({ job: { id: "requested-job" } }).mockResolvedValueOnce({ timeSheetEntries: page([entry()], true, "next") });
    const r = unpack(await setup().handlers.list_time_entries({ ...dates, job_id: "requested-job", cursor: "prior" }));
    expect(r).toMatchObject({ entries: [], has_more: true, next_cursor: "next", scanned_count: 1 });
    expect(read.mock.calls[1][1].after).toBe("prior");
  });
  it("returns the matching job without reporting other jobs on the page", async () => {
    read.mockResolvedValueOnce({ job: { id: "job-1" } }).mockResolvedValueOnce({ timeSheetEntries: page([entry(), entry({ id: "other", job: { ...job, id: "job-2" } })]) });
    const r = unpack(await setup().handlers.list_time_entries({ ...dates, job_id: "job-1" }));
    expect(r.entries.map((e: any) => e.id)).toEqual(["time-1"]);
    expect(r).not.toHaveProperty("total_hours");
  });
  it("rejects an unknown or foreign job before listing employee data", async () => {
    read.mockResolvedValueOnce({ job: null });
    expect((await setup().handlers.list_time_entries({ ...dates, job_id: "foreign" })).isError).toBe(true);
    expect(read).toHaveBeenCalledTimes(1);
  });
  it.each([null, entry({ id: "foreign" })])("rejects inaccessible or mismatching entry IDs %#", async record => {
    read.mockResolvedValue({ timeSheetEntry: record });
    const r = await setup().handlers.get_time_entry({ entry_id: "time-1" });
    expect(r.isError).toBe(true); expect(unpack(r)).not.toHaveProperty("entry");
  });
  it("does not disclose rows that violate an explicit employee filter", async () => {
    read.mockResolvedValue({ timeSheetEntries: page([entry({ user: { ...user, id: "other" } })]) });
    const r = await setup().handlers.list_time_entries({ ...dates, user_id: "ryan" });
    expect(r.isError).toBe(true); expect(JSON.stringify(r)).not.toContain("Private labour note");
  });
  it.each([
    { end_date: "2026-10-07" }, { end_date: "2026-11-08" }, { start_date: "2026-02-30" },
    { timezone: "Not/A_Zone" }, { page_size: 51 }, { user_id: " " }, { job_id: "" },
  ])("rejects invalid dates, timezone or scope inputs %# before API access", async patch => {
    expect((await setup().handlers.list_time_entries({ ...dates, ...patch })).isError).toBe(true);
    expect(read).not.toHaveBeenCalled();
  });
  it.each([new JobberPermissionError("Forbidden"), new JobberGraphQLRequestError("An object of type TimeSheetEntry was hidden due to permissions")])("reports inaccessible data rather than an empty timesheet %#", async error => {
    read.mockRejectedValue(error);
    const r = await setup().handlers.list_time_entries(dates);
    expect(r.isError).toBe(true); expect(unpack(r).error).toContain("No hours were verified");
    expect(unpack(r).error).not.toContain("Upgrade your Jobber plan");
    expect(unpack(r)).not.toHaveProperty("entries"); expect(read).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(audit.mock.calls)).not.toContain("hidden due");
  });
  it("preserves authentication failures rather than mislabelling a scope denial", async () => {
    read.mockRejectedValue(new JobberAuthenticationError("Expired token"));
    expect(unpack(await setup().handlers.list_time_entries(dates)).error_type).toBe("connection_unavailable");
  });
  it.each([
    undefined, { nodes: [], pageInfo: {} }, page([], true, null), page([], true, "prior"),
    page([entry(), entry()]), page([entry({ finalDuration: -1 })]), page([entry({ startAt: "bad" })]),
    page([entry({ user: undefined })]), page([entry({ targetItem: undefined })]), page([entry({ job: undefined })]),
  ])("fails closed on incomplete or inconsistent entries/pagination %#", async value => {
    read.mockResolvedValue({ timeSheetEntries: value });
    expect((await setup().handlers.list_time_entries({ ...dates, cursor: "prior" })).isError).toBe(true);
  });
  it("rejects malformed or duplicate roster users", async () => {
    for (const users of [[null], [user, user], [{ id: "bad" }]]) {
      read.mockResolvedValue({ timeSheetUsers: page(users) });
      expect((await setup().handlers.list_timesheet_users(dates)).isError).toBe(true);
    }
  });
});
