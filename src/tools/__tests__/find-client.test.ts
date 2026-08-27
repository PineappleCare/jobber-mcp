import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

const { mockJobberGraphQL, mockAppendAuditLog } = vi.hoisted(() => ({
  mockJobberGraphQL: vi.fn(),
  mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../jobber/client.js", () => ({
  jobberGraphQL: mockJobberGraphQL,
}));

vi.mock("../../utils/auditLog.js", () => ({
  appendAuditLog: mockAppendAuditLog,
}));

import { registerFindClientTool } from "../find-client.js";

const handlers: Record<string, (args?: any) => Promise<any>> = {};
const fakeServer = {
  registerTool: vi.fn((name: string, _schema: any, handler: (args?: any) => Promise<any>) => {
    handlers[name] = handler;
  }),
};

beforeAll(() => {
  registerFindClientTool(fakeServer as any);
});

beforeEach(() => {
  vi.clearAllMocks();
});

const NODE = {
  id: "gid://Jobber/Client/1",
  name: "Acme Corp",
  companyName: "Acme Corp",
  emails: [
    { address: "old@acme.test", primary: false },
    { address: "billing@acme.test", primary: true },
  ],
  phones: [{ number: "+15551234567", primary: true }],
  billingAddress: {
    street1: "123 Main St",
    street2: null,
    city: "Springfield",
    province: "IL",
    postalCode: "62701",
    country: "US",
  },
};

describe("find_client", () => {
  it("passes search_term and page_size through to the GraphQL client with the declared max cost", async () => {
    mockJobberGraphQL.mockResolvedValue({ clients: { totalCount: 1, nodes: [NODE], pageInfo: { hasNextPage: false } } });

    await handlers["find_client"]({ search_term: "Acme", page_size: 5 });

    expect(mockJobberGraphQL).toHaveBeenCalledWith(
      expect.any(String),
      { searchTerm: "Acme", first: 5 },
      expect.any(Number)
    );
  });

  it("flattens nested fields into compact contact info and addresses, preserving which email/phone is primary", async () => {
    mockJobberGraphQL.mockResolvedValue({ clients: { totalCount: 1, nodes: [NODE], pageInfo: { hasNextPage: false } } });

    const result = await handlers["find_client"]({ search_term: "Acme", page_size: 5 });
    const parsed = JSON.parse(result.content[0].text);

    expect(parsed.total_count).toBe(1);
    expect(parsed.clients[0]).toEqual({
      id: "gid://Jobber/Client/1",
      name: "Acme Corp",
      company_name: "Acme Corp",
      emails: [
        { address: "old@acme.test", primary: false },
        { address: "billing@acme.test", primary: true },
      ],
      phones: [{ number: "+15551234567", primary: true }],
      address: {
        street1: "123 Main St",
        street2: null,
        city: "Springfield",
        province: "IL",
        postal_code: "62701",
        country: "US",
      },
    });
  });

  it("appends a 'N more available' note and a next_cursor when more results exist beyond the page", async () => {
    mockJobberGraphQL.mockResolvedValue({
      clients: { totalCount: 5, nodes: [NODE], pageInfo: { hasNextPage: true, endCursor: "cursor-abc" } },
    });

    const result = await handlers["find_client"]({ search_term: "Acme", page_size: 1 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.note).toBe("4 more available");
    expect(parsed.next_cursor).toBe("cursor-abc");
  });

  it("passes a supplied cursor through to the GraphQL client as the after variable", async () => {
    mockJobberGraphQL.mockResolvedValue({ clients: { totalCount: 1, nodes: [NODE], pageInfo: { hasNextPage: false } } });

    await handlers["find_client"]({ search_term: "Acme", page_size: 5, cursor: "cursor-abc" });

    expect(mockJobberGraphQL).toHaveBeenCalledWith(
      expect.any(String),
      { searchTerm: "Acme", first: 5, after: "cursor-abc" },
      expect.any(Number)
    );
  });

  it("accounts for items already returned by prior pages when computing remaining", async () => {
    mockJobberGraphQL.mockResolvedValue({
      clients: { totalCount: 3, nodes: [NODE], pageInfo: { hasNextPage: true, endCursor: "cursor-2" } },
    });
    const result = await handlers["find_client"]({ search_term: "Acme", page_size: 1, cursor: "cursor-1", returned_so_far: 1 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.returned_so_far).toBe(2);
    expect(parsed.note).toBe("1 more available");
  });

  it("reports zero remaining and no next_cursor once the running total reaches totalCount", async () => {
    mockJobberGraphQL.mockResolvedValue({
      clients: { totalCount: 2, nodes: [NODE], pageInfo: { hasNextPage: false } },
    });
    const result = await handlers["find_client"]({ search_term: "Acme", page_size: 1, returned_so_far: 1 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.returned_so_far).toBe(2);
    expect(parsed.note).toBeUndefined();
    expect(parsed.next_cursor).toBeUndefined();
  });

  it("surfaces next_cursor even when a stale returned_so_far makes remaining compute to 0, trusting Jobber's hasNextPage", async () => {
    mockJobberGraphQL.mockResolvedValue({
      clients: { totalCount: 2, nodes: [NODE], pageInfo: { hasNextPage: true, endCursor: "cursor-more" } },
    });
    const result = await handlers["find_client"]({ search_term: "Acme", page_size: 1, returned_so_far: 100 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.next_cursor).toBe("cursor-more");
    expect(parsed.note).toBe("more available");
  });

  it("omits the note when there is no next page", async () => {
    mockJobberGraphQL.mockResolvedValue({
      clients: { totalCount: 1, nodes: [NODE], pageInfo: { hasNextPage: false } },
    });

    const result = await handlers["find_client"]({ search_term: "Acme", page_size: 20 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.note).toBeUndefined();
  });

  it("logs a success audit entry with the result count", async () => {
    mockJobberGraphQL.mockResolvedValue({ clients: { totalCount: 1, nodes: [NODE], pageInfo: { hasNextPage: false } } });

    await handlers["find_client"]({ search_term: "Acme", page_size: 5 });

    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "find_client", outcome: "success", result_count: 1 })
    );
  });

  it("returns an error result and logs it when the GraphQL client throws", async () => {
    mockJobberGraphQL.mockRejectedValue(new Error("Jobber API error: boom"));

    const result = await handlers["find_client"]({ search_term: "Acme", page_size: 5 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("boom");
  });
});
