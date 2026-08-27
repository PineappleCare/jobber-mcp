import type { McpServer } from "@modelcontextprotocol/server";
import { registerReadOnlyTool, pageSizeSchema, cursorSchema, returnedSoFarSchema, pageProgress } from "../tool-helpers.js";
import { REQUESTS_INBOX_QUERY } from "../jobber/queries.js";
import { appendAuditLog } from "../utils/auditLog.js";

const PAGE_CAP = 20;
// measured via scripts/measure-costs.mjs (typical cost 124) - see README cost table. Two
// connections (status: new, status: unscheduled) in one query, comfortably under this ceiling.
// Sole enforcement point: declared as maxCost below, bound into the jobberGraphQL passed to the
// handler by registerReadOnlyTool.
export const MAX_COST = 400;

interface RequestNode {
  id: string;
  title: string | null;
  requestStatus: string;
  client: { id: string; name: string };
  createdAt: string;
}

interface Connection {
  totalCount: number;
  nodes: RequestNode[];
  pageInfo: { hasNextPage: boolean; endCursor: string | null };
}

interface RequestsInboxResponse {
  newRequests: Connection;
  unscheduledRequests: Connection;
}

function section(conn: Connection, previousReturned: number) {
  const items = conn.nodes.map((r) => ({
    id: r.id,
    title: r.title,
    status: r.requestStatus,
    client: r.client.name,
    created_at: r.createdAt,
  }));
  const { returned_so_far, remaining } = pageProgress(conn.totalCount, items.length, previousReturned);
  return {
    total_count: conn.totalCount,
    returned_so_far,
    items,
    ...(conn.pageInfo.hasNextPage
      ? { note: remaining > 0 ? `${remaining} more available` : "more available", next_cursor: conn.pageInfo.endCursor }
      : {}),
  };
}

export function registerRequestsInboxTool(server: McpServer): void {
  registerReadOnlyTool(
    server,
    "requests_inbox",
    {
      description: "Return new and unscheduled Jobber requests.",
      inputSchema: {
        page_size: pageSizeSchema(PAGE_CAP).describe(`Max requests per section (1-${PAGE_CAP})`),
        cursor: cursorSchema().describe("Cursor from a previous response's new_requests.next_cursor"),
        unscheduled_cursor: cursorSchema().describe("Cursor from a previous response's unscheduled_requests.next_cursor"),
        returned_so_far: returnedSoFarSchema().describe("Echo back the previous response's new_requests.returned_so_far"),
        unscheduled_returned_so_far: returnedSoFarSchema().describe(
          "Echo back the previous response's unscheduled_requests.returned_so_far"
        ),
      },
      maxCost: MAX_COST,
    },
    async (
      {
        page_size,
        cursor,
        unscheduled_cursor,
        returned_so_far = 0,
        unscheduled_returned_so_far = 0,
      }: {
        page_size: number;
        cursor?: string;
        unscheduled_cursor?: string;
        returned_so_far?: number;
        unscheduled_returned_so_far?: number;
      },
      jobberGraphQL
    ) => {
      const data = await jobberGraphQL<RequestsInboxResponse>(REQUESTS_INBOX_QUERY, {
        first: page_size,
        after: cursor,
        unscheduledAfter: unscheduled_cursor,
      });

      const newRequests = section(data.newRequests, returned_so_far);
      const unscheduledRequests = section(data.unscheduledRequests, unscheduled_returned_so_far);

      await appendAuditLog({
        tool: "requests_inbox",
        args: { page_size, cursor, unscheduled_cursor, returned_so_far, unscheduled_returned_so_far },
        outcome: "success",
        result_count: newRequests.items.length + unscheduledRequests.items.length,
      });

      const result = {
        new_requests: newRequests,
        unscheduled_requests: unscheduledRequests,
      };

      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );
}
