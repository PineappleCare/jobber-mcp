import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

const { mockJobberGraphQL, mockAppendAuditLog } = vi.hoisted(() => ({
  mockJobberGraphQL: vi.fn(),
  mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../jobber/client.js", () => ({ jobberGraphQL: mockJobberGraphQL }));
vi.mock("../../utils/auditLog.js", () => ({ appendAuditLog: mockAppendAuditLog }));

import { registerScheduleLookupTool } from "../schedule-lookup.js";

const handlers: Record<string, (args?: any) => Promise<any>> = {};
const fakeServer = {
  registerTool: vi.fn((name: string, _schema: any, handler: (args?: any) => Promise<any>) => {
    handlers[name] = handler;
  }),
};

beforeAll(() => {
  registerScheduleLookupTool(fakeServer as any);
});

beforeEach(() => {
  vi.clearAllMocks();
});

const VISIT_NODE = {
  __typename: "Visit",
  id: "v1",
  title: "Repair visit",
  visitStatus: "scheduled",
  startAt: "2026-03-03T09:00:00Z",
  endAt: "2026-03-03T10:00:00Z",
  client: { id: "c2", name: "Beta LLC" },
};

const ASSESSMENT_NODE = {
  __typename: "Assessment",
  id: "a1",
  title: "Roof assessment",
  startAt: "2026-03-05T10:00:00Z",
  endAt: "2026-03-05T11:00:00Z",
  client: { id: "c1", name: "Acme" },
  isComplete: false,
  completedAt: null,
};

const OTHER_TYPE_NODE = { __typename: "BasicTask" };

describe("schedule_lookup", () => {
  it("passes the date range and page_size through with the declared max cost", async () => {
    mockJobberGraphQL.mockResolvedValue({ scheduledItems: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } });
    await handlers["schedule_lookup"]({ date_from: "2026-03-01", date_to: "2026-03-07", page_size: 20 });
    expect(mockJobberGraphQL).toHaveBeenCalledWith(
      expect.any(String),
      { from: "2026-03-01", to: "2026-03-07", first: 20, after: undefined },
      expect.any(Number)
    );
  });

  it("groups visits and assessments together by day, sorted chronologically", async () => {
    mockJobberGraphQL.mockResolvedValue({
      scheduledItems: {
        totalCount: 2,
        nodes: [ASSESSMENT_NODE, VISIT_NODE],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    const result = await handlers["schedule_lookup"]({ date_from: "2026-03-01", date_to: "2026-03-07", page_size: 20 });
    const parsed = JSON.parse(result.content[0].text);

    expect(Object.keys(parsed.days)).toEqual(["2026-03-03", "2026-03-05"]);
    expect(parsed.days["2026-03-03"][0]).toEqual({
      id: "v1", title: "Repair visit", type: "visit", status: "scheduled",
      start_at: "2026-03-03T09:00:00Z", end_at: "2026-03-03T10:00:00Z", client: "Beta LLC",
    });
    expect(parsed.days["2026-03-05"][0]).toEqual({
      id: "a1", title: "Roof assessment", type: "assessment", status: "incomplete",
      start_at: "2026-03-05T10:00:00Z", end_at: "2026-03-05T11:00:00Z", completed_at: null, client: "Acme",
    });
  });

  it("groups by the host machine's local timezone when no timezone is supplied", async () => {
    const originalTz = process.env.TZ;
    process.env.TZ = "America/Denver";
    try {
      // 2026-03-04T02:00:00Z is 2026-03-03 19:00 in America/Denver (MST, UTC-7 - DST
      // doesn't start until 2026-03-08), so a UTC-day default would file this under
      // the 4th while the host-timezone default correctly files it under the 3rd.
      const nearMidnightUtcVisit = {
        ...VISIT_NODE,
        id: "v-late",
        startAt: "2026-03-04T02:00:00Z",
        endAt: "2026-03-04T02:15:00Z",
      };
      mockJobberGraphQL.mockResolvedValue({
        scheduledItems: { totalCount: 1, nodes: [nearMidnightUtcVisit], pageInfo: { hasNextPage: false, endCursor: null } },
      });
      const result = await handlers["schedule_lookup"]({ date_from: "2026-03-01", date_to: "2026-03-07", page_size: 20 });
      const parsed = JSON.parse(result.content[0].text);
      expect(parsed.timezone).toBe("America/Denver");
      expect(Object.keys(parsed.days)).toEqual(["2026-03-03"]);
    } finally {
      if (originalTz === undefined) delete process.env.TZ;
      else process.env.TZ = originalTz;
    }
  });

  it("groups by the supplied IANA timezone's local day, not the UTC day", async () => {
    const lateUtcVisit = {
      ...VISIT_NODE,
      id: "v-late",
      startAt: "2026-03-03T23:30:00Z", // 15:30 the same day in America/Los_Angeles (UTC-8)
      endAt: "2026-03-03T23:45:00Z",
    };
    mockJobberGraphQL.mockResolvedValue({
      scheduledItems: { totalCount: 1, nodes: [lateUtcVisit], pageInfo: { hasNextPage: false, endCursor: null } },
    });
    const result = await handlers["schedule_lookup"]({
      date_from: "2026-03-01",
      date_to: "2026-03-07",
      page_size: 20,
      timezone: "America/Los_Angeles",
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.timezone).toBe("America/Los_Angeles");
    expect(Object.keys(parsed.days)).toEqual(["2026-03-03"]);

    const earlyUtcVisit = {
      ...VISIT_NODE,
      id: "v-early",
      startAt: "2026-03-04T06:30:00Z", // 22:30 on 2026-03-03 in America/Los_Angeles
      endAt: "2026-03-04T06:45:00Z",
    };
    mockJobberGraphQL.mockResolvedValue({
      scheduledItems: { totalCount: 1, nodes: [earlyUtcVisit], pageInfo: { hasNextPage: false, endCursor: null } },
    });
    const result2 = await handlers["schedule_lookup"]({
      date_from: "2026-03-01",
      date_to: "2026-03-07",
      page_size: 20,
      timezone: "America/Los_Angeles",
    });
    const parsed2 = JSON.parse(result2.content[0].text);
    expect(Object.keys(parsed2.days)).toEqual(["2026-03-03"]);
  });

  it("reports total_scheduled_items_count paired with the full page count, not just kept visits/assessments", async () => {
    mockJobberGraphQL.mockResolvedValue({
      scheduledItems: {
        totalCount: 3,
        nodes: [VISIT_NODE, OTHER_TYPE_NODE, ASSESSMENT_NODE],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    const result = await handlers["schedule_lookup"]({ date_from: "2026-03-01", date_to: "2026-03-07", page_size: 20 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total_scheduled_items_count).toBe(3);
    expect(parsed.total_count).toBeUndefined();
  });

  it("filters out other scheduled-item types and adds a total_count_note when they're present", async () => {
    mockJobberGraphQL.mockResolvedValue({
      scheduledItems: {
        totalCount: 3,
        nodes: [VISIT_NODE, OTHER_TYPE_NODE, ASSESSMENT_NODE],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    const result = await handlers["schedule_lookup"]({ date_from: "2026-03-01", date_to: "2026-03-07", page_size: 20 });
    const parsed = JSON.parse(result.content[0].text);

    const allEntries = Object.values(parsed.days).flat() as any[];
    expect(allEntries).toHaveLength(2);
    expect(allEntries.some((e) => e.id === "v1")).toBe(true);
    expect(allEntries.some((e) => e.id === "a1")).toBe(true);
    expect(parsed.total_count_note).toMatch(/total_scheduled_items_count includes all scheduled item types/);
  });

  it("omits total_count_note when only visits and assessments are present", async () => {
    mockJobberGraphQL.mockResolvedValue({
      scheduledItems: { totalCount: 1, nodes: [VISIT_NODE], pageInfo: { hasNextPage: false, endCursor: null } },
    });
    const result = await handlers["schedule_lookup"]({ date_from: "2026-03-01", date_to: "2026-03-07", page_size: 20 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total_count_note).toBeUndefined();
  });

  it("appends a 'N more available' note and next_cursor when more items exist beyond the page", async () => {
    mockJobberGraphQL.mockResolvedValue({
      scheduledItems: {
        totalCount: 5,
        nodes: [VISIT_NODE],
        pageInfo: { hasNextPage: true, endCursor: "cursor-xyz" },
      },
    });
    const result = await handlers["schedule_lookup"]({ date_from: "2026-03-01", date_to: "2026-03-07", page_size: 1 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.note).toBe("4 more available");
    expect(parsed.next_cursor).toBe("cursor-xyz");
  });

  it("accounts for items already returned by prior pages when computing remaining", async () => {
    mockJobberGraphQL.mockResolvedValue({
      scheduledItems: { totalCount: 3, nodes: [VISIT_NODE], pageInfo: { hasNextPage: true, endCursor: "cursor-2" } },
    });
    const result = await handlers["schedule_lookup"]({
      date_from: "2026-03-01", date_to: "2026-03-07", page_size: 1, cursor: "cursor-1", returned_so_far: 1,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.returned_so_far).toBe(2);
    expect(parsed.note).toBe("1 more available");
  });

  it("reports zero remaining and no next_cursor once the running total reaches totalCount", async () => {
    mockJobberGraphQL.mockResolvedValue({
      scheduledItems: { totalCount: 2, nodes: [VISIT_NODE], pageInfo: { hasNextPage: false, endCursor: null } },
    });
    const result = await handlers["schedule_lookup"]({
      date_from: "2026-03-01", date_to: "2026-03-07", page_size: 1, returned_so_far: 1,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.returned_so_far).toBe(2);
    expect(parsed.note).toBeUndefined();
    expect(parsed.next_cursor).toBeUndefined();
  });

  it("surfaces next_cursor even when a stale returned_so_far makes remaining compute to 0, trusting Jobber's hasNextPage", async () => {
    mockJobberGraphQL.mockResolvedValue({
      scheduledItems: { totalCount: 2, nodes: [VISIT_NODE], pageInfo: { hasNextPage: true, endCursor: "cursor-more" } },
    });
    const result = await handlers["schedule_lookup"]({
      date_from: "2026-03-01", date_to: "2026-03-07", page_size: 1, returned_so_far: 100,
    });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.next_cursor).toBe("cursor-more");
    expect(parsed.note).toBe("more available");
  });

  it("passes a supplied cursor through to the GraphQL client as the after variable", async () => {
    mockJobberGraphQL.mockResolvedValue({ scheduledItems: { totalCount: 0, nodes: [], pageInfo: { hasNextPage: false, endCursor: null } } });
    await handlers["schedule_lookup"]({ date_from: "2026-03-01", date_to: "2026-03-07", page_size: 20, cursor: "cursor-xyz" });
    expect(mockJobberGraphQL).toHaveBeenCalledWith(
      expect.any(String),
      { from: "2026-03-01", to: "2026-03-07", first: 20, after: "cursor-xyz" },
      expect.any(Number)
    );
  });

  it("logs a success audit entry with the kept (visit/assessment) result count", async () => {
    mockJobberGraphQL.mockResolvedValue({
      scheduledItems: {
        totalCount: 2,
        nodes: [VISIT_NODE, OTHER_TYPE_NODE],
        pageInfo: { hasNextPage: false, endCursor: null },
      },
    });
    await handlers["schedule_lookup"]({ date_from: "2026-03-01", date_to: "2026-03-07", page_size: 20 });
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "schedule_lookup", outcome: "success", result_count: 1 })
    );
  });
});
