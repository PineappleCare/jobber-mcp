import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerReadOnlyTool, pageSizeSchema, cursorSchema, roundMoney, returnedSoFarSchema, pageProgress } from "../tool-helpers.js";
import type { CostedGraphQL } from "../tool-helpers.js";
import { CLIENT_HISTORY_QUERY, CLIENT_HISTORY_PAYMENTS_PAGE_QUERY } from "../jobber/queries.js";
import { appendAuditLog } from "../utils/auditLog.js";

const PAGE_CAP = 20;
// Nested payment records per invoice - fixed and independent of page_size so
// query cost (which multiplies across the invoices/paymentRecords nesting)
// doesn't grow with it.
const PAYMENTS_PER_INVOICE = 5;
// measured via scripts/measure-costs.mjs - see README cost table. Sole enforcement point:
// declared as maxCost.main below, bound into the jobberGraphQL passed to the handler by
// registerReadOnlyTool.
export const MAX_COST = 50;
// Measured live against Jobber 2026-08-26: actualQueryCost ranged 14-26 depending on how many
// payment records the page returned, capping at requestedQueryCost (26, fixed by this query's
// shape/page size regardless of data). 20 previously under-reserved this - bump matches the
// real ceiling.
export const PAYMENTS_PAGE_MAX_COST = 26;

type ClientHistoryCost = { main: number; paymentsPage: number };

interface Connection<T> {
  totalCount: number;
  nodes: T[];
  pageInfo: { hasNextPage: boolean; endCursor?: string | null };
}

interface ClientHistoryResponse {
  client: {
    id: string;
    name: string;
    jobs: Connection<{ id: string; jobNumber: string; title: string | null; jobStatus: string; total: number }>;
    quotes: Connection<{ id: string; quoteNumber: string; title: string | null; quoteStatus: string; amounts: { total: number } }>;
    invoices: Connection<{
      id: string;
      invoiceNumber: string;
      invoiceStatus: string;
      amounts: { total: number };
      dueDate: string | null;
      paymentRecords: Connection<{ id: string; amount: number; paidAt: string }>;
    }>;
  } | null;
}

interface InvoicePaymentsPageResponse {
  invoice: {
    id: string;
    invoiceNumber: string;
    client: { id: string } | null;
    paymentRecords: Connection<{ id: string; amount: number; paidAt: string }>;
  } | null;
}

// Payments live nested per-invoice with no client-level connection, so a single next_cursor for
// "more payments" has to identify *which* invoice to continue. Relay cursors are scoped to one
// connection, so we can't reuse a jobs/quotes/invoices-style single shared cursor variable across
// several different invoices' paymentRecords connections - this cursor instead carries enough
// state (the invoice to resume, its position, and which other invoices from the same original page
// still have more payments) to walk all of them one invoice at a time via a dedicated query.
interface PaymentsCursorPayload {
  invoice_id: string;
  after: string | null;
  remaining_invoice_ids: string[];
}

function encodePaymentsCursor(payload: PaymentsCursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodePaymentsCursor(cursor: string): PaymentsCursorPayload | null {
  try {
    const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
    if (typeof payload?.invoice_id !== "string") return null;
    return {
      invoice_id: payload.invoice_id,
      after: typeof payload.after === "string" ? payload.after : null,
      remaining_invoice_ids: Array.isArray(payload.remaining_invoice_ids)
        ? payload.remaining_invoice_ids.filter((x: unknown): x is string => typeof x === "string")
        : [],
    };
  } catch {
    return null;
  }
}

function section<T>(conn: Connection<T>, mapItem: (item: T) => unknown, previousReturned: number) {
  const items = conn.nodes.map(mapItem);
  const { returned_so_far, remaining } = pageProgress(conn.totalCount, items.length, previousReturned);
  return {
    total_count: conn.totalCount,
    returned_so_far,
    items,
    ...(conn.pageInfo.hasNextPage
      ? {
          note: remaining > 0 ? `${remaining} more available` : "more available",
          next_cursor: conn.pageInfo.endCursor ?? null,
        }
      : {}),
  };
}

/**
 * Continues fetching payments for whichever invoice(s) (from the original client_history page)
 * had more than PAYMENTS_PER_INVOICE payment records - one invoice at a time, via
 * CLIENT_HISTORY_PAYMENTS_PAGE_QUERY. Returns only a `payments` section (there's no cheap way to
 * also re-fetch jobs/quotes/invoices without doubling cost); callers who also want a fresh
 * jobs/quotes/invoices page should make a separate normal client_history call.
 */
async function handlePaymentsContinuation(
  client_id: string,
  payments_cursor: string,
  payments_returned_so_far: number,
  jobberGraphQL: CostedGraphQL<ClientHistoryCost>
): Promise<{ content: Array<{ type: "text"; text: string }> }> {
  const decoded = decodePaymentsCursor(payments_cursor);
  if (!decoded) {
    await appendAuditLog({
      tool: "client_history",
      args: { client_id, payments_cursor },
      outcome: "error",
      error_message: "Invalid payments_cursor",
    });
    return { content: [{ type: "text", text: "Error: invalid payments_cursor." }] };
  }

  const data = await jobberGraphQL<InvoicePaymentsPageResponse>(
    CLIENT_HISTORY_PAYMENTS_PAGE_QUERY,
    { invoiceId: decoded.invoice_id, first: PAYMENTS_PER_INVOICE, after: decoded.after },
    "paymentsPage"
  );

  // The invoice must belong to the requested client - payments_cursor is server-generated and
  // opaque, but nothing stops a caller from replaying/editing one, so this is checked rather than
  // trusted, the same way any other cross-tenant lookup would be.
  if (!data.invoice || data.invoice.client?.id !== client_id) {
    await appendAuditLog({
      tool: "client_history",
      args: { client_id, payments_cursor },
      outcome: "not_found",
    });
    return { content: [{ type: "text", text: `Invoice for payments_cursor not found on client ${client_id}.` }] };
  }

  const { invoice } = data;
  const items = invoice.paymentRecords.nodes.map((p) => ({
    id: p.id,
    amount: roundMoney(p.amount),
    paid_at: p.paidAt,
    invoice_id: invoice.id,
    invoice_number: invoice.invoiceNumber,
  }));
  const returned_so_far = payments_returned_so_far + items.length;

  let next: { note: string; next_cursor: string } | Record<string, never> = {};
  if (invoice.paymentRecords.pageInfo.hasNextPage) {
    next = {
      note: "more payments available for this invoice",
      next_cursor: encodePaymentsCursor({
        invoice_id: invoice.id,
        after: invoice.paymentRecords.pageInfo.endCursor ?? null,
        remaining_invoice_ids: decoded.remaining_invoice_ids,
      }),
    };
  } else if (decoded.remaining_invoice_ids.length > 0) {
    const [nextInvoiceId, ...rest] = decoded.remaining_invoice_ids;
    next = {
      note: "more payments available on another invoice from the original page",
      next_cursor: encodePaymentsCursor({ invoice_id: nextInvoiceId, after: null, remaining_invoice_ids: rest }),
    };
  }

  const result = { payments: { returned_so_far, items, ...next } };

  await appendAuditLog({
    tool: "client_history",
    args: { client_id, payments_cursor },
    outcome: "success",
    result_count: items.length,
  });

  return { content: [{ type: "text", text: JSON.stringify(result) }] };
}

export function registerClientHistoryTool(server: McpServer): void {
  registerReadOnlyTool(
    server,
    "client_history",
    {
      description:
        "Return a Jobber client's jobs, quotes, invoices, and payments. Pass payments_cursor alone (with " +
        "client_id) to continue fetching payments for an invoice that had more than fit on the original page " +
        "- that call returns only the payments section, not a fresh jobs/quotes/invoices page.",
      inputSchema: {
        client_id: z.string().min(1).describe("The Jobber client ID, obtained from a prior find_client call's clients[].id"),
        page_size: pageSizeSchema(PAGE_CAP).describe(`Max items per section (1-${PAGE_CAP})`),
        jobs_cursor: cursorSchema().describe("Cursor from a previous response's jobs.next_cursor"),
        quotes_cursor: cursorSchema().describe("Cursor from a previous response's quotes.next_cursor"),
        invoices_cursor: cursorSchema().describe("Cursor from a previous response's invoices.next_cursor"),
        jobs_returned_so_far: returnedSoFarSchema().describe("Echo back the previous response's jobs.returned_so_far"),
        quotes_returned_so_far: returnedSoFarSchema().describe("Echo back the previous response's quotes.returned_so_far"),
        invoices_returned_so_far: returnedSoFarSchema().describe("Echo back the previous response's invoices.returned_so_far"),
        payments_cursor: cursorSchema().describe(
          "Cursor from a previous response's payments.next_cursor - continues payments for the invoice(s) " +
          "that had more, instead of a fresh jobs/quotes/invoices page"
        ),
        payments_returned_so_far: returnedSoFarSchema().describe("Echo back the previous response's payments.returned_so_far"),
      },
      maxCost: { main: MAX_COST, paymentsPage: PAYMENTS_PAGE_MAX_COST },
    },
    async (
      {
        client_id,
        page_size,
        jobs_cursor,
        quotes_cursor,
        invoices_cursor,
        jobs_returned_so_far = 0,
        quotes_returned_so_far = 0,
        invoices_returned_so_far = 0,
        payments_cursor,
        payments_returned_so_far = 0,
      }: {
        client_id: string;
        page_size: number;
        jobs_cursor?: string;
        quotes_cursor?: string;
        invoices_cursor?: string;
        jobs_returned_so_far?: number;
        quotes_returned_so_far?: number;
        invoices_returned_so_far?: number;
        payments_cursor?: string;
        payments_returned_so_far?: number;
      },
      jobberGraphQL
    ) => {
      if (payments_cursor) {
        return handlePaymentsContinuation(client_id, payments_cursor, payments_returned_so_far, jobberGraphQL);
      }

      const data = await jobberGraphQL<ClientHistoryResponse>(
        CLIENT_HISTORY_QUERY,
        {
          clientId: client_id,
          first: page_size,
          afterJobs: jobs_cursor,
          afterQuotes: quotes_cursor,
          afterInvoices: invoices_cursor,
          paymentsFirst: PAYMENTS_PER_INVOICE,
        },
        "main"
      );

      if (!data.client) {
        await appendAuditLog({
          tool: "client_history",
          args: {
            client_id,
            page_size,
            jobs_cursor,
            quotes_cursor,
            invoices_cursor,
            jobs_returned_so_far,
            quotes_returned_so_far,
            invoices_returned_so_far,
          },
          outcome: "not_found",
        });
        return { content: [{ type: "text", text: `Client ${client_id} not found.` }] };
      }

      const { client } = data;

      // Client has no client-level "payments" connection - payment records
      // live on each invoice, so the payments section is built by flattening
      // across the invoices fetched above rather than via the generic
      // section() helper.
      const paymentItems = client.invoices.nodes.flatMap((i) =>
        i.paymentRecords.nodes.map((p) => ({
          id: p.id,
          amount: roundMoney(p.amount),
          paid_at: p.paidAt,
          invoice_id: i.id,
          invoice_number: i.invoiceNumber,
        }))
      );
      const paymentsTotalCount = client.invoices.nodes.reduce((sum, i) => sum + i.paymentRecords.totalCount, 0);
      // totalCount above only covers invoices actually fetched - if more
      // invoices exist beyond this page, their payments aren't counted at
      // all, so a numeric "N more" would understate it. Only give a precise
      // count when every invoice was fetched and it's just their per-invoice
      // payment lists that were capped.
      const invoicesNeedingMorePayments = client.invoices.nodes.filter((i) => i.paymentRecords.pageInfo.hasNextPage);
      const paymentsRemaining = Math.max(0, paymentsTotalCount - paymentItems.length);

      // Only offer a payments continuation cursor when every invoice on this page was fetched -
      // if more invoices exist beyond it too, the "more may exist" caveat below takes priority,
      // since paymentsTotalCount/paymentsRemaining only cover invoices actually fetched here.
      let paymentsNext: { note: string; next_cursor: string } | Record<string, never> = {};
      if (!client.invoices.pageInfo.hasNextPage && invoicesNeedingMorePayments.length > 0 && paymentsRemaining > 0) {
        const [first, ...rest] = invoicesNeedingMorePayments;
        paymentsNext = {
          note: `${paymentsRemaining} more available`,
          next_cursor: encodePaymentsCursor({
            invoice_id: first.id,
            after: first.paymentRecords.pageInfo.endCursor ?? null,
            remaining_invoice_ids: rest.map((i) => i.id),
          }),
        };
      }

      const result = {
        client: { id: client.id, name: client.name },
        // Jobber's GraphQL schema exposes no currency field on Account/Client/Invoice - this is
        // the honest, permanent answer, not an unfinished placeholder.
        currency: "unknown",
        jobs: section(client.jobs, (j) => ({ id: j.id, job_number: j.jobNumber, title: j.title, status: j.jobStatus, total: roundMoney(j.total) }), jobs_returned_so_far),
        quotes: section(client.quotes, (q) => ({ id: q.id, quote_number: q.quoteNumber, title: q.title, status: q.quoteStatus, total: roundMoney(q.amounts.total) }), quotes_returned_so_far),
        invoices: section(client.invoices, (i) => ({ id: i.id, invoice_number: i.invoiceNumber, status: i.invoiceStatus, total: roundMoney(i.amounts.total), due_date: i.dueDate }), invoices_returned_so_far),
        payments: {
          total_count: paymentsTotalCount,
          items: paymentItems,
          ...(client.invoices.pageInfo.hasNextPage
            ? { note: "more may exist on invoices not fetched in this page" }
            : paymentsNext),
        },
      };

      await appendAuditLog({
        tool: "client_history",
        args: {
          client_id,
          page_size,
          jobs_cursor,
          quotes_cursor,
          invoices_cursor,
          jobs_returned_so_far,
          quotes_returned_so_far,
          invoices_returned_so_far,
        },
        outcome: "success",
        result_count: result.jobs.items.length + result.quotes.items.length + result.invoices.items.length + result.payments.items.length,
      });

      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    }
  );
}
