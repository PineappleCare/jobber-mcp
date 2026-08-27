import type { McpServer } from "@modelcontextprotocol/server";
import { registerReadOnlyTool, pageSizeSchema, cursorSchema, roundMoney, returnedSoFarSchema, pageProgress } from "../tool-helpers.js";
import { OVERDUE_INVOICES_QUERY } from "../jobber/queries.js";
import { appendAuditLog } from "../utils/auditLog.js";

const PAGE_CAP = 20;
// measured via scripts/measure-costs.mjs - see README cost table. Sole enforcement point:
// passed directly to jobberGraphQL() below.
export const MAX_COST = 250;

interface OverdueInvoicesResponse {
  invoices: {
    totalCount: number;
    nodes: Array<{
      id: string;
      invoiceNumber: string;
      client: { id: string; name: string };
      amounts: { total: number; invoiceBalance: number };
      dueDate: string;
    }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

export function registerOverdueInvoicesTool(server: McpServer): void {
  registerReadOnlyTool(
    server,
    "overdue_invoices",
    {
      description:
        "Return unpaid Jobber invoices past their due date, oldest first, with the total owed on this page at the top " +
        "(use total_count/next_cursor to page through the rest).",
      inputSchema: {
        page_size: pageSizeSchema(PAGE_CAP).describe(`Max invoices to return (1-${PAGE_CAP})`),
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
      const data = await jobberGraphQL<OverdueInvoicesResponse>(OVERDUE_INVOICES_QUERY, {
        first: page_size,
        after: cursor,
      });

      const invoices = data.invoices.nodes.map((i) => ({
        id: i.id,
        invoice_number: i.invoiceNumber,
        client: i.client.name,
        total: roundMoney(i.amounts.total),
        amount_owing: roundMoney(i.amounts.invoiceBalance),
        due_date: i.dueDate,
      }));
      const totalOwing = roundMoney(invoices.reduce((sum, i) => sum + i.amount_owing, 0));

      await appendAuditLog({
        tool: "overdue_invoices",
        args: { page_size, cursor },
        outcome: "success",
        result_count: invoices.length,
      });

      const { returned_so_far: returnedSoFar, remaining } = pageProgress(
        data.invoices.totalCount,
        invoices.length,
        returned_so_far
      );
      const result: Record<string, unknown> = {
        total_owing_this_page: totalOwing,
        total_count: data.invoices.totalCount,
        // Jobber's GraphQL schema exposes no currency field on Account/Client/Invoice - this is
        // the honest, permanent answer, not an unfinished placeholder.
        currency: "unknown",
        returned_so_far: returnedSoFar,
        invoices,
      };
      if (data.invoices.pageInfo.hasNextPage) {
        result.note =
          remaining > 0
            ? `${remaining} more available - total_owing_this_page reflects only the scanned page`
            : "more available - total_owing_this_page reflects only the scanned page";
        result.next_cursor = data.invoices.pageInfo.endCursor;
      }

      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );
}
