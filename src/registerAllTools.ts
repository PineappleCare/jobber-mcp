import type { McpServer } from "@modelcontextprotocol/server";
import { registerAuthTools } from "./auth/authTools.js";
import { registerResources } from "./resources/index.js";
import { registerFindClientTool } from "./tools/find-client.js";
import { registerClientHistoryTool } from "./tools/client-history.js";
import { registerOverdueInvoicesTool } from "./tools/overdue-invoices.js";
import { registerQuotesOutstandingTool } from "./tools/quotes-outstanding.js";
import { registerJobsSummaryTool } from "./tools/jobs-summary.js";
import { registerRevenueSummaryTool } from "./tools/revenue-summary.js";
import { registerScheduleLookupTool } from "./tools/schedule-lookup.js";
import { registerRequestsInboxTool } from "./tools/requests-inbox.js";
import { registerGetAuditLogTool } from "./tools/get-audit-log.js";

/**
 * Registers every v1 tool and resource. All tools are read-only; no write
 * tool is registered here regardless of JOBBER_READ_ONLY, and there is no
 * raw/passthrough GraphQL tool. get_audit_log is the one exception to
 * "every tool queries Jobber" - it reads this server's own local audit log.
 */
export function registerAllTools(server: McpServer): void {
  registerAuthTools(server);
  registerResources(server);
  registerFindClientTool(server);
  registerClientHistoryTool(server);
  registerOverdueInvoicesTool(server);
  registerQuotesOutstandingTool(server);
  registerJobsSummaryTool(server);
  registerRevenueSummaryTool(server);
  registerScheduleLookupTool(server);
  registerRequestsInboxTool(server);
  registerGetAuditLogTool(server);
}
