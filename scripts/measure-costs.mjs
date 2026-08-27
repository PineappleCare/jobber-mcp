#!/usr/bin/env node
// Runs every read-only tool against a real, authenticated Jobber developer
// account and prints a Markdown table of measured GraphQL cost. Requires:
//   1. `npm run build` first (this script imports from build/, not src/).
//   2. A stored, valid Jobber session - run `authenticate` once first
//      (e.g. via `npm run inspect`) so ~/.jobber-mcp/tokens.enc exists.
//   3. At least one real client in the account, so client_history has a
//      real client_id to query (pass CLI arg: --client-id=<id>, or the
//      script falls back to the first result from find_client).
//
// The numbers in the README's cost table MUST come from this script's
// output, not be hand-typed.
//
// The client_history (payments_cursor continuation) row needs a client with an
// invoice that has more than 5 payment records - uncommon, since most invoices
// are paid in one shot. Pass --client-id=<id> for a client known to have one;
// otherwise the row is skipped with a note rather than measured.
import dotenv from "dotenv";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, "../.env") });

const { getGovernorForSession } = await import("../build/jobber/client.js");
const { registerFindClientTool, MAX_COST: FIND_CLIENT_MAX } = await import("../build/tools/find-client.js");
const {
  registerClientHistoryTool,
  MAX_COST: CLIENT_HISTORY_MAX,
  PAYMENTS_PAGE_MAX_COST,
} = await import("../build/tools/client-history.js");
const { registerOverdueInvoicesTool, MAX_COST: OVERDUE_INVOICES_MAX } = await import("../build/tools/overdue-invoices.js");
const { registerQuotesOutstandingTool, MAX_COST: QUOTES_OUTSTANDING_MAX } = await import("../build/tools/quotes-outstanding.js");
const { registerJobsSummaryTool, MAX_COST: JOBS_SUMMARY_MAX } = await import("../build/tools/jobs-summary.js");
const { registerRevenueSummaryTool, MAX_COST: REVENUE_SUMMARY_MAX } = await import("../build/tools/revenue-summary.js");
const { registerScheduleLookupTool, MAX_COST: SCHEDULE_LOOKUP_MAX } = await import("../build/tools/schedule-lookup.js");
const { registerRequestsInboxTool, MAX_COST: REQUESTS_INBOX_MAX } = await import("../build/tools/requests-inbox.js");

const clientIdArg = process.argv.find((a) => a.startsWith("--client-id="))?.split("=")[1];

const tools = {};
const capture = { registerTool: (name, config, handler) => { tools[name] = handler; } };
registerFindClientTool(capture);
registerClientHistoryTool(capture);
registerOverdueInvoicesTool(capture);
registerQuotesOutstandingTool(capture);
registerJobsSummaryTool(capture);
registerRevenueSummaryTool(capture);
registerScheduleLookupTool(capture);
registerRequestsInboxTool(capture);

const declaredMax = {
  find_client: FIND_CLIENT_MAX,
  client_history: CLIENT_HISTORY_MAX,
  overdue_invoices: OVERDUE_INVOICES_MAX,
  quotes_outstanding: QUOTES_OUTSTANDING_MAX,
  jobs_summary: JOBS_SUMMARY_MAX,
  revenue_summary: REVENUE_SUMMARY_MAX,
  schedule_lookup: SCHEDULE_LOOKUP_MAX,
  requests_inbox: REQUESTS_INBOX_MAX,
};

const today = new Date().toISOString().slice(0, 10);
const yearAgo = new Date(Date.now() - 365 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);

async function resolveClientId() {
  if (clientIdArg) return clientIdArg;
  const result = await tools.find_client({ search_term: "a", page_size: 1 });
  const parsed = JSON.parse(result.content[0].text);
  return parsed.clients?.[0]?.id ?? null;
}

async function main() {
  const clientId = await resolveClientId();
  if (!clientId) {
    console.error(
      "[measure-costs] No client found to run client_history against. " +
      "Pass --client-id=<id> or ensure the developer account has at least one client."
    );
  }

  const runs = [
    ["find_client", { search_term: "a", page_size: 20 }],
    clientId ? ["client_history", { client_id: clientId, page_size: 20 }] : null,
    ["overdue_invoices", { page_size: 20 }],
    ["quotes_outstanding", { page_size: 20 }],
    // page_size is capped at 20 for every tool (enforced by Zod .max() in the
    // real MCP path), and this harness calls the captured handler directly,
    // bypassing that validation - so these must match the real cap by hand
    // to measure a cost a real caller could actually trigger.
    ["jobs_summary", { date_from: yearAgo, date_to: today, page_size: 20 }],
    ["revenue_summary", { date_from: yearAgo, date_to: today, page_size: 20 }],
    ["schedule_lookup", { date_from: yearAgo, date_to: today, page_size: 20 }],
    ["requests_inbox", { page_size: 20 }],
  ].filter(Boolean);

  const rows = [];
  let hadError = false;
  let clientHistoryResult = null;
  for (const [name, args] of runs) {
    const before = Date.now();
    const result = await tools[name](args);
    const elapsedMs = Date.now() - before;
    if (result.isError) {
      console.error(`[measure-costs] ${name} returned an error: ${result.content[0].text}`);
      rows.push({ name, typical: "ERROR", max: declaredMax[name] });
      hadError = true;
      continue;
    }
    const cost = getGovernorForSession(undefined).getLastCost();
    rows.push({ name, typical: cost?.actualQueryCost ?? "?", max: declaredMax[name] });
    console.error(`[measure-costs] ${name}: actualQueryCost=${cost?.actualQueryCost ?? "?"} (${elapsedMs}ms)`);
    if (name === "client_history") clientHistoryResult = result;
  }

  // The payments_cursor continuation (CLIENT_HISTORY_PAYMENTS_PAGE_QUERY) is a
  // separate query, only reachable by feeding back a payments.next_cursor from
  // the client_history run above - it can't be driven from a fixed args list
  // the way every other row is.
  if (clientHistoryResult) {
    const parsed = JSON.parse(clientHistoryResult.content[0].text);
    const paymentsCursor = parsed.payments?.next_cursor;
    const rowName = "client_history (payments_cursor continuation)";
    if (paymentsCursor) {
      const before = Date.now();
      const result = await tools.client_history({ client_id: clientId, payments_cursor: paymentsCursor });
      const elapsedMs = Date.now() - before;
      if (result.isError) {
        console.error(`[measure-costs] ${rowName} returned an error: ${result.content[0].text}`);
        rows.push({ name: rowName, typical: "ERROR", max: PAYMENTS_PAGE_MAX_COST });
        hadError = true;
      } else {
        const cost = getGovernorForSession(undefined).getLastCost();
        rows.push({ name: rowName, typical: cost?.actualQueryCost ?? "?", max: PAYMENTS_PAGE_MAX_COST });
        console.error(`[measure-costs] ${rowName}: actualQueryCost=${cost?.actualQueryCost ?? "?"} (${elapsedMs}ms)`);
      }
    } else {
      console.error(
        `[measure-costs] Skipping "${rowName}" - no invoice on the measured client's first page has enough ` +
        "payment records to overflow a page. Pass --client-id=<id> for a client with such an invoice to measure this row."
      );
    }
  }

  console.log("| tool | typical cost | max cost |");
  console.log("|------|--------------|----------|");
  for (const row of rows) {
    console.log(`| ${row.name} | ${row.typical} | ${row.max} |`);
  }

  if (hadError) {
    console.error(
      "[measure-costs] One or more tools errored during measurement - do not paste this table into the README until every row has a real number."
    );
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("[measure-costs] Fatal error:", err.message);
  process.exit(1);
});
