import type { McpServer } from "@modelcontextprotocol/server";
import { registerReadOnlyTool, pageSizeSchema, cursorSchema, roundMoney, returnedSoFarSchema, pageProgress } from "../tool-helpers.js";
import { QUOTES_OUTSTANDING_QUERY } from "../jobber/queries.js";
import { appendAuditLog } from "../utils/auditLog.js";

const PAGE_CAP = 20;
// measured via scripts/measure-costs.mjs - see README cost table. Sole enforcement point:
// passed directly to jobberGraphQL() below.
export const MAX_COST = 250;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

interface QuotesOutstandingResponse {
  quotes: {
    totalCount: number;
    nodes: Array<{
      id: string;
      quoteNumber: string;
      title: string | null;
      client: { id: string; name: string };
      amounts: { total: number };
      createdAt: string;
      quoteStatus: string;
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

export function registerQuotesOutstandingTool(server: McpServer): void {
  registerReadOnlyTool(
    server,
    "quotes_outstanding",
    {
      description:
        "Return Jobber quotes awaiting client response, with quote age and amounts. Excludes quotes the client has already approved but that have not yet been converted to a job.",
      inputSchema: {
        page_size: pageSizeSchema(PAGE_CAP).describe(`Max quotes to return (1-${PAGE_CAP})`),
        cursor: cursorSchema(),
        returned_so_far: returnedSoFarSchema(),
      },
      maxCost: MAX_COST,
    },
    async (
      {
        page_size,
        cursor,
        returned_so_far = 0,
      }: {
        page_size: number;
        cursor?: string;
        returned_so_far?: number;
      },
      jobberGraphQL
    ) => {
      const data = await jobberGraphQL<QuotesOutstandingResponse>(QUOTES_OUTSTANDING_QUERY, {
        first: page_size,
        after: cursor,
      });

      const now = Date.now();
      const quotes = data.quotes.nodes.map((q) => ({
        id: q.id,
        quote_number: q.quoteNumber,
        title: q.title,
        client: q.client.name,
        total: roundMoney(q.amounts.total),
        age_days: Math.floor((now - new Date(q.createdAt).getTime()) / MS_PER_DAY),
      }));

      await appendAuditLog({
        tool: "quotes_outstanding",
        args: { page_size, cursor },
        outcome: "success",
        result_count: quotes.length,
      });

      const { returned_so_far: returnedSoFar, remaining } = pageProgress(
        data.quotes.totalCount,
        quotes.length,
        returned_so_far
      );
      const result: Record<string, unknown> = {
        total_count: data.quotes.totalCount,
        // Jobber's GraphQL schema exposes no currency field on Account/Client/Invoice - this is
        // the honest, permanent answer, not an unfinished placeholder.
        currency: "unknown",
        returned_so_far: returnedSoFar,
        quotes,
      };
      if (data.quotes.pageInfo.hasNextPage) {
        result.note = remaining > 0 ? `${remaining} more available` : "more available";
        result.next_cursor = data.quotes.pageInfo.endCursor;
      }

      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );
}
