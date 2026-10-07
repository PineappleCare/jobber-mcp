import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const { read, write, audit } = vi.hoisted(() => ({ read: vi.fn(), write: vi.fn(), audit: vi.fn().mockResolvedValue(undefined) }));
vi.mock("../../jobber/client.js", () => ({ jobberGraphQL: read, jobberGraphQLWrite: write }));
vi.mock("../../utils/auditLog.js", () => ({ appendAuditLog: audit }));
import { registerTaskTools, taskVersion } from "../tasks.js";
import { registerFoundationalTools } from "../foundations.js";
import { JobberOutcomeUncertainError } from "../../jobber/errors.js";

const oldEnv = { ...process.env };
function task(overrides: Record<string, any> = {}) {
  return { id: "task-1", title: "Drop off filter", instructions: "", allDay: true,
    startAt: "2026-10-07T04:00:00Z", endAt: "2026-10-08T03:59:59Z", isComplete: false, isRecurring: false,
    teamReminderOffset: -1, client: { id: "client-1" }, property: null, workObject: null,
    assignedUsers: { nodes: [{ id: "matt" }], pageInfo: { hasNextPage: false } }, ...overrides };
}
function page(nodes: any[], more = false, cursor: string | null = null) {
  return { tasks: { nodes, totalCount: nodes.length, pageInfo: { hasNextPage: more, endCursor: cursor } } };
}
function setup() {
  const handlers: Record<string, any> = {}, configs: Record<string, any> = {};
  const server = { registerTool(name: string, config: any, handler: any) {
    configs[name] = config;
    handlers[name] = async (args: any) => { const parsed = await config.inputSchema["~standard"].validate(args);
      return parsed.issues ? { isError: true, content: [{ text: JSON.stringify({ error: "schema", issues: parsed.issues }) }] } : handler(parsed.value); };
  } };
  registerTaskTools(server as any);
  return { server, handlers, configs };
}
const createArgs = { title: "Drop off filter", client_id: "client-1", schedule: { mode: "anytime", start_date: "2026-10-07" }, assigned_user_ids: ["matt"], notify_team: true, confirm_write: true };
const unpack = (r: any) => JSON.parse(r.content[0].text);
beforeEach(() => {
  process.env.JOBBER_READ_ONLY = "false"; process.env.JOBBER_WRITE_CAPABILITIES = "scheduling,records";
  read.mockReset(); write.mockReset(); audit.mockClear();
  read.mockImplementation(async (query: string) => {
    if (query.includes("TaskClient")) return { client: { id: "client-1" } };
    if (query.includes("SchedulableUsers")) return { users: { nodes: [{ id: "matt", status: "ACTIVATED", availableForScheduling: true }], pageInfo: { hasNextPage: false } } };
    if (query.includes("ListTasks")) return page([]);
    if (query.includes("GetTask")) return { task: task() };
    throw new Error("Unexpected read: " + query);
  });
  write.mockResolvedValue({ taskCreate: { task: task(), userErrors: [] } });
});
afterEach(() => { process.env = { ...oldEnv }; });

describe("native tasks", () => {
  it("withholds task writes without the scheduling capability", () => {
    process.env.JOBBER_WRITE_CAPABILITIES = "records";
    expect(Object.keys(setup().handlers)).toEqual(["list_tasks", "get_task"]);
    process.env.JOBBER_WRITE_CAPABILITIES = "scheduling"; process.env.JOBBER_READ_ONLY = "true";
    expect(Object.keys(setup().handlers)).toEqual(["list_tasks", "get_task"]);
  });
  it("lists paginated tasks with versions", async () => {
    read.mockResolvedValueOnce(page([task()], true, "next"));
    const r = unpack(await setup().handlers.list_tasks({ page_size: 1, cursor: "prior" }));
    expect(r.next_cursor).toBe("next"); expect(r.tasks[0].task_version).toBe(taskVersion(task()));
    expect(read).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ first: 1, after: "prior" }), 800);
  });
  it("creates a same-day all-day task with exact assignments and email request", async () => {
    const r = unpack(await setup().handlers.create_task(createArgs));
    expect(r.outcome).toBe("created"); expect(r.task.schedule_mode).toBe("anytime");
    expect(r.notification).toEqual({ assignment_email_requested: true, delivery_verified: false });
    expect(write).toHaveBeenCalledTimes(1);
    const input = write.mock.calls[0][1].input;
    expect(input).toMatchObject({ startAt: "2026-10-07T04:00:00.000Z", endAt: "2026-10-08T03:59:59.000Z", allDay: true, assignedTo: ["matt"], emailAssignments: true });
    expect(input).not.toHaveProperty("recurrenceRule");
  });
  it.each([
    ["unscheduled", { mode: "unscheduled" }, { startAt: null, endAt: null, allDay: false }],
    ["timed", { mode: "timed", start_date: "2026-10-07", end_date: "2026-10-07", start_time: "16:00", end_time: "17:00" }, { startAt: "2026-10-07T20:00:00.000Z", endAt: "2026-10-07T21:00:00.000Z", allDay: false }],
    ["multi-day", { mode: "anytime", start_date: "2026-10-07", end_date: "2026-10-09" }, { startAt: "2026-10-07T04:00:00.000Z", endAt: "2026-10-10T03:59:59.000Z", allDay: true }],
  ])("preserves %s schedules and assignments", async (_name, schedule, expected) => {
    const saved = task(expected); read.mockImplementation(async q => q.includes("GetTask") ? { task: saved } : q.includes("TaskClient") ? { client: { id: "client-1" } } : q.includes("SchedulableUsers") ? { users: { nodes: [{ id: "matt", status: "ACTIVATED", availableForScheduling: true }], pageInfo: { hasNextPage: false } } } : page([]));
    write.mockResolvedValue({ taskCreate: { task: saved, userErrors: [] } });
    expect(unpack(await setup().handlers.create_task({ ...createArgs, schedule, notify_team: false })).outcome).toBe("created");
    expect(write.mock.calls[0][1].input).toMatchObject(expected);
  });
  it.each([
    { mode: "timed", start_date: "2026-03-08", end_date: "2026-03-08", start_time: "02:30", end_time: "04:00" },
    { mode: "timed", start_date: "2026-11-01", end_date: "2026-11-01", start_time: "01:30", end_time: "04:00" },
    { mode: "timed", start_date: "2026-10-07", end_date: "2026-10-07", start_time: "17:00", end_time: "16:00" },
    { mode: "anytime", start_date: "2026-10-08", end_date: "2026-10-07" },
    { mode: "anytime", start_date: "2026-02-30" },
    { mode: "anytime", start_date: "2026-10-07", timezone: "unknown" },
  ])("rejects invalid schedule %# before any mutation", async schedule => {
    expect((await setup().handlers.create_task({ ...createArgs, schedule })).isError).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });
  it("rejects missing approval, duplicate users and invented recurrence", async () => {
    for (const patch of [{ confirm_write: false }, { assigned_user_ids: ["matt", "matt"] }, { schedule: { ...createArgs.schedule, recurrence: "weekly" } }]) {
      expect((await setup().handlers.create_task({ ...createArgs, ...patch })).isError).toBe(true);
    }
    expect(write).not.toHaveBeenCalled();
  });
  it("rejects foreign properties and unavailable users", async () => {
    read.mockResolvedValueOnce({ client: { id: "client-1" } }).mockResolvedValueOnce({ property: { id: "p", client: { id: "foreign" } } });
    expect((await setup().handlers.create_task({ ...createArgs, property_id: "p" })).isError).toBe(true);
    expect((await setup().handlers.create_task({ ...createArgs, assigned_user_ids: ["unknown"] })).isError).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });
  it("finds an existing matching task beyond page one", async () => {
    read.mockImplementation(async q => q.includes("TaskClient") ? { client: { id: "client-1" } } : q.includes("SchedulableUsers") ? { users: { nodes: [{ id: "matt", status: "ACTIVATED", availableForScheduling: true }], pageInfo: { hasNextPage: false } } } : page([]));
    let pages = 0;
    read.mockImplementation(async q => {
      if (q.includes("TaskClient")) return { client: { id: "client-1" } };
      if (q.includes("SchedulableUsers")) return { users: { nodes: [{ id: "matt", status: "ACTIVATED", availableForScheduling: true }], pageInfo: { hasNextPage: false } } };
      return ++pages === 1 ? page([], true, "page2") : page([task()]);
    });
    expect((await setup().handlers.create_task(createArgs)).isError).toBe(true); expect(pages).toBe(2); expect(write).not.toHaveBeenCalled();
  });
  it("blocks incomplete duplicate scans", async () => {
    read.mockImplementation(async q => q.includes("ListTasks") ? page([], true, "repeat") : q.includes("TaskClient") ? { client: { id: "client-1" } } : { users: { nodes: [{ id: "matt", status: "ACTIVATED", availableForScheduling: true }], pageInfo: { hasNextPage: false } } });
    expect((await setup().handlers.create_task(createArgs)).isError).toBe(true); expect(write).not.toHaveBeenCalled();
  });
  it("preserves mutation IDs on partial rejection and readback mismatch", async () => {
    write.mockResolvedValueOnce({ taskCreate: { task: task(), userErrors: [{ message: "partial" }] } });
    expect(unpack(await setup().handlers.create_task(createArgs))).toMatchObject({ outcome: "uncertain", task_id: "task-1" });
    read.mockImplementation(async q => q.includes("GetTask") ? { task: task({ title: "wrong" }) } : q.includes("TaskClient") ? { client: { id: "client-1" } } : q.includes("SchedulableUsers") ? { users: { nodes: [{ id: "matt", status: "ACTIVATED", availableForScheduling: true }], pageInfo: { hasNextPage: false } } } : page([]));
    expect(unpack(await setup().handlers.create_task(createArgs)).outcome).toBe("uncertain");
  });
  it("does not retry an ambiguous creation or claim email delivery", async () => {
    write.mockRejectedValueOnce(new JobberOutcomeUncertainError("timeout"));
    const r = unpack(await setup().handlers.create_task(createArgs));
    expect(r.outcome).toBe("uncertain"); expect(r.notification.delivery_verified).toBe(false); expect(write).toHaveBeenCalledTimes(1);
  });
  it("classifies a business rejection and does not retry", async () => {
    write.mockResolvedValueOnce({ taskCreate: { task: null, userErrors: [{ message: "not permitted" }] } });
    expect(unpack(await setup().handlers.create_task(createArgs)).error_type).toBe("jobber_rejected"); expect(write).toHaveBeenCalledTimes(1);
  });
  it("updates only requested fields and verifies omitted values", async () => {
    const saved = task({ instructions: "new" }); write.mockResolvedValue({ taskEdit: { task: saved, userErrors: [] } });
    let gets = 0; read.mockImplementation(async () => ({ task: ++gets < 3 ? task() : saved }));
    const r = unpack(await setup().handlers.update_task({ task_id: "task-1", expected_task_version: taskVersion(task()), instructions: "new", confirm_write: true }));
    expect(r.outcome).toBe("updated"); expect(write.mock.calls[0][1].input).toEqual({ instructions: "new", emailAssignments: false });
  });
  it("rejects stale, concurrent and recurring updates", async () => {
    const args = { task_id: "task-1", expected_task_version: taskVersion(task()), instructions: "new", confirm_write: true };
    for (const before of [task({ isRecurring: true }), task({ title: "changed" }), task({ isComplete: true })]) {
      read.mockResolvedValueOnce({ task: before }); expect((await setup().handlers.update_task(args)).isError).toBe(true);
    }
    read.mockResolvedValueOnce({ task: task() }).mockResolvedValueOnce({ task: task({ title: "changed concurrently" }) });
    expect((await setup().handlers.update_task(args)).isError).toBe(true); expect(write).not.toHaveBeenCalled();
  });
  it("rejects reminders without a timed assignment", async () => {
    expect((await setup().handlers.create_task({ ...createArgs, team_reminder_minutes: 30 })).isError).toBe(true);
    expect((await setup().handlers.create_task({ ...createArgs, assigned_user_ids: [] })).isError).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });
  it("version includes assignments, instructions, links, recurrence and completion", () => {
    for (const patch of [{ instructions: "x" }, { client: { id: "other" } }, { isComplete: true }, { isRecurring: true }, { assignedUsers: { nodes: [], pageInfo: { hasNextPage: false } } }]) expect(taskVersion(task(patch))).not.toBe(taskVersion(task()));
  });
  it("blocks unverified one-off and implicit recurring jobs before dispatch", async () => {
    const server: any = { registerTool: vi.fn() }; registerFoundationalTools(server);
    const [, config, handler] = server.registerTool.mock.calls.find((c: any[]) => c[0] === "create_job");
    const parsed = await config.inputSchema["~standard"].validate({ property_id: "p", billing_type: "FIXED_PRICE", billing_schedule: "ON_COMPLETION", confirm_write: true });
    expect(parsed.value.job_type).toBe("ONE_OFF"); expect((await handler(parsed.value)).isError).toBe(true);
    expect(read).not.toHaveBeenCalled(); expect(write).not.toHaveBeenCalled();
  });
});
