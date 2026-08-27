import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

const { mockJobberGraphQL, mockAppendAuditLog } = vi.hoisted(() => ({
  mockJobberGraphQL: vi.fn(),
  mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../jobber/client.js", () => ({ jobberGraphQL: mockJobberGraphQL }));
vi.mock("../../utils/auditLog.js", () => ({ appendAuditLog: mockAppendAuditLog }));

import { registerQuotesOutstandingTool } from "../quotes-outstanding.js";

const handlers: Record<string, (args?: any) => Promise<any>> = {};
const fakeServer = {
  registerTool: vi.fn((name: string, _schema: any, handler: (args?: any) => Promise<any>) => {
    handlers[name] = handler;
  }),
};

beforeAll(() => {
  registerQuotesOutstandingTool(fakeServer as any);
});

beforeEach(() => {
  vi.clearAllMocks();
});

describe("quotes_outstanding", () => {
  it("passes page_size through with the declared max cost", async () => {
    mockJobberGraphQL.mockResolvedValue({ quotes: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } } });
    await handlers["quotes_outstanding"]({ page_size: 10 });
    expect(mockJobberGraphQL).toHaveBeenCalledWith(expect.any(String), { first: 10 }, expect.any(Number));
  });

  it("computes age_days from createdAt and flattens amounts/client", async () => {
    const tenDaysAgo = new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString();
    mockJobberGraphQL.mockResolvedValue({
      quotes: {
        totalCount: 1,
        nodes: [{
          id: "q1",
          quoteNumber: "Q-1",
          title: "Roof quote",
          client: { id: "c1", name: "Acme Corp" },
          amounts: { total: 600 },
          createdAt: tenDaysAgo,
          quoteStatus: "awaiting_response",
        }],
        pageInfo: { hasNextPage: false },
      },
    });

    const result = await handlers["quotes_outstanding"]({ page_size: 10 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.quotes[0]).toEqual({
      id: "q1",
      quote_number: "Q-1",
      title: "Roof quote",
      client: "Acme Corp",
      total: 600,
      age_days: 10,
    });
  });

  it("appends a 'N more available' note and next_cursor when more quotes exist beyond the page", async () => {
    mockJobberGraphQL.mockResolvedValue({
      quotes: {
        totalCount: 4,
        nodes: [{
          id: "q1", quoteNumber: "Q-1", title: null, client: { id: "c1", name: "Acme" },
          amounts: { total: 100 }, createdAt: new Date().toISOString(), quoteStatus: "awaiting_response",
        }],
        pageInfo: { hasNextPage: true, endCursor: "cursor-xyz" },
      },
    });
    const result = await handlers["quotes_outstanding"]({ page_size: 1 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.note).toBe("3 more available");
    expect(parsed.next_cursor).toBe("cursor-xyz");
  });

  it("accounts for items already returned by prior pages when computing remaining", async () => {
    mockJobberGraphQL.mockResolvedValue({
      quotes: {
        totalCount: 3,
        nodes: [{
          id: "q2", quoteNumber: "Q-2", title: null, client: { id: "c1", name: "Acme" },
          amounts: { total: 100 }, createdAt: new Date().toISOString(), quoteStatus: "awaiting_response",
        }],
        pageInfo: { hasNextPage: true, endCursor: "cursor-2" },
      },
    });
    const result = await handlers["quotes_outstanding"]({ page_size: 1, cursor: "cursor-1", returned_so_far: 1 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.returned_so_far).toBe(2);
    expect(parsed.note).toBe("1 more available");
  });

  it("reports zero remaining and no next_cursor once the running total reaches totalCount", async () => {
    mockJobberGraphQL.mockResolvedValue({
      quotes: {
        totalCount: 2,
        nodes: [{
          id: "q2", quoteNumber: "Q-2", title: null, client: { id: "c1", name: "Acme" },
          amounts: { total: 100 }, createdAt: new Date().toISOString(), quoteStatus: "awaiting_response",
        }],
        pageInfo: { hasNextPage: false },
      },
    });
    const result = await handlers["quotes_outstanding"]({ page_size: 1, returned_so_far: 1 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.returned_so_far).toBe(2);
    expect(parsed.note).toBeUndefined();
    expect(parsed.next_cursor).toBeUndefined();
  });

  it("surfaces next_cursor even when a stale returned_so_far makes remaining compute to 0, trusting Jobber's hasNextPage", async () => {
    mockJobberGraphQL.mockResolvedValue({
      quotes: {
        totalCount: 2,
        nodes: [{
          id: "q2", quoteNumber: "Q-2", title: null, client: { id: "c1", name: "Acme" },
          amounts: { total: 100 }, createdAt: new Date().toISOString(), quoteStatus: "awaiting_response",
        }],
        pageInfo: { hasNextPage: true, endCursor: "cursor-more" },
      },
    });
    const result = await handlers["quotes_outstanding"]({ page_size: 1, returned_so_far: 100 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.next_cursor).toBe("cursor-more");
    expect(parsed.note).toBe("more available");
  });

  it("passes a supplied cursor through to the GraphQL client as the after variable", async () => {
    mockJobberGraphQL.mockResolvedValue({ quotes: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false } } });
    await handlers["quotes_outstanding"]({ page_size: 10, cursor: "cursor-xyz" });
    expect(mockJobberGraphQL).toHaveBeenCalledWith(
      expect.any(String),
      { first: 10, after: "cursor-xyz" },
      expect.any(Number)
    );
  });

  it("logs a success audit entry with the result count", async () => {
    mockJobberGraphQL.mockResolvedValue({
      quotes: {
        totalCount: 1,
        nodes: [{
          id: "q1", quoteNumber: "Q-1", title: null, client: { id: "c1", name: "Acme" },
          amounts: { total: 100 }, createdAt: new Date().toISOString(), quoteStatus: "awaiting_response",
        }],
        pageInfo: { hasNextPage: false },
      },
    });
    await handlers["quotes_outstanding"]({ page_size: 10 });
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "quotes_outstanding", outcome: "success", result_count: 1 })
    );
  });
});
