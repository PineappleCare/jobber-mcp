import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

const { mockJobberGraphQL, mockAppendAuditLog } = vi.hoisted(() => ({
  mockJobberGraphQL: vi.fn(),
  mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../jobber/client.js", () => ({ jobberGraphQL: mockJobberGraphQL }));
vi.mock("../../utils/auditLog.js", () => ({ appendAuditLog: mockAppendAuditLog }));

import { registerJobsSummaryTool } from "../jobs-summary.js";

const handlers: Record<string, (args?: any) => Promise<any>> = {};
const fakeServer = {
  registerTool: vi.fn((name: string, _schema: any, handler: (args?: any) => Promise<any>) => {
    handlers[name] = handler;
  }),
};

beforeAll(() => {
  registerJobsSummaryTool(fakeServer as any);
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("jobs_summary", () => {
  it("passes the date range and page_size through with the declared max cost", async () => {
    mockJobberGraphQL.mockResolvedValue({ jobs: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } } });
    await handlers["jobs_summary"]({ date_from: "2026-01-01", date_to: "2026-01-31", page_size: 20 });
    expect(mockJobberGraphQL).toHaveBeenCalledWith(
      expect.any(String),
      { from: "2026-01-01", to: "2026-01-31", first: 20 },
      expect.any(Number)
    );
  });

  it("groups jobs by status with counts and summed totals", async () => {
    mockJobberGraphQL.mockResolvedValue({
      jobs: {
        totalCount: 3,
        nodes: [
          { id: "j1", jobStatus: "active", total: 100 },
          { id: "j2", jobStatus: "active", total: 200 },
          { id: "j3", jobStatus: "completed", total: 300 },
        ],
        pageInfo: { hasNextPage: false },
      },
    });
    const result = await handlers["jobs_summary"]({ date_from: "2026-01-01", date_to: "2026-01-31", page_size: 20 });
    const parsed = JSON.parse(result.content[0].text);
    expect(Object.keys(parsed)[0]).toBe("jobs_scanned");
    expect(parsed.jobs_scanned).toBe(3);
    expect(parsed.by_status.active).toEqual({ count: 2, total: 300 });
    expect(parsed.by_status.completed).toEqual({ count: 1, total: 300 });
  });

  it("notes when the summary only reflects a truncated page", async () => {
    mockJobberGraphQL.mockResolvedValue({
      jobs: {
        totalCount: 500,
        nodes: [{ id: "j1", jobStatus: "active", total: 100 }],
        pageInfo: { hasNextPage: true, endCursor: "cursor-xyz" },
      },
    });
    const result = await handlers["jobs_summary"]({ date_from: "2026-01-01", date_to: "2026-01-31", page_size: 1 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.note).toMatch(/499 more available/);
    expect(parsed.next_cursor).toBe("cursor-xyz");
  });

  it("passes a supplied cursor through to the GraphQL client as the after variable", async () => {
    mockJobberGraphQL.mockResolvedValue({ jobs: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } } });
    await handlers["jobs_summary"]({ date_from: "2026-01-01", date_to: "2026-01-31", page_size: 20, cursor: "cursor-xyz" });
    expect(mockJobberGraphQL).toHaveBeenCalledWith(
      expect.any(String),
      { from: "2026-01-01", to: "2026-01-31", first: 20, after: "cursor-xyz" },
      expect.any(Number)
    );
  });

  it("logs a success audit entry with the scanned job count", async () => {
    mockJobberGraphQL.mockResolvedValue({
      jobs: { totalCount: 1, nodes: [{ id: "j1", jobStatus: "active", total: 100 }], pageInfo: { hasNextPage: false } },
    });
    await handlers["jobs_summary"]({ date_from: "2026-01-01", date_to: "2026-01-31", page_size: 20 });
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "jobs_summary", outcome: "success", result_count: 1 })
    );
  });

  it("accounts for items already returned by prior pages when computing remaining", async () => {
    mockJobberGraphQL.mockResolvedValue({
      jobs: { totalCount: 3, nodes: [{ id: "j2", jobStatus: "active", total: 100 }], pageInfo: { hasNextPage: true, endCursor: "cursor-2" } },
    });
    const result = await handlers["jobs_summary"]({ date_from: "2026-01-01", date_to: "2026-01-31", page_size: 1, cursor: "cursor-1", returned_so_far: 1 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.returned_so_far).toBe(2);
    expect(parsed.note).toMatch(/1 more available/);
  });

  it("reports zero remaining and no next_cursor once the running total reaches totalCount", async () => {
    mockJobberGraphQL.mockResolvedValue({
      jobs: { totalCount: 2, nodes: [{ id: "j2", jobStatus: "active", total: 100 }], pageInfo: { hasNextPage: false } },
    });
    const result = await handlers["jobs_summary"]({ date_from: "2026-01-01", date_to: "2026-01-31", page_size: 1, returned_so_far: 1 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.returned_so_far).toBe(2);
    expect(parsed.note).toBeUndefined();
    expect(parsed.next_cursor).toBeUndefined();
  });

  it("surfaces next_cursor even when a stale returned_so_far makes remaining compute to 0, trusting Jobber's hasNextPage", async () => {
    mockJobberGraphQL.mockResolvedValue({
      jobs: { totalCount: 2, nodes: [{ id: "j1", jobStatus: "active", total: 100 }], pageInfo: { hasNextPage: true, endCursor: "cursor-more" } },
    });
    const result = await handlers["jobs_summary"]({ date_from: "2026-01-01", date_to: "2026-01-31", page_size: 1, returned_so_far: 100 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.next_cursor).toBe("cursor-more");
    expect(parsed.note).toBe("more available - summary reflects only the scanned page");
  });

  it("rounds per-status totals to the nearest cent and includes a currency field", async () => {
    mockJobberGraphQL.mockResolvedValue({
      jobs: {
        totalCount: 2,
        nodes: [
          { id: "j1", jobStatus: "active", total: 0.1 },
          { id: "j2", jobStatus: "active", total: 0.2 },
        ],
        pageInfo: { hasNextPage: false },
      },
    });
    const result = await handlers["jobs_summary"]({ date_from: "2026-01-01", date_to: "2026-01-31", page_size: 20 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.by_status.active.total).toBe(0.3);
    expect(parsed.currency).toBe("unknown");
  });
});
