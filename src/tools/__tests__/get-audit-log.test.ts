import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

const { mockReadAuditLog, mockAppendAuditLog } = vi.hoisted(() => ({
  mockReadAuditLog: vi.fn(),
  mockAppendAuditLog: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../../utils/auditLog.js", () => ({
  readAuditLog: mockReadAuditLog,
  appendAuditLog: mockAppendAuditLog,
}));

import { registerGetAuditLogTool } from "../get-audit-log.js";

const handlers: Record<string, (args?: any) => Promise<any>> = {};
const fakeServer = {
  registerTool: vi.fn((name: string, _schema: any, handler: (args?: any) => Promise<any>) => {
    handlers[name] = handler;
  }),
};

beforeAll(() => {
  registerGetAuditLogTool(fakeServer as any);
});

beforeEach(() => {
  vi.clearAllMocks();
});

function entry(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    timestamp: "2024-06-15T12:00:00.000Z",
    session_id: "sess-1",
    tool: "find_client",
    args: {},
    outcome: "success",
    ...overrides,
  };
}

describe("get_audit_log", () => {
  it("passes filter args through to readAuditLog", async () => {
    mockReadAuditLog.mockResolvedValue({ entries: [], total_matched: 0, truncated: false, corrupted_lines: 0 });
    await handlers["get_audit_log"]({ date_from: "2024-01-01", date_to: "2024-12-31", limit: 5, offset: 10 });
    expect(mockReadAuditLog).toHaveBeenCalledWith({
      date_from: "2024-01-01",
      date_to: "2024-12-31",
      limit: 5,
      offset: 10,
    });
  });

  it("returns entries, total_matched, and returned count", async () => {
    mockReadAuditLog.mockResolvedValue({
      entries: [entry(), entry({ tool: "logout" })],
      total_matched: 2,
      truncated: false,
      corrupted_lines: 0,
    });
    const result = await handlers["get_audit_log"]({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.total_matched).toBe(2);
    expect(parsed.returned).toBe(2);
    expect(parsed.entries).toHaveLength(2);
  });

  it("adds a note and next_offset when truncated", async () => {
    mockReadAuditLog.mockResolvedValue({
      entries: [entry()],
      total_matched: 5,
      truncated: true,
      corrupted_lines: 0,
    });
    const result = await handlers["get_audit_log"]({ offset: 2 });
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.note).toBe("2 more available");
    expect(parsed.next_offset).toBe(3);
  });

  it("omits note/next_offset when not truncated", async () => {
    mockReadAuditLog.mockResolvedValue({
      entries: [entry()],
      total_matched: 1,
      truncated: false,
      corrupted_lines: 0,
    });
    const result = await handlers["get_audit_log"]({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.note).toBeUndefined();
    expect(parsed.next_offset).toBeUndefined();
  });

  it("surfaces corrupted_lines only when nonzero", async () => {
    mockReadAuditLog.mockResolvedValue({
      entries: [entry()],
      total_matched: 1,
      truncated: false,
      corrupted_lines: 3,
    });
    const result = await handlers["get_audit_log"]({});
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.corrupted_lines).toBe(3);
  });

  it("logs a success audit entry with the result count", async () => {
    mockReadAuditLog.mockResolvedValue({
      entries: [entry(), entry()],
      total_matched: 2,
      truncated: false,
      corrupted_lines: 0,
    });
    await handlers["get_audit_log"]({});
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "get_audit_log", outcome: "success", result_count: 2 })
    );
  });
});
