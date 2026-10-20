import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { cursorSchema, pageSizeSchema, registerReadOnlyTool, type CostedGraphQL } from "../tool-helpers.js";
import { JobberPermissionError } from "../jobber/errors.js";
import { appendAuditLog } from "../utils/auditLog.js";
import { localInstant } from "./foundations.js";

type Node = Record<string, any>;
const fields = `id createdAt updatedAt startAt endAt finalDuration ticking approved payable label note
  user{id name{full} status} job{id jobNumber title jobberWebUri}
  targetItem{__typename ... on Visit{id title} ... on Assessment{id title} ... on Job{id title}}`;
const listQuery = `query ListTimeEntries($first:Int!,$after:String,$filter:TimeSheetEntriesFilterAttributes){timeSheetEntries(first:$first,after:$after,filter:$filter){nodes{${fields}} pageInfo{hasNextPage endCursor}}}`;
const getQuery = `query GetTimeEntry($id:EncodedId!){timeSheetEntry(id:$id){${fields}}}`;
const rosterQuery = `query ListTimesheetUsers($start:ISO8601Date!,$end:ISO8601Date!,$first:Int!,$after:String){timeSheetUsers(startDate:$start,endDate:$end,first:$first,after:$after){nodes{id name{full} status} pageInfo{hasNextPage endCursor}}}`;
const dateRange = { start_date: z.string().date(), end_date: z.string().date() };
const idSchema = z.string().trim().min(1).max(512);
const result = (payload: Node) => ({ content: [{ type: "text" as const, text: JSON.stringify(payload) }] });

function range(start: string, end: string, maxDays = 31) {
  const first = Date.parse(`${start}T00:00:00Z`), last = Date.parse(`${end}T00:00:00Z`);
  if (last < first || last - first >= maxDays * 86_400_000) throw new Error(`Choose an inclusive date range of 1–${maxDays} days.`);
  return new Date(last + 86_400_000).toISOString().slice(0, 10);
}
function timestamp(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}
function employee(user: Node | null) {
  if (user === null) return null;
  if (!user || typeof user.id !== "string" || !user.id || typeof user.name?.full !== "string" || typeof user.status !== "string") {
    throw new Error("Jobber returned an incomplete employee record; employee details could not be verified.");
  }
  return { id: user.id, name: user.name.full, status: user.status };
}
function entry(node: Node) {
  if (!node || typeof node.id !== "string" || !node.id || !timestamp(node.createdAt) || !timestamp(node.updatedAt) ||
      !timestamp(node.startAt) || (node.endAt !== null && !timestamp(node.endAt)) ||
      typeof node.ticking !== "boolean" || typeof node.approved !== "boolean" || typeof node.payable !== "boolean" ||
      !Number.isFinite(node.finalDuration) || node.finalDuration < 0) {
    throw new Error("Jobber returned an incomplete time entry; hours could not be verified.");
  }
  if (node.job !== null && (!node.job || typeof node.job.id !== "string" || !node.job.id)) {
    throw new Error("Jobber returned an incomplete time-entry job link.");
  }
  if (node.targetItem !== null && (!node.targetItem || !["Visit", "Assessment", "Job"].includes(node.targetItem.__typename) ||
      typeof node.targetItem.id !== "string" || !node.targetItem.id)) throw new Error("Jobber returned an incomplete timer target.");
  return { id: node.id, created_at: node.createdAt, updated_at: node.updatedAt,
    employee: employee(node.user), job: node.job === null ? null : {
      id: node.job.id, number: node.job.jobNumber, title: node.job.title, url: node.job.jobberWebUri },
    target: node.targetItem === null ? null : { type: node.targetItem.__typename, id: node.targetItem.id, title: node.targetItem.title },
    start_at: node.startAt, end_at: node.endAt, running: node.ticking,
    // Jobber reports finalDuration=0 for ticking timers. That is not zero hours worked.
    recorded_duration_seconds: node.ticking ? null : node.finalDuration,
    approved: node.approved, payable: node.payable, label: node.label ?? null, note: node.note ?? null };
}
function connection(value: Node | undefined, cap: number, cursor?: string): Node {
  if (!Array.isArray(value?.nodes) || value.nodes.length > cap || typeof value.pageInfo?.hasNextPage !== "boolean" ||
      (value.pageInfo.hasNextPage && (typeof value.pageInfo.endCursor !== "string" || !value.pageInfo.endCursor || value.pageInfo.endCursor === cursor))) {
    throw new Error("Jobber returned incomplete time-entry pagination; do not treat this as an empty or complete result.");
  }
  return value;
}
async function read(query: string, variables: Node, run: CostedGraphQL<number>): Promise<Node> {
  try { return await run<Node>(query, variables); }
  catch (error) {
    if (error instanceof JobberPermissionError || (error instanceof Error && /hidden due to permissions|not authori[sz]ed|permission denied|missing scope|forbidden/i.test(error.message))) {
      throw new JobberPermissionError("Timesheet data is unavailable to this connection. Check the app's timesheet read scope and the authorizing user's permissions; reauthorize after a scope change. No hours were verified; this is not an empty timesheet.");
    }
    throw error;
  }
}

/** Native labour reads only: no clock, approval, payroll-rate, or mutation tools. */
export function registerTimesheetTools(server: McpServer): void {
  registerReadOnlyTool(server, "list_timesheet_users", {
    description: "Read the account's timesheet employee roster for 1–7 inclusive calendar days, including deactivated users with entries. Paginate before resolving an employee by name; use returned IDs. No pay rates or employee changes. Jobber timesheet-read permission is required.",
    inputSchema: { ...dateRange, page_size: pageSizeSchema(50), cursor: cursorSchema() },
    redactAuditErrors: true, maxCost: 500,
  }, async (args, run) => {
    range(args.start_date, args.end_date, 7);
    const data = await read(rosterQuery, { start: args.start_date, end: args.end_date, first: args.page_size, after: args.cursor }, run);
    const page = connection(data.timeSheetUsers, args.page_size, args.cursor);
    const users = page.nodes.map((user: Node) => {
      const value = employee(user);
      if (!value) throw new Error("Jobber returned a missing timesheet employee.");
      return value;
    });
    if (new Set(users.map((user: Node) => user.id)).size !== users.length) throw new Error("Jobber returned duplicate timesheet employees.");
    await appendAuditLog({ tool: "list_timesheet_users", args, outcome: "success", result_count: users.length });
    return result({ employees: users, has_more: page.pageInfo.hasNextPage,
      ...(page.pageInfo.hasNextPage ? { next_cursor: page.pageInfo.endCursor } : {}) });
  });
  registerReadOnlyTool(server, "list_time_entries", {
    description: "Read employee labour/time entries STARTING within 1–31 inclusive dates, timezone America/Toronto by default. Optional user_id and job_id narrow results. Full entry duration is returned, not clipped per day; an overnight entry starting before the range is excluded. Running timers have no final recorded duration. Results are one page, never a payroll total. When filtering by job, an empty page can still have next_cursor: paginate until has_more=false. Notes and scheduled visits are not timesheets. No pay rates or writes.",
    inputSchema: { ...dateRange, timezone: z.string().trim().min(1).default("America/Toronto"),
      user_id: idSchema.optional(), job_id: idSchema.optional(), page_size: pageSizeSchema(50), cursor: cursorSchema() },
    redactAuditErrors: true, maxCost: 500,
  }, async (args, run) => {
    const nextDate = range(args.start_date, args.end_date);
    const start = localInstant(args.start_date, "00:00:00", args.timezone, "Timesheet range start");
    const end = localInstant(nextDate, "00:00:00", args.timezone, "Timesheet range end");
    if (args.job_id) {
      const data = await read(`query TimeEntryJob($id:EncodedId!){job(id:$id){id}}`, { id: args.job_id }, run);
      if (data.job?.id !== args.job_id) throw new Error("Job not found in this Jobber account; no time entries were returned.");
    }
    const data = await read(listQuery, { first: args.page_size, after: args.cursor, filter: {
      // Subtract a millisecond so an exclusive native 'after' does not lose midnight.
      startAt: { after: new Date(start - 1).toISOString(), before: new Date(end).toISOString() },
      ...(args.user_id ? { assignedTo: args.user_id } : {}),
    } }, run);
    const page = connection(data.timeSheetEntries, args.page_size, args.cursor);
    const entries = page.nodes.map(entry);
    if (new Set(entries.map((item: Node) => item.id)).size !== entries.length) throw new Error("Jobber returned duplicate time entries.");
    if (args.user_id && entries.some((item: Node) => item.employee?.id !== args.user_id)) throw new Error("Jobber returned an unexpected employee; no time entries were disclosed.");
    const matching = entries.filter((item: Node) => Date.parse(item.start_at) >= start && Date.parse(item.start_at) < end &&
      (!args.job_id || item.job?.id === args.job_id));
    await appendAuditLog({ tool: "list_time_entries", args, outcome: "success", result_count: matching.length });
    return result({ entries: matching, start_date: args.start_date, end_date: args.end_date, timezone: args.timezone,
      selection: "entry_start_within_dates", scanned_count: page.nodes.length, has_more: page.pageInfo.hasNextPage,
      ...(page.pageInfo.hasNextPage ? { next_cursor: page.pageInfo.endCursor } : {}) });
  });
  registerReadOnlyTool(server, "get_time_entry", {
    description: "Read one native employee labour/time entry by its returned entry_id, including recorded duration, running state, employee, job/visit/assessment links and timesheet approval state. A null duration means a running timer, not zero hours. No pay rates, approvals or edits. An inaccessible entry is an error, not evidence of no recorded work.",
    inputSchema: { entry_id: idSchema }, redactAuditErrors: true, maxCost: 500,
  }, async (args, run) => {
    const data = await read(getQuery, { id: args.entry_id }, run);
    if (data.timeSheetEntry?.id !== args.entry_id) throw new Error("Time entry not found or not accessible in this Jobber account; no hours were verified.");
    const value = entry(data.timeSheetEntry);
    await appendAuditLog({ tool: "get_time_entry", args, outcome: "success", result_count: 1 });
    return result({ entry: value });
  });
}
