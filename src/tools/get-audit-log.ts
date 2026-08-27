import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerReadOnlyTool } from "../tool-helpers.js";
import { readAuditLog, appendAuditLog } from "../utils/auditLog.js";

// Unlike every other tool here, this doesn't call Jobber's GraphQL API - it reads this server's
// own local audit log (~/.jobber-mcp/audit.log), so there's no MAX_COST/cost-governor involvement.
// Pagination is offset/limit (readAuditLog's native shape) rather than a Jobber-style cursor, since
// there's no Jobber connection/cursor behind this data.
export function registerGetAuditLogTool(server: McpServer): void {
  registerReadOnlyTool(
    server,
    "get_audit_log",
    {
      description:
        "Read this server's own local audit log (every tool call, success or error). Useful for reviewing " +
        "what this connector has done. Entries are already redacted (see the audit log docs) before being read.",
      inputSchema: {
        date_from: z.string().optional().describe("Only entries on/after this date (YYYY-MM-DD)"),
        date_to: z.string().optional().describe("Only entries on/before this date (YYYY-MM-DD)"),
        limit: z.number().int().min(1).max(1000).optional().describe("Max entries to return (default 500, max 1000)"),
        offset: z.number().int().min(0).optional().describe("Entries to skip, for pagination - echo back next_offset"),
      },
    },
    async ({
      date_from,
      date_to,
      limit,
      offset,
    }: {
      date_from?: string;
      date_to?: string;
      limit?: number;
      offset?: number;
    }) => {
      const { entries, total_matched, truncated, corrupted_lines } = await readAuditLog({
        date_from,
        date_to,
        limit,
        offset,
      });

      await appendAuditLog({
        tool: "get_audit_log",
        args: { date_from, date_to, limit, offset },
        outcome: "success",
        result_count: entries.length,
      });

      const result: Record<string, unknown> = {
        total_matched,
        returned: entries.length,
        entries,
        ...(corrupted_lines > 0 && { corrupted_lines }),
      };
      if (truncated) {
        result.note = `${total_matched - (offset ?? 0) - entries.length} more available`;
        result.next_offset = (offset ?? 0) + entries.length;
      }

      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );
}
