import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerReadOnlyTool, pageSizeSchema, cursorSchema, returnedSoFarSchema, pageProgress } from "../tool-helpers.js";
import { SCHEDULE_LOOKUP_QUERY } from "../jobber/queries.js";
import { appendAuditLog } from "../utils/auditLog.js";

const PAGE_CAP = 20;
// measured via scripts/measure-costs.mjs (typical cost 188) - see README cost table. Comfortably
// under this ceiling even though scheduledItems can return more item types per page than the old
// visits-only query. Sole enforcement point: declared as maxCost below, bound into the
// jobberGraphQL passed to the handler by registerReadOnlyTool.
export const MAX_COST = 1200;

interface VisitNode {
  __typename: "Visit";
  id: string;
  title: string | null;
  visitStatus: string;
  startAt: string | null;
  endAt: string | null;
  client: { id: string; name: string };
}

interface AssessmentNode {
  __typename: "Assessment";
  id: string;
  title: string | null;
  startAt: string | null;
  endAt: string | null;
  client: { id: string; name: string };
  isComplete: boolean;
  completedAt: string | null;
}

// Other scheduled-item types (Basic Task, Event, Quote Reminder, Invoice
// Reminder) only have __typename populated, since we don't request any
// fields for them via inline fragments - they're filtered out below.
type ScheduledItemNode = VisitNode | AssessmentNode | { __typename: string };

interface ScheduleLookupResponse {
  scheduledItems: {
    totalCount: number;
    nodes: ScheduledItemNode[];
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

function dayOf(iso: string, timezone: string): string {
  return new Date(iso).toLocaleDateString("en-CA", { timeZone: timezone });
}

function isValidTimezone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat(undefined, { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

function toEntry(node: ScheduledItemNode): Record<string, unknown> | null {
  if (node.__typename === "Visit") {
    const v = node as VisitNode;
    if (!v.startAt) return null;
    return {
      id: v.id,
      title: v.title,
      type: "visit",
      status: v.visitStatus,
      start_at: v.startAt,
      end_at: v.endAt,
      client: v.client.name,
    };
  }
  if (node.__typename === "Assessment") {
    const a = node as AssessmentNode;
    if (!a.startAt) return null;
    return {
      id: a.id,
      title: a.title,
      type: "assessment",
      status: a.isComplete ? "complete" : "incomplete",
      start_at: a.startAt,
      end_at: a.endAt,
      completed_at: a.completedAt,
      client: a.client.name,
    };
  }
  return null;
}

export function registerScheduleLookupTool(server: McpServer): void {
  registerReadOnlyTool(
    server,
    "schedule_lookup",
    {
      description:
        "Return Jobber visits and assessments for a date range, grouped by day. " +
        "Days are grouped by the server's local calendar day unless a `timezone` is supplied.",
      inputSchema: {
        date_from: z.string().describe("Start of the date range (ISO 8601, include a UTC offset for precise range boundaries)"),
        date_to: z.string().describe("End of the date range (ISO 8601, include a UTC offset for precise range boundaries)"),
        page_size: pageSizeSchema(PAGE_CAP).describe(`Max scheduled items to scan (1-${PAGE_CAP})`),
        cursor: cursorSchema(),
        timezone: z
          .string()
          .optional()
          .refine((tz) => tz === undefined || isValidTimezone(tz), { message: "timezone must be a valid IANA timezone name" })
          .describe("IANA timezone (e.g. 'America/Toronto') to group days by; defaults to the server's local timezone"),
        returned_so_far: returnedSoFarSchema(),
      },
      maxCost: MAX_COST,
    },
    async (
      {
        date_from,
        date_to,
        page_size,
        cursor,
        timezone,
        returned_so_far = 0,
      }: {
        date_from: string;
        date_to: string;
        page_size: number;
        cursor?: string;
        timezone?: string;
        returned_so_far?: number;
      },
      jobberGraphQL
    ) => {
      const tz = timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
      const data = await jobberGraphQL<ScheduleLookupResponse>(SCHEDULE_LOOKUP_QUERY, {
        from: date_from,
        to: date_to,
        first: page_size,
        after: cursor,
      });

      const rawNodes = data.scheduledItems.nodes;
      // Filtered client-side rather than server-side: Jobber's root scheduledItems field's
      // ScheduledItemsFilterAttributes.scheduleItemType accepts a single ScheduledItemType, not a
      // list - there is no filter that returns "Visit or Assessment" in one query. Two separate
      // scheduleItemType-filtered, paginated queries merged in code would double query cost for no
      // real gain: this client-side filter already produces correct counts/pagination via
      // rawNodes.length + total_count_note below. Revisit only if Jobber adds a list-typed filter.
      const otherTypesPresent = rawNodes.some(
        (n) => n.__typename !== "Visit" && n.__typename !== "Assessment"
      );

      const byDay = new Map<string, unknown[]>();
      let keptCount = 0;
      for (const node of rawNodes) {
        const entry = toEntry(node);
        if (!entry) continue;
        keptCount++;
        const day = dayOf(entry.start_at as string, tz);
        const list = byDay.get(day) ?? [];
        list.push(entry);
        byDay.set(day, list);
      }
      const days = Object.fromEntries([...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)));

      await appendAuditLog({
        tool: "schedule_lookup",
        args: { date_from, date_to, page_size, cursor, timezone: tz },
        outcome: "success",
        result_count: keptCount,
      });

      // totalCount (from Jobber) and rawNodes.length both count every scheduled-item
      // type in range, so this pairing is apples-to-apples - unlike keptCount, which
      // only counts the Visit/Assessment subset actually returned in `days`.
      const { returned_so_far: returnedSoFar, remaining } = pageProgress(
        data.scheduledItems.totalCount,
        rawNodes.length,
        returned_so_far
      );
      const result: Record<string, unknown> = {
        total_scheduled_items_count: data.scheduledItems.totalCount,
        date_from,
        date_to,
        timezone: tz,
        returned_so_far: returnedSoFar,
        days,
      };
      if (otherTypesPresent) {
        result.total_count_note =
          "total_scheduled_items_count includes all scheduled item types in range (visits, assessments, and others); only visits and assessments are returned in 'days', so it does not equal the number of entries shown there";
      }
      if (data.scheduledItems.pageInfo.hasNextPage) {
        result.note = remaining > 0 ? `${remaining} more available` : "more available";
        result.next_cursor = data.scheduledItems.pageInfo.endCursor;
      }

      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );
}
