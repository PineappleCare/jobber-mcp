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
import { registerFoundationalTools } from "./tools/foundations.js";
import { registerJobStatusTool } from "./tools/job-status.js";
import { isReadOnly, isWriteCapabilityEnabled } from "./tool-helpers.js";

/**
 * Registers every tool and resource. Fixed reviewed reads are always present;
 * writes require both the hard read-only kill switch and a narrow capability.
 * There is never a raw/passthrough GraphQL tool.
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
  registerFoundationalTools(server);
  if (!isReadOnly() && isWriteCapabilityEnabled("scheduling")) registerJobStatusTool(server);
}
