import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerReadOnlyTool, pageSizeSchema, cursorSchema, roundMoney, returnedSoFarSchema, pageProgress } from "../tool-helpers.js";
import { REVENUE_SUMMARY_QUERY } from "../jobber/queries.js";
import { appendAuditLog } from "../utils/auditLog.js";

const PAGE_CAP = 20;
// measured via scripts/measure-costs.mjs - see README cost table. Sole enforcement point:
// passed directly to jobberGraphQL() below.
export const MAX_COST = 500;

interface RevenueSummaryResponse {
  invoices: {
    totalCount: number;
    nodes: Array<{ id: string; amounts: { total: number }; issuedDate: string }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

function quarterOf(date: Date): string {
  return `Q${Math.floor(date.getUTCMonth() / 3) + 1}-${date.getUTCFullYear()}`;
}

function monthOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function registerRevenueSummaryTool(server: McpServer): void {
  registerReadOnlyTool(
    server,
    "revenue_summary",
    {
      description: "Return paid Jobber invoices grouped by month and by quarter, with totals.",
      inputSchema: {
        date_from: z.string().describe("Start of the date range (ISO 8601)"),
        date_to: z.string().describe("End of the date range (ISO 8601)"),
        page_size: pageSizeSchema(PAGE_CAP).describe(`Max invoices to scan (1-${PAGE_CAP})`),
        cursor: cursorSchema(),
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
        returned_so_far = 0,
      }: {
        date_from: string;
        date_to: string;
        page_size: number;
        cursor?: string;
        returned_so_far?: number;
      },
      jobberGraphQL
    ) => {
      const data = await jobberGraphQL<RevenueSummaryResponse>(REVENUE_SUMMARY_QUERY, {
        from: date_from,
        to: date_to,
        first: page_size,
        after: cursor,
      });

      const byMonth = new Map<string, number>();
      const byQuarter = new Map<string, number>();
      let grandTotal = 0;

      for (const inv of data.invoices.nodes) {
        const date = new Date(inv.issuedDate);
        const month = monthOf(date);
        const quarter = quarterOf(date);
        byMonth.set(month, (byMonth.get(month) ?? 0) + inv.amounts.total);
        byQuarter.set(quarter, (byQuarter.get(quarter) ?? 0) + inv.amounts.total);
        grandTotal += inv.amounts.total;
      }

      await appendAuditLog({
        tool: "revenue_summary",
        args: { date_from, date_to, page_size, cursor },
        outcome: "success",
        result_count: data.invoices.nodes.length,
      });

      const { returned_so_far: returnedSoFar, remaining } = pageProgress(
        data.invoices.totalCount,
        data.invoices.nodes.length,
        returned_so_far
      );
      const result: Record<string, unknown> = {
        total_revenue: roundMoney(grandTotal),
        // Jobber's GraphQL schema exposes no currency field on Account/Client/Invoice - this is
        // the honest, permanent answer, not an unfinished placeholder.
        currency: "unknown",
        date_from,
        date_to,
        by_month: Object.fromEntries([...byMonth].map(([k, v]) => [k, roundMoney(v)])),
        by_quarter: Object.fromEntries([...byQuarter].map(([k, v]) => [k, roundMoney(v)])),
        returned_so_far: returnedSoFar,
      };
      if (data.invoices.pageInfo.hasNextPage) {
        result.note =
          remaining > 0
            ? `${remaining} more available - summary reflects only the scanned page`
            : "more available - summary reflects only the scanned page";
        result.next_cursor = data.invoices.pageInfo.endCursor;
      }

      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );
}
