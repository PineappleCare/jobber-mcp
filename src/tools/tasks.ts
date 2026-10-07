import { createHash } from "node:crypto";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { cursorSchema, isReadOnly, isWriteCapabilityEnabled, pageSizeSchema, registerReadOnlyTool, registerWriteTool } from "../tool-helpers.js";
import { appendAuditLog } from "../utils/auditLog.js";
import { JobberOutcomeUncertainError } from "../jobber/errors.js";
import { JobberRejectedError } from "../jobber/mutations.js";
import { assertSchedulableUsers, localInstant } from "./foundations.js";

type Node = Record<string, any>;
type Run = (query: string, variables?: Record<string, unknown>) => Promise<Node>;
const COST = 800;
const SCAN_CAP = 500;
const fields = `id title instructions allDay startAt endAt isComplete isRecurring teamReminderOffset client{id} property{id} workObject{__typename ... on Quote{id} ... on Request{id}} assignedUsers(first:50){nodes{id} pageInfo{hasNextPage}}`;
const getQuery = `query GetTask($id:EncodedId!){task(id:$id){${fields}}}`;
const listQuery = `query ListTasks($first:Int!,$after:String,$filter:TaskFilterAttributes){tasks(first:$first,after:$after,filter:$filter){totalCount nodes{${fields}} pageInfo{hasNextPage endCursor}}}`;
const timezone = z.string().trim().min(1).default("America/Toronto");
const time = z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/);
const scheduleSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("anytime"), start_date: z.string().date(), end_date: z.string().date().optional(), timezone }).strict(),
  z.object({ mode: z.literal("timed"), start_date: z.string().date(), start_time: time, end_date: z.string().date(), end_time: time, timezone }).strict(),
  z.object({ mode: z.literal("unscheduled") }).strict(),
]).describe("Anytime means all day; timed requires an explicit interval; unscheduled has no dates. Do not invent a time for 'end of day'.");
const idsSchema = z.array(z.string().trim().min(1)).max(20).refine(ids => new Set(ids).size === ids.length, "Duplicate team member IDs are not allowed.");
const reminderSchema = z.union([z.literal(0), z.literal(30), z.literal(60), z.literal(120), z.literal(300), z.literal(1440), z.null()]);

function result(payload: Node, error = false) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }], ...(error ? { isError: true } : {}) };
}
function assigned(task: Node): string[] {
  if (!Array.isArray(task.assignedUsers?.nodes) || task.assignedUsers?.pageInfo?.hasNextPage !== false) {
    throw new Error("Incomplete task assignments; no write can be verified safely.");
  }
  return task.assignedUsers.nodes.map((user: Node) => user.id).sort();
}
function snapshot(task: Node) {
  return { id: task.id, title: task.title, instructions: task.instructions ?? "", allDay: task.allDay,
    startAt: task.startAt ? new Date(task.startAt).toISOString() : null, endAt: task.endAt ? new Date(task.endAt).toISOString() : null,
    isComplete: task.isComplete, isRecurring: task.isRecurring, teamReminderOffset: task.teamReminderOffset === -1 ? null : task.teamReminderOffset ?? null,
    client_id: task.client?.id ?? null, property_id: task.property?.id ?? null, workObject: task.workObject ?? null,
    assigned_user_ids: assigned(task) };
}
export function taskVersion(task: Node): string {
  return `sha256:${createHash("sha256").update(JSON.stringify(snapshot(task))).digest("hex")}`;
}
function view(task: Node): Node {
  return { ...task, schedule_mode: !task.startAt && !task.endAt ? "unscheduled" : task.allDay ? "anytime" : "timed", task_version: taskVersion(task) };
}
function scheduleInput(schedule: z.infer<typeof scheduleSchema>): Node {
  if (schedule.mode === "unscheduled") return { startAt: null, endAt: null, allDay: false };
  const tz = schedule.timezone ?? "America/Toronto";
  const endDate = schedule.end_date ?? schedule.start_date;
  if (endDate < schedule.start_date) throw new Error("Task end date must not precede its start date.");
  const start = localInstant(schedule.start_date, schedule.mode === "anytime" ? "00:00:00" : schedule.start_time, tz, "Task start");
  const end = localInstant(endDate, schedule.mode === "anytime" ? "23:59:59" : schedule.end_time, tz, "Task end");
  if (end <= start) throw new Error("Timed task end must be after its start; supply an explicit duration.");
  return { startAt: new Date(start).toISOString(), endAt: new Date(end).toISOString(), allDay: schedule.mode === "anytime" };
}
async function readTask(id: string, run: Run): Promise<Node> {
  const task = (await run(getQuery, { id })).task;
  if (!task || task.id !== id) throw new Error("Task not found in this Jobber account.");
  snapshot(task); // Fail closed on incomplete assignment data.
  return task;
}
async function validateParent(clientId: string | undefined, propertyId: string | undefined, run: Run): Promise<void> {
  if (clientId) {
    const data = await run(`query TaskClient($id:EncodedId!){client(id:$id){id}}`, { id: clientId });
    if (data.client?.id !== clientId) throw new Error("Task client not found; no write was attempted.");
  }
  if (propertyId) {
    if (!clientId) throw new Error("A property-linked task requires its client_id.");
    const data = await run(`query TaskProperty($id:EncodedId!){property(id:$id){id client{id}}}`, { id: propertyId });
    if (data.property?.id !== propertyId || data.property.client?.id !== clientId) throw new Error("Task property does not belong to the selected client; no write was attempted.");
  }
}
function matches(task: Node, expected: Node): boolean {
  const actual = snapshot(task);
  return Object.entries(expected).every(([key, value]) => JSON.stringify(actual[key as keyof typeof actual]) === JSON.stringify(value));
}
async function duplicateCheck(expected: Node, run: Run): Promise<void> {
  let after: string | undefined;
  const cursors = new Set<string>();
  // Narrow scheduled scans to the requested start instant. Unscheduled tasks
  // need a bounded complete scan because the API exposes no null-date filter.
  const filter = expected.startAt ? { startAt: { eq: expected.startAt } } : undefined;
  for (let count = 0; count < SCAN_CAP; count += 50) {
    const data = await run(listQuery, { first: 50, after, filter });
    const connection = data.tasks;
    if (!Array.isArray(connection?.nodes) || typeof connection.pageInfo?.hasNextPage !== "boolean") throw new Error("Incomplete duplicate scan; no task was created.");
    if (connection.nodes.some((task: Node) => matches(task, expected))) throw new Error("An identical task already exists; no task was created. Read and reconcile it instead of retrying.");
    if (!connection.pageInfo.hasNextPage) return;
    const next = connection.pageInfo.endCursor;
    if (!next || cursors.has(next)) throw new Error("Invalid task pagination; no task was created.");
    cursors.add(next); after = next;
  }
  throw new Error("Duplicate scan exceeded 500 tasks; no task was created. Reconcile existing tasks before writing.");
}
function validateNotification(expected: Node, email: boolean): void {
  if ((email || expected.teamReminderOffset !== null) && !expected.assigned_user_ids.length) throw new Error("Team notifications require assigned team members.");
  if (expected.teamReminderOffset !== null && (!expected.startAt || expected.allDay)) throw new Error("Team reminders require an explicit timed task.");
}
async function mutate(tool: string, args: Node, expected: Node, query: string, variables: Node, payloadName: string, run: Run) {
  let returned: Node | undefined;
  let errors: Node[] = [];
  let uncertain = false;
  try {
    const data = await run(query, variables);
    const payload = data[payloadName];
    returned = payload?.task;
    if (!Array.isArray(payload?.userErrors)) uncertain = true;
    else errors = payload.userErrors;
    if (!returned?.id && errors.length) throw new JobberRejectedError("Jobber rejected the task: " + errors.map(e => e.message).join("; "));
  } catch (error) {
    if (!(error instanceof JobberOutcomeUncertainError)) throw error;
    uncertain = true;
  }
  const id = returned?.id ?? args.task_id;
  let verified: Node | undefined;
  if (id) { try { verified = await readTask(id, run); } catch { uncertain = true; } }
  const success = !uncertain && !errors.length && !!verified && matches(verified, expected);
  await appendAuditLog({ tool, args: { ...args, result_task_id: id }, outcome: success ? "success" : "partial", result_count: id ? 1 : 0,
    ...(success ? {} : { error_message: "Task mutation needs reconciliation; no retry performed." }) });
  return result({ outcome: success ? (tool === "create_task" ? "created" : "updated") : "uncertain",
    ...(id ? { task_id: id } : {}), ...(verified ? { task: view(verified) } : returned ? { task: returned } : {}),
    ...(errors.length ? { user_errors: errors } : {}),
    notification: { assignment_email_requested: args.notify_team === true, delivery_verified: false },
    ...(!success ? { guidance: "Read the returned task ID, or list tasks for the requested date/client if no ID was returned. Reconcile before any newly approved write. Do not automatically retry or resend notifications." } : {}),
  }, !success);
}

export function registerTaskTools(server: McpServer): void {
  registerReadOnlyTool(server, "list_tasks", { description: "List native Jobber tasks, including client/property links, schedules, assignments and versions. Paginate; tasks are separate from jobs and visits.",
    inputSchema: { page_size: pageSizeSchema(20), cursor: cursorSchema(), assigned_user_id: z.string().min(1).optional(),
      start_after: z.string().datetime({ offset: true }).optional(), start_before: z.string().datetime({ offset: true }).optional() }, maxCost: COST }, async (args, run) => {
    if (args.start_after && args.start_before && Date.parse(args.start_after) >= Date.parse(args.start_before)) throw new Error("start_before must follow start_after.");
    const data = await run<Node>(listQuery, { first: args.page_size, after: args.cursor, filter: { assignedTo: args.assigned_user_id,
      ...(args.start_after || args.start_before ? { startAt: { after: args.start_after, before: args.start_before } } : {}) } });
    const connection = data.tasks;
    return result({ tasks: connection.nodes.map(view), total_count: connection.totalCount,
      ...(connection.pageInfo.hasNextPage ? { next_cursor: connection.pageInfo.endCursor } : {}) });
  });
  registerReadOnlyTool(server, "get_task", { description: "Read a native Jobber task and its task_version before proposing an update.",
    inputSchema: { task_id: z.string().min(1) }, maxCost: COST }, async (args, run) => result({ task: view(await readTask(args.task_id, run)) }));
  if (isReadOnly() || !isWriteCapabilityEnabled("scheduling")) return;
  registerWriteTool(server, "create_task", { description: "Create one NON-recurring native Jobber task after exact approval. Optional client/property, explicit schedule and team assignment. notify_team requests an assignment EMAIL, not SMS; delivery cannot be proven. Never substitute a job or visit.", capability: "scheduling", redactAuditErrors: true,
    inputSchema: { title: z.string().trim().min(1).max(250), instructions: z.string().max(10000).default(""),
      client_id: z.string().min(1).optional(), property_id: z.string().min(1).optional(), schedule: scheduleSchema,
      assigned_user_ids: idsSchema.default([]), notify_team: z.boolean().default(false), team_reminder_minutes: reminderSchema.default(null), confirm_write: z.literal(true) }, maxCost: COST }, async (args, run) => {
    const schedule = scheduleInput(args.schedule);
    const expected = { title: args.title, instructions: args.instructions, ...schedule, isRecurring: false, isComplete: false,
      client_id: args.client_id ?? null, property_id: args.property_id ?? null, workObject: null,
      assigned_user_ids: [...args.assigned_user_ids].sort(), teamReminderOffset: args.team_reminder_minutes };
    validateNotification(expected, args.notify_team);
    await validateParent(args.client_id, args.property_id, run);
    if (args.assigned_user_ids.length) await assertSchedulableUsers(args.assigned_user_ids, run);
    await duplicateCheck(expected, run);
    return mutate("create_task", args, expected,
      `mutation CreateTask($clientId:EncodedId,$propertyId:EncodedId,$input:TaskCreateInput!){taskCreate(clientId:$clientId,propertyId:$propertyId,input:$input){task{${fields}} userErrors{message path}}}`,
      { clientId: args.client_id, propertyId: args.property_id, input: { title: args.title, instructions: args.instructions, ...schedule,
        assignedTo: args.assigned_user_ids, emailAssignments: args.notify_team, teamReminderOffset: args.team_reminder_minutes ?? -1 } }, "taskCreate", run);
  });
  registerWriteTool(server, "update_task", { description: "Edit one reviewed NON-recurring Jobber task using expected_task_version. Preserve omitted fields; assignments replace the exact list. No deletion, completion or recurring-chain edits. Assignment email requires explicit notify_team=true approval.", capability: "scheduling", redactAuditErrors: true,
    inputSchema: { task_id: z.string().min(1), expected_task_version: z.string().regex(/^sha256:[a-f0-9]{64}$/), title: z.string().trim().min(1).max(250).optional(),
      instructions: z.string().max(10000).optional(), schedule: scheduleSchema.optional(), assigned_user_ids: idsSchema.optional(),
      notify_team: z.boolean().default(false), team_reminder_minutes: reminderSchema.optional(), confirm_write: z.literal(true) }, maxCost: COST }, async (args, run) => {
    if ([args.title, args.instructions, args.schedule, args.assigned_user_ids, args.team_reminder_minutes].every(v => v === undefined)) throw new Error("Provide at least one task field to update.");
    const before = await readTask(args.task_id, run);
    if (before.isRecurring || before.isComplete) throw new Error("Only incomplete, non-recurring tasks can be edited by this tool.");
    if (taskVersion(before) !== args.expected_task_version) throw new Error("Task changed since review; read it again before approval.");
    const changes = { ...(args.title !== undefined ? { title: args.title } : {}), ...(args.instructions !== undefined ? { instructions: args.instructions } : {}),
      ...(args.schedule ? scheduleInput(args.schedule) : {}), ...(args.assigned_user_ids !== undefined ? { assigned_user_ids: [...args.assigned_user_ids].sort() } : {}),
      ...(args.team_reminder_minutes !== undefined ? { teamReminderOffset: args.team_reminder_minutes } : {}) };
    const expected = { ...snapshot(before), ...changes };
    validateNotification(expected, args.notify_team);
    if (args.assigned_user_ids?.length) await assertSchedulableUsers(args.assigned_user_ids, run);
    if (taskVersion(await readTask(args.task_id, run)) !== args.expected_task_version) throw new Error("Task changed during preflight; no update was attempted.");
    const { assigned_user_ids, ...input } = changes;
    return mutate("update_task", args, expected,
      `mutation EditTask($id:EncodedId!,$input:TaskEditInput!){taskEdit(taskId:$id,input:$input){task{${fields}} userErrors{message path}}}`,
      { id: args.task_id, input: { ...input, ...(input.teamReminderOffset === null ? { teamReminderOffset: -1 } : {}),
        ...(assigned_user_ids !== undefined ? { assignedTo: assigned_user_ids } : {}), emailAssignments: args.notify_team } }, "taskEdit", run);
  });
}
