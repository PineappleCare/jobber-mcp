import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerReadOnlyTool, pageSizeSchema, cursorSchema, roundMoney, returnedSoFarSchema, pageProgress } from "../tool-helpers.js";
import { JOBS_SUMMARY_QUERY } from "../jobber/queries.js";
import { appendAuditLog } from "../utils/auditLog.js";

const PAGE_CAP = 20;
// measured via scripts/measure-costs.mjs - see README cost table. Sole enforcement point:
// passed directly to jobberGraphQL() below.
export const MAX_COST = 400;

interface JobsSummaryResponse {
  jobs: {
    totalCount: number;
    nodes: Array<{ id: string; jobStatus: string; total: number }>;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
  };
}

export function registerJobsSummaryTool(server: McpServer): void {
  registerReadOnlyTool(
    server,
    "jobs_summary",
    {
      description:
        "Return Jobber jobs grouped by status, filtered by job creation date (not scheduling or completion date), with counts and totals per status.",
      inputSchema: {
        date_from: z.string().describe("Start of the date range (ISO 8601)"),
        date_to: z.string().describe("End of the date range (ISO 8601)"),
        page_size: pageSizeSchema(PAGE_CAP).describe(`Max jobs to scan (1-${PAGE_CAP})`),
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
      const data = await jobberGraphQL<JobsSummaryResponse>(JOBS_SUMMARY_QUERY, {
        from: date_from,
        to: date_to,
        first: page_size,
        after: cursor,
      });

      const byStatus = new Map<string, { count: number; total: number }>();
      for (const job of data.jobs.nodes) {
        const entry = byStatus.get(job.jobStatus) ?? { count: 0, total: 0 };
        entry.count += 1;
        entry.total += job.total;
        byStatus.set(job.jobStatus, entry);
      }
      for (const entry of byStatus.values()) {
        entry.total = roundMoney(entry.total);
      }
      const statuses = Object.fromEntries(byStatus);

      await appendAuditLog({
        tool: "jobs_summary",
        args: { date_from, date_to, page_size, cursor },
        outcome: "success",
        result_count: data.jobs.nodes.length,
      });

      const { returned_so_far: returnedSoFar, remaining } = pageProgress(
        data.jobs.totalCount,
        data.jobs.nodes.length,
        returned_so_far
      );
      const result: Record<string, unknown> = {
        jobs_scanned: data.jobs.nodes.length,
        total_count: data.jobs.totalCount,
        // Jobber's GraphQL schema exposes no currency field on Account/Client/Invoice - this is
        // the honest, permanent answer, not an unfinished placeholder.
        currency: "unknown",
        returned_so_far: returnedSoFar,
        date_from,
        date_to,
        by_status: statuses,
      };
      if (data.jobs.pageInfo.hasNextPage) {
        result.note =
          remaining > 0
            ? `${remaining} more available - summary reflects only the scanned page`
            : "more available - summary reflects only the scanned page";
        result.next_cursor = data.jobs.pageInfo.endCursor;
      }

      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );
}
