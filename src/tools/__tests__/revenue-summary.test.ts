import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

const { mockJobberGraphQL, mockAppendAuditLog } = vi.hoisted(() => ({
  mockJobberGraphQL: vi.fn(),
  mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../jobber/client.js", () => ({ jobberGraphQL: mockJobberGraphQL }));
vi.mock("../../utils/auditLog.js", () => ({ appendAuditLog: mockAppendAuditLog }));

import { registerRevenueSummaryTool } from "../revenue-summary.js";

const handlers: Record<string, (args?: any) => Promise<any>> = {};
const fakeServer = {
  registerTool: vi.fn((name: string, _schema: any, handler: (args?: any) => Promise<any>) => {
    handlers[name] = handler;
  }),
};

beforeAll(() => {
  registerRevenueSummaryTool(fakeServer as any);
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("revenue_summary", () => {
  it("passes the date range and page_size through with the declared max cost", async () => {
    mockJobberGraphQL.mockResolvedValue({ invoices: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } } });
    await handlers["revenue_summary"]({ date_from: "2026-01-01", date_to: "2026-06-30", page_size: 20 });
    expect(mockJobberGraphQL).toHaveBeenCalledWith(
      expect.any(String),
      { from: "2026-01-01", to: "2026-06-30", first: 20 },
      expect.any(Number)
    );
  });

  it("groups paid invoices by month and by quarter with a grand total at the top", async () => {
    mockJobberGraphQL.mockResolvedValue({
      invoices: {
        totalCount: 3,
        nodes: [
          { id: "i1", amounts: { total: 100 }, issuedDate: "2026-01-15T00:00:00Z" },
          { id: "i2", amounts: { total: 200 }, issuedDate: "2026-01-20T00:00:00Z" },
          { id: "i3", amounts: { total: 300 }, issuedDate: "2026-04-05T00:00:00Z" },
        ],
        pageInfo: { hasNextPage: false },
      },
    });
    const result = await handlers["revenue_summary"]({ date_from: "2026-01-01", date_to: "2026-06-30", page_size: 20 });
    const parsed = JSON.parse(result.content[0].text);

    expect(Object.keys(parsed)[0]).toBe("total_revenue");
    expect(parsed.total_revenue).not.toBeNull();
    expect(parsed.total_revenue).toBe(600);
    expect(parsed.by_month["2026-01"]).toBe(300);
    expect(parsed.by_month["2026-04"]).toBe(300);
    expect(parsed.by_quarter["Q1-2026"]).toBe(300);
    expect(parsed.by_quarter["Q2-2026"]).toBe(300);
  });

  it("notes when the summary only reflects a truncated page", async () => {
    mockJobberGraphQL.mockResolvedValue({
      invoices: {
        totalCount: 400,
        nodes: [{ id: "i1", amounts: { total: 100 }, issuedDate: "2026-01-15T00:00:00Z" }],
        pageInfo: { hasNextPage: true, endCursor: "cursor-xyz" },
      },
    });
    const result = await handlers["revenue_summary"]({ date_from: "2026-01-01", date_to: "2026-06-30", page_size: 1 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.note).toMatch(/399 more available/);
    expect(parsed.next_cursor).toBe("cursor-xyz");
    expect(parsed.returned_so_far).toBe(1);
  });

  it("accounts for items already returned by prior pages when computing remaining", async () => {
    mockJobberGraphQL.mockResolvedValue({
      invoices: {
        totalCount: 400,
        nodes: [{ id: "i2", amounts: { total: 100 }, issuedDate: "2026-01-15T00:00:00Z" }],
        pageInfo: { hasNextPage: true, endCursor: "cursor-abc" },
      },
    });
    const result = await handlers["revenue_summary"]({
      date_from: "2026-01-01",
      date_to: "2026-06-30",
      page_size: 1,
      cursor: "cursor-xyz",
      returned_so_far: 1,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.returned_so_far).toBe(2);
    expect(parsed.note).toMatch(/398 more available/);
  });

  it("reports zero remaining and no next_cursor once the running total reaches totalCount", async () => {
    mockJobberGraphQL.mockResolvedValue({
      invoices: {
        totalCount: 2,
        nodes: [{ id: "i2", amounts: { total: 100 }, issuedDate: "2026-01-15T00:00:00Z" }],
        pageInfo: { hasNextPage: false },
      },
    });
    const result = await handlers["revenue_summary"]({
      date_from: "2026-01-01",
      date_to: "2026-06-30",
      page_size: 1,
      returned_so_far: 1,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.returned_so_far).toBe(2);
    expect(parsed.note).toBeUndefined();
    expect(parsed.next_cursor).toBeUndefined();
  });

  it("surfaces next_cursor even when a stale returned_so_far makes remaining compute to 0, trusting Jobber's hasNextPage", async () => {
    mockJobberGraphQL.mockResolvedValue({
      invoices: {
        totalCount: 2,
        nodes: [{ id: "i2", amounts: { total: 100 }, issuedDate: "2026-01-15T00:00:00Z" }],
        pageInfo: { hasNextPage: true, endCursor: "cursor-more" },
      },
    });
    const result = await handlers["revenue_summary"]({
      date_from: "2026-01-01",
      date_to: "2026-06-30",
      page_size: 1,
      returned_so_far: 100,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.next_cursor).toBe("cursor-more");
    expect(parsed.note).toBe("more available - summary reflects only the scanned page");
  });

  it("passes a supplied cursor through to the GraphQL client as the after variable", async () => {
    mockJobberGraphQL.mockResolvedValue({ invoices: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } } });
    await handlers["revenue_summary"]({ date_from: "2026-01-01", date_to: "2026-06-30", page_size: 20, cursor: "cursor-xyz" });
    expect(mockJobberGraphQL).toHaveBeenCalledWith(
      expect.any(String),
      { from: "2026-01-01", to: "2026-06-30", first: 20, after: "cursor-xyz" },
      expect.any(Number)
    );
  });

  it("logs a success audit entry with the scanned invoice count", async () => {
    mockJobberGraphQL.mockResolvedValue({
      invoices: { totalCount: 1, nodes: [{ id: "i1", amounts: { total: 100 }, issuedDate: "2026-01-15T00:00:00Z" }], pageInfo: { hasNextPage: false } },
    });
    await handlers["revenue_summary"]({ date_from: "2026-01-01", date_to: "2026-06-30", page_size: 20 });
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "revenue_summary", outcome: "success", result_count: 1 })
    );
  });

  it("rounds totals to the nearest cent and includes a currency field", async () => {
    mockJobberGraphQL.mockResolvedValue({
      invoices: {
        totalCount: 2,
        nodes: [
          { id: "i1", amounts: { total: 0.1 }, issuedDate: "2026-01-15T00:00:00Z" },
          { id: "i2", amounts: { total: 0.2 }, issuedDate: "2026-01-16T00:00:00Z" },
        ],
        pageInfo: { hasNextPage: false },
      },
    });
    const result = await handlers["revenue_summary"]({ date_from: "2026-01-01", date_to: "2026-06-30", page_size: 20 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total_revenue).toBe(0.3);
    expect(parsed.currency).toBe("unknown");
  });
});
