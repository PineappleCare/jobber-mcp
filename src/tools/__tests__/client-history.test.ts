import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

const { mockJobberGraphQL, mockAppendAuditLog } = vi.hoisted(() => ({
  mockJobberGraphQL: vi.fn(),
  mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../jobber/client.js", () => ({ jobberGraphQL: mockJobberGraphQL }));
vi.mock("../../utils/auditLog.js", () => ({ appendAuditLog: mockAppendAuditLog }));

import { registerClientHistoryTool } from "../client-history.js";

const handlers: Record<string, (args?: any) => Promise<any>> = {};
const fakeServer = {
  registerTool: vi.fn((name: string, _schema: any, handler: (args?: any) => Promise<any>) => {
    handlers[name] = handler;
  }),
};

beforeAll(() => {
  registerClientHistoryTool(fakeServer as any);
});

beforeEach(() => {
  vi.clearAllMocks();
});

const FULL_CLIENT = {
  id: "c1",
  name: "Acme Corp",
  jobs: {
    totalCount: 1,
    nodes: [{ id: "j1", jobNumber: "J-1", title: "Fix roof", jobStatus: "active", total: 500 }],
    pageInfo: { hasNextPage: false },
  },
  quotes: {
    totalCount: 1,
    nodes: [{ id: "q1", quoteNumber: "Q-1", title: "Roof quote", quoteStatus: "awaiting_response", amounts: { total: 600 } }],
    pageInfo: { hasNextPage: false },
  },
  invoices: {
    totalCount: 1,
    nodes: [
      {
        id: "i1",
        invoiceNumber: "I-1",
        invoiceStatus: "paid",
        amounts: { total: 500 },
        dueDate: "2026-01-01",
        paymentRecords: {
          totalCount: 1,
          nodes: [{ id: "p1", amount: 500, paidAt: "2026-01-02T00:00:00Z" }],
          pageInfo: { hasNextPage: false },
        },
      },
    ],
    pageInfo: { hasNextPage: false },
  },
};

describe("client_history", () => {
  it("passes client_id and page_size through with the declared max cost", async () => {
    mockJobberGraphQL.mockResolvedValue({ client: FULL_CLIENT });
    await handlers["client_history"]({ client_id: "c1", page_size: 5 });
    expect(mockJobberGraphQL).toHaveBeenCalledWith(
      expect.any(String),
      { clientId: "c1", first: 5, paymentsFirst: 5 },
      expect.any(Number)
    );
  });

  it("flattens jobs/quotes/invoices/payments into compact sections", async () => {
    mockJobberGraphQL.mockResolvedValue({ client: FULL_CLIENT });
    const result = await handlers["client_history"]({ client_id: "c1", page_size: 5 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.client).toEqual({ id: "c1", name: "Acme Corp" });
    expect(parsed.jobs.items[0]).toEqual({ id: "j1", job_number: "J-1", title: "Fix roof", status: "active", total: 500 });
    expect(parsed.quotes.items[0]).toEqual({ id: "q1", quote_number: "Q-1", title: "Roof quote", status: "awaiting_response", total: 600 });
    expect(parsed.invoices.items[0]).toEqual({ id: "i1", invoice_number: "I-1", status: "paid", total: 500, due_date: "2026-01-01" });
    expect(parsed.payments.items[0]).toEqual({
      id: "p1",
      amount: 500,
      paid_at: "2026-01-02T00:00:00Z",
      invoice_id: "i1",
      invoice_number: "I-1",
    });
  });

  it("adds a per-section 'N more available' note and next_cursor when a section has more results", async () => {
    mockJobberGraphQL.mockResolvedValue({
      client: {
        ...FULL_CLIENT,
        jobs: { totalCount: 5, nodes: [FULL_CLIENT.jobs.nodes[0]], pageInfo: { hasNextPage: true, endCursor: "jobs-cursor" } },
      },
    });
    const result = await handlers["client_history"]({ client_id: "c1", page_size: 1 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.jobs.note).toBe("4 more available");
    expect(parsed.jobs.next_cursor).toBe("jobs-cursor");
    expect(parsed.quotes.note).toBeUndefined();
    expect(parsed.payments.note).toBeUndefined();
  });

  it("accounts for items already returned by prior pages when computing a section's remaining", async () => {
    mockJobberGraphQL.mockResolvedValue({
      client: {
        ...FULL_CLIENT,
        jobs: { totalCount: 3, nodes: [FULL_CLIENT.jobs.nodes[0]], pageInfo: { hasNextPage: true, endCursor: "jobs-cursor-2" } },
      },
    });
    const result = await handlers["client_history"]({ client_id: "c1", page_size: 1, jobs_cursor: "jobs-cursor-1", jobs_returned_so_far: 1 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.jobs.returned_so_far).toBe(2);
    expect(parsed.jobs.note).toBe("1 more available");
  });

  it("reports zero remaining and no next_cursor for a section once its running total reaches totalCount", async () => {
    mockJobberGraphQL.mockResolvedValue({
      client: {
        ...FULL_CLIENT,
        jobs: { totalCount: 2, nodes: [FULL_CLIENT.jobs.nodes[0]], pageInfo: { hasNextPage: false } },
      },
    });
    const result = await handlers["client_history"]({ client_id: "c1", page_size: 1, jobs_returned_so_far: 1 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.jobs.returned_so_far).toBe(2);
    expect(parsed.jobs.note).toBeUndefined();
    expect(parsed.jobs.next_cursor).toBeUndefined();
  });

  it("surfaces a section's next_cursor even when a stale returned_so_far makes its remaining compute to 0, trusting Jobber's hasNextPage", async () => {
    mockJobberGraphQL.mockResolvedValue({
      client: {
        ...FULL_CLIENT,
        jobs: { totalCount: 2, nodes: [FULL_CLIENT.jobs.nodes[0]], pageInfo: { hasNextPage: true, endCursor: "jobs-cursor-more" } },
      },
    });
    const result = await handlers["client_history"]({ client_id: "c1", page_size: 1, jobs_returned_so_far: 100 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.jobs.next_cursor).toBe("jobs-cursor-more");
    expect(parsed.jobs.note).toBe("more available");
  });

  it("does not let one section's inflated returned_so_far suppress another section's next_cursor (each section is independent)", async () => {
    // jobs_returned_so_far is wildly inflated (mixed up with another section's count), but
    // quotes_returned_so_far is untouched - each section's pageProgress must be computed
    // independently, so quotes' own next_cursor must be unaffected by jobs' bad bookkeeping.
    mockJobberGraphQL.mockResolvedValue({
      client: {
        ...FULL_CLIENT,
        jobs: { totalCount: 5, nodes: [FULL_CLIENT.jobs.nodes[0]], pageInfo: { hasNextPage: true, endCursor: "jobs-cursor" } },
        quotes: { totalCount: 5, nodes: [FULL_CLIENT.quotes.nodes[0]], pageInfo: { hasNextPage: true, endCursor: "quotes-cursor" } },
      },
    });
    const result = await handlers["client_history"]({ client_id: "c1", page_size: 1, jobs_returned_so_far: 100 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.jobs.next_cursor).toBe("jobs-cursor");
    expect(parsed.jobs.note).toBe("more available");
    expect(parsed.quotes.next_cursor).toBe("quotes-cursor");
    expect(parsed.quotes.note).toBe("4 more available");
  });

  it("passes per-section cursors through to the GraphQL client as afterJobs/afterQuotes/afterInvoices", async () => {
    mockJobberGraphQL.mockResolvedValue({ client: FULL_CLIENT });
    await handlers["client_history"]({
      client_id: "c1",
      page_size: 5,
      jobs_cursor: "jobs-cursor",
      quotes_cursor: "quotes-cursor",
      invoices_cursor: "invoices-cursor",
    });
    expect(mockJobberGraphQL).toHaveBeenCalledWith(
      expect.any(String),
      {
        clientId: "c1",
        first: 5,
        afterJobs: "jobs-cursor",
        afterQuotes: "quotes-cursor",
        afterInvoices: "invoices-cursor",
        paymentsFirst: 5,
      },
      expect.any(Number)
    );
  });

  it("gives payments a precise count note when an invoice has more payment records than fetched", async () => {
    mockJobberGraphQL.mockResolvedValue({
      client: {
        ...FULL_CLIENT,
        invoices: {
          totalCount: 1,
          nodes: [
            {
              ...FULL_CLIENT.invoices.nodes[0],
              paymentRecords: { totalCount: 3, nodes: [{ id: "p1", amount: 500, paidAt: "2026-01-02T00:00:00Z" }], pageInfo: { hasNextPage: true } },
            },
          ],
          pageInfo: { hasNextPage: false },
        },
      },
    });
    const result = await handlers["client_history"]({ client_id: "c1", page_size: 5 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.payments.total_count).toBe(3);
    expect(parsed.payments.note).toBe("2 more available");
    expect(typeof parsed.payments.next_cursor).toBe("string");
  });

  it("gives payments a qualitative note when more invoices exist beyond the fetched page", async () => {
    mockJobberGraphQL.mockResolvedValue({
      client: {
        ...FULL_CLIENT,
        invoices: { ...FULL_CLIENT.invoices, pageInfo: { hasNextPage: true } },
      },
    });
    const result = await handlers["client_history"]({ client_id: "c1", page_size: 5 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.payments.note).toBe("more may exist on invoices not fetched in this page");
  });

  it("returns a not-found message and logs 'not_found' when the client doesn't exist", async () => {
    mockJobberGraphQL.mockResolvedValue({ client: null });
    const result = await handlers["client_history"]({ client_id: "missing", page_size: 5 });
    expect(result.content[0].text).toContain("not found");
    expect(mockAppendAuditLog).toHaveBeenCalledWith(expect.objectContaining({ tool: "client_history", outcome: "not_found" }));
  });

  it("logs a success audit entry with the combined result count", async () => {
    mockJobberGraphQL.mockResolvedValue({ client: FULL_CLIENT });
    await handlers["client_history"]({ client_id: "c1", page_size: 5 });
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "client_history", outcome: "success", result_count: 4 })
    );
  });

  describe("payments_cursor continuation", () => {
    function encodeCursor(payload: { invoice_id: string; after: string | null; remaining_invoice_ids: string[] }): string {
      return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
    }

    it("fetches more payments for the invoice named in the cursor, via the dedicated query", async () => {
      const cursor = encodeCursor({ invoice_id: "i1", after: "p-after-1", remaining_invoice_ids: [] });
      mockJobberGraphQL.mockResolvedValue({
        invoice: {
          id: "i1",
          invoiceNumber: "I-1",
          client: { id: "c1" },
          paymentRecords: {
            totalCount: 3,
            nodes: [{ id: "p2", amount: 100, paidAt: "2026-01-03T00:00:00Z" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });

      const result = await handlers["client_history"]({ client_id: "c1", payments_cursor: cursor });

      expect(mockJobberGraphQL).toHaveBeenCalledWith(
        expect.any(String),
        { invoiceId: "i1", first: 5, after: "p-after-1" },
        expect.any(Number)
      );
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.payments.items).toEqual([
        { id: "p2", amount: 100, paid_at: "2026-01-03T00:00:00Z", invoice_id: "i1", invoice_number: "I-1" },
      ]);
      expect(parsed.jobs).toBeUndefined();
      expect(parsed.client).toBeUndefined();
    });

    it("returns a next_cursor for the same invoice when it still has more payments", async () => {
      const cursor = encodeCursor({ invoice_id: "i1", after: null, remaining_invoice_ids: [] });
      mockJobberGraphQL.mockResolvedValue({
        invoice: {
          id: "i1",
          invoiceNumber: "I-1",
          client: { id: "c1" },
          paymentRecords: {
            totalCount: 10,
            nodes: [{ id: "p2", amount: 100, paidAt: "2026-01-03T00:00:00Z" }],
            pageInfo: { hasNextPage: true, endCursor: "p-after-2" },
          },
        },
      });

      const result = await handlers["client_history"]({ client_id: "c1", payments_cursor: cursor });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.payments.next_cursor).toBe(
        encodeCursor({ invoice_id: "i1", after: "p-after-2", remaining_invoice_ids: [] })
      );
    });

    it("moves on to the next remaining invoice once the current one is exhausted", async () => {
      const cursor = encodeCursor({ invoice_id: "i1", after: null, remaining_invoice_ids: ["i2", "i3"] });
      mockJobberGraphQL.mockResolvedValue({
        invoice: {
          id: "i1",
          invoiceNumber: "I-1",
          client: { id: "c1" },
          paymentRecords: {
            totalCount: 1,
            nodes: [{ id: "p2", amount: 100, paidAt: "2026-01-03T00:00:00Z" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });

      const result = await handlers["client_history"]({ client_id: "c1", payments_cursor: cursor });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.payments.next_cursor).toBe(
        encodeCursor({ invoice_id: "i2", after: null, remaining_invoice_ids: ["i3"] })
      );
    });

    it("carries payments_returned_so_far forward across the continuation", async () => {
      const cursor = encodeCursor({ invoice_id: "i1", after: null, remaining_invoice_ids: [] });
      mockJobberGraphQL.mockResolvedValue({
        invoice: {
          id: "i1",
          invoiceNumber: "I-1",
          client: { id: "c1" },
          paymentRecords: {
            totalCount: 10,
            nodes: [{ id: "p2", amount: 100, paidAt: "2026-01-03T00:00:00Z" }],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        },
      });

      const result = await handlers["client_history"]({
        client_id: "c1",
        payments_cursor: cursor,
        payments_returned_so_far: 5,
      });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.payments.returned_so_far).toBe(6);
    });

    it("rejects a payments_cursor whose invoice doesn't belong to the given client_id", async () => {
      const cursor = encodeCursor({ invoice_id: "i1", after: null, remaining_invoice_ids: [] });
      mockJobberGraphQL.mockResolvedValue({
        invoice: {
          id: "i1",
          invoiceNumber: "I-1",
          client: { id: "someone-elses-client" },
          paymentRecords: { totalCount: 1, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        },
      });

      const result = await handlers["client_history"]({ client_id: "c1", payments_cursor: cursor });
      expect(result.content[0].text).toContain("not found");
      expect(mockAppendAuditLog).toHaveBeenCalledWith(expect.objectContaining({ outcome: "not_found" }));
    });

    it("returns an error for a malformed payments_cursor without calling the GraphQL client", async () => {
      const result = await handlers["client_history"]({ client_id: "c1", payments_cursor: "not-valid-base64json" });
      expect(result.content[0].text).toContain("invalid payments_cursor");
      expect(mockAppendAuditLog).toHaveBeenCalledWith(expect.objectContaining({ outcome: "error" }));
      expect(mockJobberGraphQL).not.toHaveBeenCalled();
    });
  });
});
