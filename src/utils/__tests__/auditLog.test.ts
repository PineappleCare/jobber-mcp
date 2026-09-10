import { vi, describe, it, expect, beforeEach } from "vitest";

const { mockReadFile, mockAppendFile, mockMkdir, mockChmod, mockStat, mockRename } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockAppendFile: vi.fn().mockResolvedValue(undefined),
  mockMkdir: vi.fn().mockResolvedValue(undefined),
  mockChmod: vi.fn().mockResolvedValue(undefined),
  mockStat: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
  mockRename: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("fs/promises", () => ({
  default: {
    readFile: mockReadFile,
    appendFile: mockAppendFile,
    mkdir: mockMkdir,
    chmod: mockChmod,
    stat: mockStat,
    rename: mockRename,
  },
}));

vi.mock("os", () => ({
  default: {
    homedir: () => "/tmp/test-home",
    networkInterfaces: () => ({
      eth0: [{ family: "IPv4", internal: false, address: "10.0.0.1" }],
    }),
  },
}));

vi.mock("../../auth/tokenStorage.js", () => ({
  loadTokens: vi.fn().mockResolvedValue(null),
}));

import { readAuditLog, appendAuditLog } from "../auditLog.js";

function makeEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    timestamp: "2024-06-15T12:00:00.000Z",
    session_id: "sess-1",
    tool: "find_client",
    args: {},
    outcome: "success",
    ...overrides,
  };
}

function toJSONL(...entries: object[]): string {
  return entries.map((e) => JSON.stringify(e)).join("\n");
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.JOBBER_STATE_DIR;
});

describe("readAuditLog", () => {
  it("returns empty result when audit file does not exist", async () => {
    mockReadFile.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
    const result = await readAuditLog();
    expect(result).toEqual({ entries: [], total_matched: 0, truncated: false, corrupted_lines: 0 });
  });

  it("returns empty result for empty file", async () => {
    mockReadFile.mockResolvedValue("");
    const result = await readAuditLog();
    expect(result).toEqual({ entries: [], total_matched: 0, truncated: false, corrupted_lines: 0 });
  });

  it("returns all entries when no filter is applied", async () => {
    mockReadFile.mockResolvedValue(toJSONL(makeEntry(), makeEntry(), makeEntry()));
    const result = await readAuditLog();
    expect(result.entries).toHaveLength(3);
    expect(result.total_matched).toBe(3);
    expect(result.truncated).toBe(false);
  });

  it("filters by date_from (inclusive)", async () => {
    mockReadFile.mockResolvedValue(toJSONL(
      makeEntry({ timestamp: "2024-01-01T00:00:00.000Z" }),
      makeEntry({ timestamp: "2024-06-15T00:00:00.000Z" }),
      makeEntry({ timestamp: "2025-01-01T00:00:00.000Z" }),
    ));
    const result = await readAuditLog({ date_from: "2024-06-01" });
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].timestamp).toContain("2024-06-15");
    expect(result.total_matched).toBe(2);
  });

  it("filters by date_to (inclusive)", async () => {
    mockReadFile.mockResolvedValue(toJSONL(
      makeEntry({ timestamp: "2024-01-01T00:00:00.000Z" }),
      makeEntry({ timestamp: "2024-06-15T00:00:00.000Z" }),
      makeEntry({ timestamp: "2025-01-01T00:00:00.000Z" }),
    ));
    const result = await readAuditLog({ date_to: "2024-12-31" });
    expect(result.entries).toHaveLength(2);
    expect(result.entries[1].timestamp).toContain("2024-06-15");
    expect(result.total_matched).toBe(2);
  });

  it("paginates with limit", async () => {
    const entries = Array.from({ length: 5 }, (_, i) => makeEntry({ tool: `tool_${i}` }));
    mockReadFile.mockResolvedValue(toJSONL(...entries));
    const result = await readAuditLog({ limit: 2 });
    expect(result.entries).toHaveLength(2);
    expect(result.total_matched).toBe(5);
    expect(result.truncated).toBe(true);
  });

  it("paginates with offset", async () => {
    const entries = Array.from({ length: 5 }, (_, i) => makeEntry({ tool: `tool_${i}` }));
    mockReadFile.mockResolvedValue(toJSONL(...entries));
    const result = await readAuditLog({ limit: 2, offset: 2 });
    expect(result.entries).toHaveLength(2);
    expect(result.entries[0].tool).toBe("tool_2");
    expect(result.total_matched).toBe(5);
    expect(result.truncated).toBe(true);
  });

  it("does not set truncated on the last page", async () => {
    const entries = Array.from({ length: 5 }, (_, i) => makeEntry({ tool: `tool_${i}` }));
    mockReadFile.mockResolvedValue(toJSONL(...entries));
    const result = await readAuditLog({ limit: 2, offset: 4 });
    expect(result.entries).toHaveLength(1);
    expect(result.total_matched).toBe(5);
    expect(result.truncated).toBe(false);
  });

  it("skips malformed JSON lines without letting them affect the good entries, and reports how many were dropped", async () => {
    const good = makeEntry();
    const jsonl = [JSON.stringify(good), "not valid json {{", JSON.stringify(good), "also garbage"].join("\n");
    mockReadFile.mockResolvedValue(jsonl);
    const result = await readAuditLog();
    expect(result.entries).toHaveLength(2);
    expect(result.total_matched).toBe(2);
    expect(result.corrupted_lines).toBe(2);
  });

  it("reports zero corrupted_lines when every line parses cleanly", async () => {
    mockReadFile.mockResolvedValue(toJSONL(makeEntry(), makeEntry()));
    const result = await readAuditLog();
    expect(result.corrupted_lines).toBe(0);
  });
});

describe("appendAuditLog rotation", () => {
  it("does not rotate when the audit file is under the size threshold", async () => {
    mockStat.mockResolvedValueOnce({ size: 1024 } as any);
    await appendAuditLog({ tool: "find_client", args: {}, outcome: "success" });
    expect(mockRename).not.toHaveBeenCalled();
    expect(mockAppendFile).toHaveBeenCalled();
  });

  it("rotates audit.log to audit.log.1 once the size threshold is crossed", async () => {
    mockStat.mockResolvedValueOnce({ size: 11 * 1024 * 1024 } as any);
    await appendAuditLog({ tool: "find_client", args: {}, outcome: "success" });
    expect(mockRename).toHaveBeenCalledWith(expect.stringContaining("audit.log"), expect.stringContaining("audit.log.1"));
    expect(mockAppendFile).toHaveBeenCalled();
  });

  it("still appends even if the rotation check itself fails", async () => {
    mockStat.mockRejectedValueOnce(new Error("permission denied"));
    await expect(
      appendAuditLog({ tool: "find_client", args: {}, outcome: "success" })
    ).resolves.toBeUndefined();
    expect(mockAppendFile).toHaveBeenCalled();
  });
});

describe("appendAuditLog redaction", () => {
  it("redacts known secret keys at the top level", async () => {
    await appendAuditLog({
      tool: "authenticate",
      args: { access_token: "secret-at", refresh_token: "secret-rt", client_secret: "secret-cs", password: "hunter2" },
      outcome: "success",
    });
    const written = JSON.parse(mockAppendFile.mock.calls[0][1] as string);
    expect(written.args.access_token).toBe("[REDACTED]");
    expect(written.args.refresh_token).toBe("[REDACTED]");
    expect(written.args.client_secret).toBe("[REDACTED]");
    expect(written.args.password).toBe("[REDACTED]");
  });

  it("redacts secret keys nested inside objects", async () => {
    await appendAuditLog({
      tool: "authenticate",
      args: { nested: { token: "secret-nested-token", safe: "keep-me" } },
      outcome: "success",
    });
    const written = JSON.parse(mockAppendFile.mock.calls[0][1] as string);
    expect(written.args.nested.token).toBe("[REDACTED]");
    expect(written.args.nested.safe).toBe("keep-me");
  });

  it("does not redact or hash truly non-sensitive keys", async () => {
    await appendAuditLog({
      tool: "find_client",
      args: { page_size: 20 },
      outcome: "success",
    });
    const written = JSON.parse(mockAppendFile.mock.calls[0][1] as string);
    expect(written.args.page_size).toBe(20);
  });

  it("hashes search_term instead of storing it in plaintext", async () => {
    await appendAuditLog({
      tool: "find_client",
      args: { search_term: "sarah.miller@gmail.com" },
      outcome: "success",
    });
    const written = JSON.parse(mockAppendFile.mock.calls[0][1] as string);
    expect(written.args.search_term).toBeUndefined();
    expect(written.args.search_term_hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("hashes search_term identically for the same input, so repeated searches can be correlated", async () => {
    await appendAuditLog({ tool: "find_client", args: { search_term: "Acme" }, outcome: "success" });
    await appendAuditLog({ tool: "find_client", args: { search_term: "Acme" }, outcome: "success" });
    const first = JSON.parse(mockAppendFile.mock.calls[0][1] as string);
    const second = JSON.parse(mockAppendFile.mock.calls[1][1] as string);
    expect(first.args.search_term_hash).toBe(second.args.search_term_hash);
  });

  it("hashes structured values canonically instead of collapsing every object to the same hash", async () => {
    await appendAuditLog({ tool: "create_client", args: { billing_address: { city: "Toronto", street1: "1 A St" } }, outcome: "success" });
    await appendAuditLog({ tool: "create_client", args: { billing_address: { street1: "1 A St", city: "Toronto" } }, outcome: "success" });
    await appendAuditLog({ tool: "create_client", args: { billing_address: { city: "Ottawa", street1: "2 B St" } }, outcome: "success" });
    const first = JSON.parse(mockAppendFile.mock.calls[0][1] as string);
    const reordered = JSON.parse(mockAppendFile.mock.calls[1][1] as string);
    const different = JSON.parse(mockAppendFile.mock.calls[2][1] as string);
    expect(first.args.billing_address_hash).toBe(reordered.args.billing_address_hash);
    expect(first.args.billing_address_hash).not.toBe(different.args.billing_address_hash);
  });

  it("never stores operational customer data in plaintext", async () => {
    await appendAuditLog({
      tool: "create_draft_quote",
      args: {
        email: "customer@example.com",
        phone: "+1 416 555 0100",
        billing_address: { street1: "1 Private Street", city: "Toronto", postal_code: "M1M 1M1" },
        message: "Private customer message",
        instructions: "Private site instructions",
        line_items: [{ name: "Sensitive service", description: "Sensitive details" }],
      },
      outcome: "success",
    });
    const serialized = mockAppendFile.mock.calls[0][1] as string;
    for (const plaintext of ["customer@example.com", "416 555", "Private Street", "Private customer", "Private site", "Sensitive service", "Sensitive details"]) {
      expect(serialized).not.toContain(plaintext);
    }
    const written = JSON.parse(serialized);
    expect(written.args.email_hash).toMatch(/^[0-9a-f]{12}$/);
    expect(written.args.line_items_hash).toMatch(/^[0-9a-f]{12}$/);
  });

  it("creates the audit directory and file with owner-only permissions", async () => {
    await appendAuditLog({ tool: "find_client", args: {}, outcome: "success" });
    expect(mockMkdir).toHaveBeenCalledWith(expect.any(String), expect.objectContaining({ mode: 0o700 }));
    expect(mockChmod).toHaveBeenCalledWith(expect.any(String), 0o700);
    expect(mockChmod).toHaveBeenCalledWith(expect.any(String), 0o600);
  });

  it("stores audit data in JOBBER_STATE_DIR for container persistence", async () => {
    process.env.JOBBER_STATE_DIR = "/opt/data/jobber-state";
    await appendAuditLog({ tool: "find_client", args: {}, outcome: "success" });
    expect(mockMkdir).toHaveBeenCalledWith("/opt/data/jobber-state", expect.objectContaining({ mode: 0o700 }));
    expect(mockAppendFile).toHaveBeenCalledWith("/opt/data/jobber-state/audit.log", expect.any(String), "utf8");
  });

  it("redacts camelCase secret-like keys", async () => {
    await appendAuditLog({
      tool: "authenticate",
      args: { clientSecret: "secret-cs", accessToken: "secret-at", apiKey: "secret-key" },
      outcome: "success",
    });
    const written = JSON.parse(mockAppendFile.mock.calls[0][1] as string);
    expect(written.args.clientSecret).toBe("[REDACTED]");
    expect(written.args.accessToken).toBe("[REDACTED]");
    expect(written.args.apiKey).toBe("[REDACTED]");
  });

  it("redacts secret keys nested inside arrays of objects", async () => {
    await appendAuditLog({
      tool: "authenticate",
      args: { items: [{ token: "secret-in-array", safe: "keep-me" }, { token: "another-secret" }] },
      outcome: "success",
    });
    const written = JSON.parse(mockAppendFile.mock.calls[0][1] as string);
    expect(written.args.items[0].token).toBe("[REDACTED]");
    expect(written.args.items[0].safe).toBe("keep-me");
    expect(written.args.items[1].token).toBe("[REDACTED]");
  });

  it("never throws when the write fails", async () => {
    mockAppendFile.mockRejectedValueOnce(new Error("disk full"));
    await expect(
      appendAuditLog({ tool: "find_client", args: {}, outcome: "error", error_message: "boom" })
    ).resolves.toBeUndefined();
  });
});
