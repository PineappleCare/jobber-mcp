import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

const { mockJobberGraphQL, mockAppendAuditLog } = vi.hoisted(() => ({
  mockJobberGraphQL: vi.fn(),
  mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../jobber/client.js", () => ({ jobberGraphQL: mockJobberGraphQL }));
vi.mock("../../utils/auditLog.js", () => ({ appendAuditLog: mockAppendAuditLog }));

import { registerRequestsInboxTool } from "../requests-inbox.js";

const handlers: Record<string, (args?: any) => Promise<any>> = {};
const fakeServer = {
  registerTool: vi.fn((name: string, _schema: any, handler: (args?: any) => Promise<any>) => {
    handlers[name] = handler;
  }),
};

beforeAll(() => {
  registerRequestsInboxTool(fakeServer as any);
});

beforeEach(() => {
  vi.clearAllMocks();
});

function emptyConnection() {
  return { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } };
}

function request(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: "r1",
    title: "Fix gutter",
    requestStatus: "new",
    client: { id: "c1", name: "Acme" },
    createdAt: "2026-03-01T00:00:00Z",
    ...overrides,
  };
}

describe("requests_inbox", () => {
  it("passes page_size through with the declared max cost", async () => {
    mockJobberGraphQL.mockResolvedValue({ newRequests: emptyConnection(), unscheduledRequests: emptyConnection() });
    await handlers["requests_inbox"]({ page_size: 10 });
    expect(mockJobberGraphQL).toHaveBeenCalledWith(
      expect.any(String),
      { first: 10, after: undefined, unscheduledAfter: undefined },
      expect.any(Number)
    );
  });

  it("returns new_requests and unscheduled_requests as genuinely independent sections", async () => {
    mockJobberGraphQL.mockResolvedValue({
      newRequests: {
        totalCount: 1,
        nodes: [request({ id: "r1", requestStatus: "new" })],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
      unscheduledRequests: {
        totalCount: 2,
        nodes: [
          request({ id: "r2", title: "Paint fence", requestStatus: "unscheduled", createdAt: "2026-03-02T00:00:00Z" }),
        ],
        pageInfo: { hasNextPage: true, endCursor: "unscheduled-cursor" },
      },
    });

    const result = await handlers["requests_inbox"]({ page_size: 10 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.new_requests.total_count).toBe(1);
    expect(parsed.new_requests.items).toEqual([
      { id: "r1", title: "Fix gutter", status: "new", client: "Acme", created_at: "2026-03-01T00:00:00Z" },
    ]);
    expect(parsed.new_requests.note).toBeUndefined();

    expect(parsed.unscheduled_requests.total_count).toBe(2);
    expect(parsed.unscheduled_requests.items).toEqual([
      { id: "r2", title: "Paint fence", status: "unscheduled", client: "Acme", created_at: "2026-03-02T00:00:00Z" },
    ]);
    expect(parsed.unscheduled_requests.note).toBe("1 more available");
    expect(parsed.unscheduled_requests.next_cursor).toBe("unscheduled-cursor");
  });

  it("passes cursor and unscheduled_cursor through to their respective GraphQL variables", async () => {
    mockJobberGraphQL.mockResolvedValue({ newRequests: emptyConnection(), unscheduledRequests: emptyConnection() });
    await handlers["requests_inbox"]({ page_size: 10, cursor: "new-cursor", unscheduled_cursor: "unscheduled-cursor" });
    expect(mockJobberGraphQL).toHaveBeenCalledWith(
      expect.any(String),
      { first: 10, after: "new-cursor", unscheduledAfter: "unscheduled-cursor" },
      expect.any(Number)
    );
  });

  it("accounts for items already returned by prior pages when computing a section's remaining", async () => {
    mockJobberGraphQL.mockResolvedValue({
      newRequests: { totalCount: 3, nodes: [request({ id: "r2" })], pageInfo: { hasNextPage: true, endCursor: "new-cursor-2" } },
      unscheduledRequests: emptyConnection(),
    });
    const result = await handlers["requests_inbox"]({ page_size: 1, cursor: "new-cursor-1", returned_so_far: 1 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.new_requests.returned_so_far).toBe(2);
    expect(parsed.new_requests.note).toBe("1 more available");
  });

  it("reports zero remaining and no next_cursor for a section once its running total reaches totalCount", async () => {
    mockJobberGraphQL.mockResolvedValue({
      newRequests: { totalCount: 2, nodes: [request({ id: "r2" })], pageInfo: { hasNextPage: false, endCursor: null } },
      unscheduledRequests: emptyConnection(),
    });
    const result = await handlers["requests_inbox"]({ page_size: 1, returned_so_far: 1 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.new_requests.returned_so_far).toBe(2);
    expect(parsed.new_requests.note).toBeUndefined();
    expect(parsed.new_requests.next_cursor).toBeUndefined();
  });

  it("surfaces next_cursor even when a stale returned_so_far makes remaining compute to 0, trusting Jobber's hasNextPage", async () => {
    mockJobberGraphQL.mockResolvedValue({
      newRequests: { totalCount: 2, nodes: [request({ id: "r2" })], pageInfo: { hasNextPage: true, endCursor: "new-cursor-more" } },
      unscheduledRequests: emptyConnection(),
    });
    const result = await handlers["requests_inbox"]({ page_size: 1, returned_so_far: 100 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.new_requests.next_cursor).toBe("new-cursor-more");
    expect(parsed.new_requests.note).toBe("more available");
  });

  it("does not let one section's inflated returned_so_far suppress the other section's next_cursor (they're independent)", async () => {
    // new_requests' own returned_so_far (0) is consistent, but unscheduled_requests is given a
    // wildly inflated returned_so_far - each section's pageProgress must be computed independently.
    mockJobberGraphQL.mockResolvedValue({
      newRequests: { totalCount: 5, nodes: [request({ id: "r1" })], pageInfo: { hasNextPage: true, endCursor: "new-cursor" } },
      unscheduledRequests: {
        totalCount: 2,
        nodes: [request({ id: "r2", requestStatus: "unscheduled" })],
        pageInfo: { hasNextPage: true, endCursor: "unscheduled-cursor" },
      },
    });
    const result = await handlers["requests_inbox"]({ page_size: 1, unscheduled_returned_so_far: 100 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.new_requests.note).toBe("4 more available");
    expect(parsed.new_requests.next_cursor).toBe("new-cursor");
    expect(parsed.unscheduled_requests.next_cursor).toBe("unscheduled-cursor");
    expect(parsed.unscheduled_requests.note).toBe("more available");
  });

  it("logs a success audit entry with the combined result count", async () => {
    mockJobberGraphQL.mockResolvedValue({
      newRequests: { totalCount: 1, nodes: [request()], pageInfo: { hasNextPage: false, endCursor: null } },
      unscheduledRequests: {
        totalCount: 1,
        nodes: [request({ id: "r2", requestStatus: "unscheduled" })],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    await handlers["requests_inbox"]({ page_size: 10 });
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "requests_inbox", outcome: "success", result_count: 2 })
    );
  });
});
