import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

const { mockJobberGraphQL, mockAppendAuditLog } = vi.hoisted(() => ({
  mockJobberGraphQL: vi.fn(),
  mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../jobber/client.js", () => ({ jobberGraphQL: mockJobberGraphQL }));
vi.mock("../../utils/auditLog.js", () => ({ appendAuditLog: mockAppendAuditLog }));

import { registerOverdueInvoicesTool } from "../overdue-invoices.js";

const handlers: Record<string, (args?: any) => Promise<any>> = {};
const fakeServer = {
  registerTool: vi.fn((name: string, _schema: any, handler: (args?: any) => Promise<any>) => {
    handlers[name] = handler;
  }),
};

beforeAll(() => {
  registerOverdueInvoicesTool(fakeServer as any);
});

beforeEach(() => {
  vi.clearAllMocks();
});

function invoice(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "i1",
    invoiceNumber: "I-1",
    client: { id: "c1", name: "Acme Corp" },
    amounts: { total: 500, invoiceBalance: 500 },
    dueDate: "2026-01-01",
    ...overrides,
  };
}

describe("overdue_invoices", () => {
  it("passes page_size through with the declared max cost", async () => {
    mockJobberGraphQL.mockResolvedValue({ invoices: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } } });
    await handlers["overdue_invoices"]({ page_size: 10 });
    expect(mockJobberGraphQL).toHaveBeenCalledWith(expect.any(String), { first: 10 }, expect.any(Number));
  });

  it("puts the summed total_owing at the top of the response", async () => {
    mockJobberGraphQL.mockResolvedValue({
      invoices: {
        totalCount: 2,
        nodes: [
          invoice({ id: "i1", amounts: { total: 500, invoiceBalance: 300 } }),
          invoice({ id: "i2", amounts: { total: 500, invoiceBalance: 200 } }),
        ],
        pageInfo: { hasNextPage: false },
      },
    });
    const result = await handlers["overdue_invoices"]({ page_size: 10 });
    const parsed = JSON.parse(result.content[0].text);
    expect(Object.keys(parsed)[0]).toBe("total_owing_this_page");
    expect(parsed.total_owing_this_page).toBe(500);
  });

  it("flattens each invoice with client name and amount owing", async () => {
    mockJobberGraphQL.mockResolvedValue({
      invoices: { totalCount: 1, nodes: [invoice()], pageInfo: { hasNextPage: false } },
    });
    const result = await handlers["overdue_invoices"]({ page_size: 10 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.invoices[0]).toEqual({
      id: "i1",
      invoice_number: "I-1",
      client: "Acme Corp",
      total: 500,
      amount_owing: 500,
      due_date: "2026-01-01",
    });
  });

  it("appends a note caveating total_owing when more invoices exist beyond the page", async () => {
    mockJobberGraphQL.mockResolvedValue({
      invoices: { totalCount: 3, nodes: [invoice()], pageInfo: { hasNextPage: true, endCursor: "cursor-xyz" } },
    });
    const result = await handlers["overdue_invoices"]({ page_size: 1 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.note).toBe("2 more available - total_owing_this_page reflects only the scanned page");
    expect(parsed.next_cursor).toBe("cursor-xyz");
  });

  it("passes a supplied cursor through to the GraphQL client as the after variable", async () => {
    mockJobberGraphQL.mockResolvedValue({ invoices: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } } });
    await handlers["overdue_invoices"]({ page_size: 10, cursor: "cursor-xyz" });
    expect(mockJobberGraphQL).toHaveBeenCalledWith(
      expect.any(String),
      { first: 10, after: "cursor-xyz" },
      expect.any(Number)
    );
  });

  it("logs a success audit entry with the result count", async () => {
    mockJobberGraphQL.mockResolvedValue({
      invoices: { totalCount: 1, nodes: [invoice()], pageInfo: { hasNextPage: false } },
    });
    await handlers["overdue_invoices"]({ page_size: 10 });
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "overdue_invoices", outcome: "success", result_count: 1 })
    );
  });

  it("accounts for items already returned by prior pages when computing remaining", async () => {
    mockJobberGraphQL.mockResolvedValue({
      invoices: { totalCount: 3, nodes: [invoice()], pageInfo: { hasNextPage: true, endCursor: "cursor-2" } },
    });
    const result = await handlers["overdue_invoices"]({ page_size: 1, cursor: "cursor-1", returned_so_far: 1 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.returned_so_far).toBe(2);
    expect(parsed.note).toBe("1 more available - total_owing_this_page reflects only the scanned page");
  });

  it("reports zero remaining and no next_cursor once the running total reaches totalCount", async () => {
    mockJobberGraphQL.mockResolvedValue({
      invoices: { totalCount: 2, nodes: [invoice()], pageInfo: { hasNextPage: false } },
    });
    const result = await handlers["overdue_invoices"]({ page_size: 1, returned_so_far: 1 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.returned_so_far).toBe(2);
    expect(parsed.note).toBeUndefined();
    expect(parsed.next_cursor).toBeUndefined();
  });

  it("surfaces next_cursor even when a stale returned_so_far makes remaining compute to 0, trusting Jobber's hasNextPage", async () => {
    mockJobberGraphQL.mockResolvedValue({
      invoices: { totalCount: 2, nodes: [invoice()], pageInfo: { hasNextPage: true, endCursor: "cursor-more" } },
    });
    const result = await handlers["overdue_invoices"]({ page_size: 1, returned_so_far: 100 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.next_cursor).toBe("cursor-more");
    expect(parsed.note).toBe("more available - total_owing_this_page reflects only the scanned page");
  });

  it("rounds money fields to the nearest cent and includes a currency field", async () => {
    mockJobberGraphQL.mockResolvedValue({
      invoices: {
        totalCount: 1,
        nodes: [invoice({ id: "i1", amounts: { total: 0.1 + 0.2, invoiceBalance: 10.005 } })],
        pageInfo: { hasNextPage: false },
      },
    });
    const result = await handlers["overdue_invoices"]({ page_size: 10 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.invoices[0].total).toBe(0.3);
    expect(parsed.currency).toBe("unknown");
  });
});
