import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { mockRead, mockWrite, mockAudit } = vi.hoisted(() => ({
  mockRead: vi.fn(),
  mockWrite: vi.fn(),
  mockAudit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../jobber/client.js", () => ({
  jobberGraphQL: mockRead,
  jobberGraphQLWrite: mockWrite,
}));
vi.mock("../../utils/auditLog.js", () => ({ appendAuditLog: mockAudit }));

import { registerFoundationalTools } from "../foundations.js";

const originalReadOnly = process.env.JOBBER_READ_ONLY;
const originalCapabilities = process.env.JOBBER_WRITE_CAPABILITIES;

function fakeServer() {
  const handlers: Record<string, (args?: any) => Promise<any>> = {};
  const configs: Record<string, any> = {};
  return {
    handlers,
    configs,
    registerTool(name: string, config: any, handler: (args?: any) => Promise<any>) {
      configs[name] = config;
      handlers[name] = handler;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  if (originalReadOnly === undefined) delete process.env.JOBBER_READ_ONLY;
  else process.env.JOBBER_READ_ONLY = originalReadOnly;
  if (originalCapabilities === undefined) delete process.env.JOBBER_WRITE_CAPABILITIES;
  else process.env.JOBBER_WRITE_CAPABILITIES = originalCapabilities;
});

describe("foundational operations", () => {
  it("keeps the foundational read set available and annotated in the safe default", () => {
    delete process.env.JOBBER_READ_ONLY;
    delete process.env.JOBBER_WRITE_CAPABILITIES;
    const server = fakeServer();

    registerFoundationalTools(server as any);

    expect(Object.keys(server.handlers)).toEqual(["search_records", "get_record", "catalog_search", "team_list"]);
    for (const config of Object.values(server.configs)) {
      expect(config.annotations).toMatchObject({ readOnlyHint: true, openWorldHint: true });
    }
  });

  it("only exposes writes for explicitly enabled capabilities", () => {
    process.env.JOBBER_READ_ONLY = "false";
    process.env.JOBBER_WRITE_CAPABILITIES = "records";
    const server = fakeServer();

    registerFoundationalTools(server as any);

    expect(server.handlers.create_client).toBeTypeOf("function");
    expect(server.handlers.create_draft_quote).toBeTypeOf("function");
    expect(server.handlers.create_visit).toBeUndefined();
    expect(server.handlers.mark_invoice_sent).toBeUndefined();
    expect(server.configs.create_client.annotations).toMatchObject({ readOnlyHint: false, idempotentHint: false });
  });

  it("uses truthful status-only names for communication transitions", () => {
    process.env.JOBBER_READ_ONLY = "false";
    process.env.JOBBER_WRITE_CAPABILITIES = "communications";
    const server = fakeServer();
    registerFoundationalTools(server as any);

    expect(server.handlers.mark_quote_sent).toBeTypeOf("function");
    expect(server.handlers.mark_invoice_sent).toBeTypeOf("function");
    expect(server.handlers.send_quote).toBeUndefined();
    expect(server.handlers.send_invoice).toBeUndefined();
  });

  it("requires literal confirmation on every registered write", async () => {
    process.env.JOBBER_READ_ONLY = "false";
    process.env.JOBBER_WRITE_CAPABILITIES = "records,scheduling,communications";
    const server = fakeServer();
    registerFoundationalTools(server as any);

    for (const [name, config] of Object.entries(server.configs)) {
      if (config.annotations?.readOnlyHint !== false) continue;
      const result = await config.inputSchema["~standard"].validate({ confirm_write: false });
      expect(result.issues, name).toBeDefined();
      expect(config.annotations).toMatchObject({ openWorldHint: true, idempotentHint: false });
    }
  });

  it("paginates properties without returning more than page_size", async () => {
    mockRead.mockResolvedValue({
      clients: {
        nodes: [{ id: "client-1", name: "Client", properties: [{ id: "p1" }, { id: "p2" }, { id: "p3" }] }],
        pageInfo: { hasNextPage: false, endCursor: "client-1-cursor" },
      },
    });
    const server = fakeServer();
    registerFoundationalTools(server as any);

    const first = JSON.parse((await server.handlers.search_records({ record_type: "property", page_size: 2 })).content[0].text);
    const second = JSON.parse((await server.handlers.search_records({ record_type: "property", page_size: 2, cursor: first.next_cursor, returned_so_far: 2 })).content[0].text);

    expect(first.records.map((record: any) => record.id)).toEqual(["p1", "p2"]);
    expect(second.records.map((record: any) => record.id)).toEqual(["p3"]);
    expect(second.returned_so_far).toBe(3);
    expect(second.next_cursor).toBeUndefined();
  });

  it("returns the sole created property, rather than Jobber's enclosing list", async () => {
    process.env.JOBBER_READ_ONLY = "false";
    process.env.JOBBER_WRITE_CAPABILITIES = "records";
    mockRead.mockResolvedValueOnce({ client: { id: "client-1", properties: [] } });
    mockWrite.mockResolvedValueOnce({
        propertyCreate: { userErrors: [], properties: [{ id: "property-1", name: "Test property" }] },
      });
    const server = fakeServer();
    registerFoundationalTools(server as any);

    const result = await server.handlers.create_property({
      client_id: "client-1",
      address: { street1: "1 Test Street", city: "Toronto" },
      confirm_write: true,
    });

    expect(result.isError).not.toBe(true);
    expect(JSON.parse(result.content[0].text).record).toMatchObject({ id: "property-1" });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({
      tool: "create_property",
      args: expect.objectContaining({ action: "create_property", record_type: "property", record_id: "property-1", changed_fields: ["address"] }),
    }));
  });

  it("refuses a multi-property response as an ambiguous outcome", async () => {
    process.env.JOBBER_READ_ONLY = "false";
    process.env.JOBBER_WRITE_CAPABILITIES = "records";
    mockRead.mockResolvedValueOnce({ client: { id: "client-1", properties: [] } });
    mockWrite.mockResolvedValueOnce({
        propertyCreate: { userErrors: [], properties: [{ id: "property-1" }, { id: "property-2" }] },
      });
    const server = fakeServer();
    registerFoundationalTools(server as any);

    const result = await server.handlers.create_property({
      client_id: "client-1",
      address: { street1: "1 Test Street", city: "Toronto" },
      confirm_write: true,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("unexpected number of records");
  });

  it("rejects a property that does not belong to a request client before mutating", async () => {
    process.env.JOBBER_READ_ONLY = "false";
    process.env.JOBBER_WRITE_CAPABILITIES = "records";
    mockRead.mockResolvedValueOnce({ client: { id: "client-1", properties: [], requests: { nodes: [] } } });
    const server = fakeServer();
    registerFoundationalTools(server as any);

    const result = await server.handlers.create_request({ client_id: "client-1", property_id: "other-property", confirm_write: true });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("does not belong");
    expect(mockRead).toHaveBeenCalledTimes(1);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("refuses a multi-aspect visit update before any partial mutation", async () => {
    process.env.JOBBER_READ_ONLY = "false";
    process.env.JOBBER_WRITE_CAPABILITIES = "scheduling";
    const visit = {
      id: "visit-1", title: "Original", visitStatus: "SCHEDULED", isComplete: false,
      completedAt: null, startAt: null, endAt: null, instructions: null,
      job: { id: "job-1" }, client: { id: "client-1" }, assignedUsers: { nodes: [] },
    };
    mockRead.mockResolvedValueOnce({ visit });
    const server = fakeServer();
    registerFoundationalTools(server as any);
    const read = JSON.parse((await server.handlers.get_record({ record_type: "visit", record_id: "visit-1" })).content[0].text);
    mockRead.mockResolvedValueOnce({ visit });

    const result = await server.handlers.update_visit({
      visit_id: "visit-1", expected_record_version: read.record_version,
      title: "Changed", assigned_user_ids: ["user-1"], confirm_write: true,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("exactly one visit aspect");
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("creates and verifies a same-day Anytime visit using date-only Jobber values", async () => {
    process.env.JOBBER_READ_ONLY = "false";
    process.env.JOBBER_WRITE_CAPABILITIES = "scheduling";
    const visit = {
      id: "visit-1", title: "Rough-in", visitStatus: "SCHEDULED", isComplete: false,
      completedAt: null, allDay: true, startAt: "2026-09-18T00:00:00-04:00", endAt: "2026-09-18T00:00:00-04:00", instructions: null,
      job: { id: "job-1" }, client: { id: "client-1" }, assignedUsers: { nodes: [] },
    };
    const page = (nodes: any[]) => ({ job: { id: "job-1", jobStatus: "ACTIVE", visits: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } });
    mockRead.mockResolvedValueOnce(page([])).mockResolvedValueOnce(page([visit]));
    mockWrite.mockResolvedValueOnce({ visitCreate: { createdVisits: [visit], userErrors: [] } });
    const server = fakeServer();
    registerFoundationalTools(server as any);

    const result = await server.handlers.create_visit({
      job_id: "job-1", title: "Rough-in",
      schedule: { mode: "anytime", start_date: "2026-09-18", timezone: "America/Toronto" },
      assigned_user_ids: [], confirm_write: true,
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload).toMatchObject({ outcome: "created", results: [{ status: "created", verification: "verified", record: { schedule: { mode: "anytime" } } }] });
    expect(mockWrite.mock.calls[0][1].input.visits[0].schedule).toEqual({
      startAt: { date: "2026-09-18", timezone: "America/Toronto" },
      endAt: { date: "2026-09-18", timezone: "America/Toronto" },
      teamMemberIdsToAssign: [], notifyTeam: false,
    });
  });

  it("keeps legacy date-only inputs as Anytime instead of treating them as midnight", async () => {
    process.env.JOBBER_READ_ONLY = "false";
    process.env.JOBBER_WRITE_CAPABILITIES = "scheduling";
    const visit = { id: "visit-legacy", title: "Legacy", allDay: true, startAt: "2026-09-18T00:00:00-04:00", endAt: "2026-09-18T00:00:00-04:00", assignedUsers: { nodes: [] } };
    const page = (nodes: any[]) => ({ job: { id: "job-1", jobStatus: "ACTIVE", visits: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } });
    mockRead.mockResolvedValueOnce(page([])).mockResolvedValueOnce(page([visit]));
    mockWrite.mockResolvedValueOnce({ visitCreate: { createdVisits: [visit], userErrors: [] } });
    const server = fakeServer();
    registerFoundationalTools(server as any);

    const result = await server.handlers.create_visit({
      job_id: "job-1", title: "Legacy",
      start_at: { date: "2026-09-18", timezone: "America/Toronto" },
      end_at: { date: "2026-09-18", timezone: "America/Toronto" },
      assigned_user_ids: [], confirm_write: true,
    });

    expect(JSON.parse(result.content[0].text).outcome).toBe("created");
  });

  it("creates six assigned Anytime visits in one mutation and verifies each result", async () => {
    process.env.JOBBER_READ_ONLY = "false";
    process.env.JOBBER_WRITE_CAPABILITIES = "scheduling";
    const dates = ["2026-09-18", "2026-09-21", "2026-09-22", "2026-09-23", "2026-09-24", "2026-09-25"];
    const users = [{ id: "matt" }, { id: "ryan" }];
    const visits = dates.map((date, index) => ({ id: `visit-${index}`, title: "Rough-in", allDay: true, startAt: `${date}T00:00:00-04:00`, endAt: `${date}T00:00:00-04:00`, assignedUsers: { nodes: users } }));
    const page = (nodes: any[]) => ({ job: { id: "job-1", jobStatus: "ACTIVE", visits: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } });
    mockRead
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce({ users: { nodes: users.map((user) => ({ ...user, availableForScheduling: true, status: "ACTIVATED" })), pageInfo: { hasNextPage: false, endCursor: null } } })
      .mockResolvedValueOnce(page(visits));
    mockWrite.mockResolvedValueOnce({ visitCreate: { createdVisits: visits, userErrors: [] } });
    const server = fakeServer();
    registerFoundationalTools(server as any);

    const result = await server.handlers.create_visits({
      job_id: "job-1",
      visits: dates.map((date) => ({ title: "Rough-in", schedule: { mode: "anytime", start_date: date, timezone: "America/Toronto" }, assigned_user_ids: ["matt", "ryan"] })),
      confirm_write: true,
    });

    const payload = JSON.parse(result.content[0].text);
    expect(payload.outcome).toBe("created");
    expect(payload.results).toHaveLength(6);
    expect(payload.results.every((item: any) => item.verification === "verified")).toBe(true);
    expect(mockWrite.mock.calls.filter(([query]) => query.includes("mutation CreateVisits"))).toHaveLength(1);
  });

  it("requires every batch item to state its schedule mode explicitly", async () => {
    process.env.JOBBER_READ_ONLY = "false";
    process.env.JOBBER_WRITE_CAPABILITIES = "scheduling";
    const server = fakeServer();
    registerFoundationalTools(server as any);

    const result = await server.configs.create_visits.inputSchema["~standard"].validate({
      job_id: "job-1",
      visits: [{ title: "Missing schedule" }],
      confirm_write: true,
    });

    expect(result.issues?.map((issue: any) => issue.message).join(" ")).toContain("explicit schedule mode");
    expect(mockRead).not.toHaveBeenCalled();
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("rejects deactivated team members before mutation", async () => {
    process.env.JOBBER_READ_ONLY = "false";
    process.env.JOBBER_WRITE_CAPABILITIES = "scheduling";
    const page = { job: { id: "job-1", jobStatus: "ACTIVE", visits: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } };
    mockRead
      .mockResolvedValueOnce(page)
      .mockResolvedValueOnce({ users: { nodes: [{ id: "former", availableForScheduling: true, status: "DEACTIVATED" }], pageInfo: { hasNextPage: false, endCursor: null } } });
    const server = fakeServer();
    registerFoundationalTools(server as any);

    const result = await server.handlers.create_visit({
      job_id: "job-1",
      schedule: { mode: "anytime", start_date: "2026-09-18", timezone: "America/Toronto" },
      assigned_user_ids: ["former"],
      confirm_write: true,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("unavailable for scheduling");
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("compares Anytime readback dates in the requested timezone", async () => {
    process.env.JOBBER_READ_ONLY = "false";
    process.env.JOBBER_WRITE_CAPABILITIES = "scheduling";
    const visit = { id: "visit-zone", title: "Evening UTC", allDay: true, startAt: "2026-09-19T02:00:00Z", endAt: "2026-09-19T02:00:00Z", assignedUsers: { nodes: [] } };
    const page = (nodes: any[]) => ({ job: { id: "job-1", jobStatus: "ACTIVE", visits: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } });
    mockRead.mockResolvedValueOnce(page([])).mockResolvedValueOnce(page([visit]));
    mockWrite.mockResolvedValueOnce({ visitCreate: { createdVisits: [visit], userErrors: [] } });
    const server = fakeServer();
    registerFoundationalTools(server as any);

    const result = await server.handlers.create_visit({
      job_id: "job-1",
      title: "Evening UTC",
      schedule: { mode: "anytime", start_date: "2026-09-18", timezone: "America/Toronto" },
      assigned_user_ids: [],
      confirm_write: true,
    });

    expect(JSON.parse(result.content[0].text)).toMatchObject({ outcome: "created", results: [{ verification: "verified" }] });
  });

  it("reports partial batch results without discarding created visit IDs", async () => {
    process.env.JOBBER_READ_ONLY = "false";
    process.env.JOBBER_WRITE_CAPABILITIES = "scheduling";
    const visit = { id: "visit-1", title: "First", allDay: true, startAt: "2026-09-18T00:00:00-04:00", endAt: "2026-09-18T00:00:00-04:00", assignedUsers: { nodes: [] } };
    const page = (nodes: any[]) => ({ job: { id: "job-1", jobStatus: "ACTIVE", visits: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } });
    mockRead.mockResolvedValueOnce(page([])).mockResolvedValueOnce(page([visit]));
    mockWrite.mockResolvedValueOnce({
      visitCreate: { createdVisits: [visit], userErrors: [{ message: "Invalid second visit", path: ["input", "visits", "1"] }] },
    });
    const server = fakeServer();
    registerFoundationalTools(server as any);

    const result = await server.handlers.create_visits({
      job_id: "job-1", confirm_write: true,
      visits: [
        { title: "First", schedule: { mode: "anytime", start_date: "2026-09-18", timezone: "America/Toronto" }, assigned_user_ids: [] },
        { title: "Second", schedule: { mode: "anytime", start_date: "2026-09-19", timezone: "America/Toronto" }, assigned_user_ids: [] },
      ],
    });

    expect(JSON.parse(result.content[0].text)).toMatchObject({ outcome: "partial", results: [
      { input_index: 0, status: "created", verification: "verified", record: { id: "visit-1" } },
      { input_index: 1, status: "rejected" },
    ] });
    expect(result.isError).toBe(true);
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "partial", result_count: 1 }));
  });

  it("reports every returned record even when it cannot match an input", async () => {
    process.env.JOBBER_READ_ONLY = "false";
    process.env.JOBBER_WRITE_CAPABILITIES = "scheduling";
    const unexpected = { id: "visit-unmatched", title: "Unexpected", allDay: true, startAt: "2026-09-20T00:00:00-04:00", endAt: "2026-09-20T00:00:00-04:00", assignedUsers: { nodes: [] } };
    const page = (nodes: any[]) => ({ job: { id: "job-1", jobStatus: "ACTIVE", visits: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } });
    mockRead.mockResolvedValueOnce(page([])).mockResolvedValueOnce(page([unexpected]));
    mockWrite.mockResolvedValueOnce({ visitCreate: { createdVisits: [unexpected], userErrors: [] } });
    const server = fakeServer();
    registerFoundationalTools(server as any);

    const result = await server.handlers.create_visit({
      job_id: "job-1",
      schedule: { mode: "anytime", start_date: "2026-09-18", timezone: "America/Toronto" },
      assigned_user_ids: [],
      confirm_write: true,
    });
    const payload = JSON.parse(result.content[0].text);

    expect(result.isError).toBe(true);
    expect(payload).toMatchObject({
      outcome: "partial",
      results: [{ status: "uncertain" }],
      unmatched_created_records: [{ id: "visit-unmatched" }],
    });
  });

  it("does not call a batch complete when Jobber returns user errors alongside every record", async () => {
    process.env.JOBBER_READ_ONLY = "false";
    process.env.JOBBER_WRITE_CAPABILITIES = "scheduling";
    const visit = { id: "visit-1", title: "First", allDay: true, startAt: "2026-09-18T00:00:00-04:00", endAt: "2026-09-18T00:00:00-04:00", assignedUsers: { nodes: [] } };
    const page = (nodes: any[]) => ({ job: { id: "job-1", jobStatus: "ACTIVE", visits: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } });
    mockRead.mockResolvedValueOnce(page([])).mockResolvedValueOnce(page([visit]));
    mockWrite.mockResolvedValueOnce({ visitCreate: { createdVisits: [visit], userErrors: [{ message: "Global warning", path: [] }] } });
    const server = fakeServer();
    registerFoundationalTools(server as any);

    const result = await server.handlers.create_visit({
      job_id: "job-1",
      title: "First",
      schedule: { mode: "anytime", start_date: "2026-09-18", timezone: "America/Toronto" },
      assigned_user_ids: [],
      confirm_write: true,
    });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text)).toMatchObject({ outcome: "partial", user_errors: [{ message: "Global warning" }] });
    expect(mockAudit).toHaveBeenCalledWith(expect.objectContaining({ outcome: "partial" }));
  });

  it("rejects nonexistent and ambiguous local times before calling Jobber", async () => {
    process.env.JOBBER_READ_ONLY = "false";
    process.env.JOBBER_WRITE_CAPABILITIES = "scheduling";
    const server = fakeServer();
    registerFoundationalTools(server as any);

    const nonexistent = await server.handlers.create_visit({ job_id: "job-1", schedule: { mode: "timed", start_date: "2026-03-08", start_time: "02:30", end_date: "2026-03-08", end_time: "03:30", timezone: "America/Toronto" }, assigned_user_ids: [], confirm_write: true });
    const ambiguous = await server.handlers.create_visit({ job_id: "job-1", schedule: { mode: "timed", start_date: "2026-11-01", start_time: "01:30", end_date: "2026-11-01", end_time: "02:30", timezone: "America/Toronto" }, assigned_user_ids: [], confirm_write: true });

    expect(nonexistent.isError).toBe(true);
    expect(nonexistent.content[0].text).toContain("does not exist");
    expect(ambiguous.isError).toBe(true);
    expect(ambiguous.content[0].text).toContain("ambiguous");
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("does not retry a batch mutation whose outcome is unknown", async () => {
    process.env.JOBBER_READ_ONLY = "false";
    process.env.JOBBER_WRITE_CAPABILITIES = "scheduling";
    const page = { job: { id: "job-1", jobStatus: "ACTIVE", visits: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } } };
    mockRead.mockResolvedValueOnce(page);
    mockWrite.mockRejectedValueOnce(new Error("Jobber server error; outcome is unknown"));
    const server = fakeServer();
    registerFoundationalTools(server as any);

    const result = await server.handlers.create_visits({ job_id: "job-1", visits: [{ title: "First", schedule: { mode: "anytime", start_date: "2026-09-18", timezone: "America/Toronto" }, assigned_user_ids: [] }], confirm_write: true });

    expect(result.isError).toBe(true);
    expect(JSON.parse(result.content[0].text).outcome).toBe("uncertain");
    expect(mockRead).toHaveBeenCalledTimes(1);
    expect(mockWrite).toHaveBeenCalledTimes(1);
  });

  it("finds a duplicate visit beyond the first preflight page", async () => {
    process.env.JOBBER_READ_ONLY = "false";
    process.env.JOBBER_WRITE_CAPABILITIES = "scheduling";
    const connection = (nodes: any[], hasNextPage: boolean, endCursor: string | null) => ({ job: { id: "job-1", jobStatus: "ACTIVE", visits: { nodes, pageInfo: { hasNextPage, endCursor } } } });
    mockRead
      .mockResolvedValueOnce(connection([{ id: "other", allDay: true, startAt: "2026-09-17T00:00:00-04:00", endAt: "2026-09-17T00:00:00-04:00" }], true, "next"))
      .mockResolvedValueOnce(connection([{ id: "duplicate", allDay: true, startAt: "2026-09-18T00:00:00-04:00", endAt: "2026-09-18T00:00:00-04:00" }], false, null));
    const server = fakeServer();
    registerFoundationalTools(server as any);

    const result = await server.handlers.create_visit({ job_id: "job-1", title: "Rough-in", schedule: { mode: "anytime", start_date: "2026-09-18", timezone: "America/Toronto" }, assigned_user_ids: [], confirm_write: true });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("already exists");
    expect(mockRead).toHaveBeenCalledTimes(2);
    expect(mockWrite).not.toHaveBeenCalled();
  });

  it("preserves assignments when creating an unscheduled visit", async () => {
    process.env.JOBBER_READ_ONLY = "false";
    process.env.JOBBER_WRITE_CAPABILITIES = "scheduling";
    const user = { id: "matt" };
    const visit = { id: "visit-unscheduled", title: "Schedule later", allDay: false, startAt: null, endAt: null, assignedUsers: { nodes: [user] } };
    const page = (nodes: any[]) => ({ job: { id: "job-1", jobStatus: "ACTIVE", visits: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } });
    mockRead
      .mockResolvedValueOnce(page([]))
      .mockResolvedValueOnce({ users: { nodes: [{ ...user, availableForScheduling: true, status: "ACTIVATED" }], pageInfo: { hasNextPage: false, endCursor: null } } })
      .mockResolvedValueOnce(page([visit]));
    mockWrite.mockResolvedValueOnce({ visitCreate: { createdVisits: [visit], userErrors: [] } });
    const server = fakeServer();
    registerFoundationalTools(server as any);

    const result = await server.handlers.create_visit({ job_id: "job-1", title: "Schedule later", schedule: { mode: "unscheduled" }, assigned_user_ids: ["matt"], confirm_write: true });

    expect(JSON.parse(result.content[0].text).outcome).toBe("created");
    expect(mockWrite.mock.calls[0][1].input.visits[0].schedule).toEqual({ teamMemberIdsToAssign: ["matt"], notifyTeam: false });
  });

  it("updates a reviewed visit to Anytime and returns an explicit schedule mode", async () => {
    process.env.JOBBER_READ_ONLY = "false";
    process.env.JOBBER_WRITE_CAPABILITIES = "scheduling";
    const before = { id: "visit-1", title: "Visit", visitStatus: "SCHEDULED", isComplete: false, completedAt: null, allDay: false, startAt: "2026-09-18T13:00:00-04:00", endAt: "2026-09-18T14:00:00-04:00", instructions: null, job: { id: "job-1" }, client: { id: "client-1" }, assignedUsers: { nodes: [] } };
    const after = { ...before, allDay: true, startAt: "2026-09-18T00:00:00-04:00", endAt: "2026-09-18T00:00:00-04:00" };
    mockRead.mockResolvedValueOnce({ visit: before });
    const server = fakeServer();
    registerFoundationalTools(server as any);
    const read = JSON.parse((await server.handlers.get_record({ record_type: "visit", record_id: "visit-1" })).content[0].text);
    mockRead.mockResolvedValueOnce({ visit: before });
    mockWrite.mockResolvedValueOnce({ visitEditSchedule: { visit: after, userErrors: [] } });

    const result = await server.handlers.update_visit({ visit_id: "visit-1", expected_record_version: read.record_version, schedule: { mode: "anytime", start_date: "2026-09-18", timezone: "America/Toronto" }, confirm_write: true });

    expect(JSON.parse(result.content[0].text).record.schedule.mode).toBe("anytime");
    expect(mockWrite.mock.calls[0][1].input).toEqual({ startAt: { date: "2026-09-18", timezone: "America/Toronto" }, endAt: { date: "2026-09-18", timezone: "America/Toronto" } });
  });
});
