import { vi, describe, it, expect, beforeEach } from "vitest";

const { MockEntry, mockGetPassword, mockSetPassword } = vi.hoisted(() => {
  const mockGetPassword = vi.fn();
  const mockSetPassword = vi.fn();
  const MockEntry = vi.fn().mockImplementation(function () {
    return { getPassword: mockGetPassword, setPassword: mockSetPassword };
  });
  return { MockEntry, mockGetPassword, mockSetPassword };
});

vi.mock("@napi-rs/keyring", () => ({ Entry: MockEntry }));

vi.mock("fs/promises", () => ({
  default: {
    mkdir: vi.fn().mockResolvedValue(undefined),
    readFile: vi.fn().mockResolvedValue(""),
    writeFile: vi.fn().mockResolvedValue(undefined),
    chmod: vi.fn().mockResolvedValue(undefined),
    unlink: vi.fn().mockResolvedValue(undefined),
    rename: vi.fn().mockResolvedValue(undefined),
    open: vi.fn().mockResolvedValue({ close: vi.fn().mockResolvedValue(undefined) }),
    stat: vi.fn().mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" })),
  },
}));

// Keep real crypto but make randomBytes deterministic
vi.mock("crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("crypto")>();
  return {
    ...actual,
    randomBytes: vi.fn().mockReturnValue(Buffer.from("aa".repeat(32), "hex")),
  };
});

// Imports resolved after mocks are registered
import fs from "fs/promises";
import { getEncryptionKey, saveTokens, loadTokens, clearTokens, withTokenLock } from "../tokenStorage.js";
import type { JobberTokens } from "../oauth.js";

const mockMkdir = vi.mocked(fs.mkdir);
const mockReadFile = vi.mocked(fs.readFile);
const mockWriteFile = vi.mocked(fs.writeFile);
const mockChmod = vi.mocked(fs.chmod);
const mockUnlink = vi.mocked(fs.unlink);
const mockRename = vi.mocked(fs.rename);
const mockOpen = vi.mocked(fs.open);
const mockStat = vi.mocked(fs.stat);

const VALID_KEY_HEX = "ab".repeat(32); // 64 hex chars = 32 bytes
const ENOENT = Object.assign(new Error("ENOENT: no such file"), { code: "ENOENT" });

// Helper: make MockEntry throw on construction (simulates "keychain unavailable")
function makeKeychainUnavailable() {
  MockEntry.mockImplementationOnce(function () {
    throw new Error("keychain unavailable");
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  delete process.env.ENCRYPTION_KEY;
  MockEntry.mockImplementation(function () {
    return { getPassword: mockGetPassword, setPassword: mockSetPassword };
  });
  mockMkdir.mockResolvedValue(undefined);
  mockReadFile.mockResolvedValue("" as any);
  mockWriteFile.mockResolvedValue(undefined);
  mockChmod.mockResolvedValue(undefined);
  mockUnlink.mockResolvedValue(undefined);
  mockRename.mockResolvedValue(undefined);
  mockOpen.mockResolvedValue({ close: vi.fn().mockResolvedValue(undefined) } as any);
  mockStat.mockRejectedValue(Object.assign(new Error("ENOENT"), { code: "ENOENT" }));
  mockGetPassword.mockReturnValue(VALID_KEY_HEX);
});

// ─── Tier 1: ENCRYPTION_KEY env var ──────────────────────────────────────────

describe("Tier 1 - ENCRYPTION_KEY env var", () => {
  it("throws if ENCRYPTION_KEY is not 64 hex chars", async () => {
    process.env.ENCRYPTION_KEY = "tooshort";
    await expect(getEncryptionKey()).rejects.toThrow("64 hex chars");
  });

  it("throws if ENCRYPTION_KEY is 64 chars but not valid hex, without writing it to the keychain", async () => {
    process.env.ENCRYPTION_KEY = "z".repeat(64); // right length, invalid hex
    await expect(getEncryptionKey()).rejects.toThrow("64 hex chars");
    expect(mockSetPassword).not.toHaveBeenCalled();
  });

  it("returns the env key as a 32-byte Buffer", async () => {
    process.env.ENCRYPTION_KEY = VALID_KEY_HEX;
    mockGetPassword.mockReturnValue(VALID_KEY_HEX); // key already in keychain → no migration
    const key = await getEncryptionKey();
    expect(key).toEqual(Buffer.from(VALID_KEY_HEX, "hex"));
    expect(key.length).toBe(32);
  });

  it("migrates env key to keychain when keychain entry is empty", async () => {
    process.env.ENCRYPTION_KEY = VALID_KEY_HEX;
    mockGetPassword.mockReturnValue(null);
    await getEncryptionKey();
    expect(mockSetPassword).toHaveBeenCalledWith(VALID_KEY_HEX);
  });

  it("logs and continues when keychain write fails during migration", async () => {
    process.env.ENCRYPTION_KEY = VALID_KEY_HEX;
    mockGetPassword.mockReturnValue(null);
    mockSetPassword.mockImplementationOnce(() => { throw new Error("keychain locked"); });
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const key = await getEncryptionKey();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("Keychain write skipped"));
    expect(key).toEqual(Buffer.from(VALID_KEY_HEX, "hex"));
  });
});

// ─── Tier 2: OS keychain ─────────────────────────────────────────────────────

describe("Tier 2 - OS keychain", () => {
  it("returns existing key from keychain without generating a new one", async () => {
    mockGetPassword.mockReturnValue(VALID_KEY_HEX);
    const key = await getEncryptionKey();
    expect(mockSetPassword).not.toHaveBeenCalled();
    expect(key).toEqual(Buffer.from(VALID_KEY_HEX, "hex"));
  });

  it("generates and saves a new key when keychain entry is empty", async () => {
    mockGetPassword.mockReturnValue(null);
    const key = await getEncryptionKey();
    expect(mockSetPassword).toHaveBeenCalledOnce();
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });
});

// ─── Tier 3: File fallback ───────────────────────────────────────────────────

describe("Tier 3 - file fallback", () => {
  it("creates directory with mode 0o700 before accessing key file", async () => {
    makeKeychainUnavailable();
    mockReadFile.mockResolvedValue(VALID_KEY_HEX as any);
    await getEncryptionKey();
    expect(mockMkdir).toHaveBeenCalledWith(
      expect.stringContaining(".jobber-mcp"),
      { recursive: true, mode: 0o700 },
    );
  });

  it("reads and returns an existing key.hex file", async () => {
    makeKeychainUnavailable();
    mockReadFile.mockResolvedValue(VALID_KEY_HEX as any);
    const key = await getEncryptionKey();
    expect(key).toEqual(Buffer.from(VALID_KEY_HEX, "hex"));
  });

  it("re-applies 0o600 to an existing key.hex on every read, not just at creation", async () => {
    makeKeychainUnavailable();
    mockReadFile.mockResolvedValue(VALID_KEY_HEX as any);
    await getEncryptionKey();
    expect(mockChmod).toHaveBeenCalledWith(expect.stringContaining("key.hex"), 0o600);
  });

  it("re-applies 0o700 to the token directory even if mkdir found it already existing", async () => {
    makeKeychainUnavailable();
    mockReadFile.mockResolvedValue(VALID_KEY_HEX as any);
    await getEncryptionKey();
    expect(mockChmod).toHaveBeenCalledWith(expect.stringContaining(".jobber-mcp"), 0o700);
  });

  it("generates and writes a new key.hex with mode 0o600 when none exists", async () => {
    makeKeychainUnavailable();
    mockReadFile.mockRejectedValueOnce(ENOENT);
    const key = await getEncryptionKey();
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining("key.hex"),
      expect.any(String),
      { mode: 0o600 },
    );
    expect(key).toBeInstanceOf(Buffer);
    expect(key.length).toBe(32);
  });
});

// ─── saveTokens / loadTokens / clearTokens round trip (real crypto except randomBytes) ──

describe("saveTokens / loadTokens / clearTokens", () => {
  const tokens: JobberTokens = {
    access_token: "at-123",
    refresh_token: "rt-456",
    expires_at: Date.now() + 3600_000,
  };

  it("writes the token file with 0o600 mode under a 0o700 directory", async () => {
    await saveTokens(tokens);
    expect(mockMkdir).toHaveBeenCalledWith(
      expect.stringContaining(".jobber-mcp"),
      { recursive: true, mode: 0o700 },
    );
    expect(mockWriteFile).toHaveBeenCalledWith(
      expect.stringContaining("tokens.enc"),
      expect.any(Buffer),
      { mode: 0o600 },
    );
  });

  it("writes to a temp file and renames it into place, never writing tokens.enc directly", async () => {
    await saveTokens(tokens);
    const [writtenPath] = mockWriteFile.mock.calls[0];
    expect(writtenPath).toMatch(/tokens\.enc\.tmp-\d+$/);
    expect(mockRename).toHaveBeenCalledWith(writtenPath, expect.stringMatching(/tokens\.enc$/));
  });

  it("round-trips tokens through encrypt then decrypt", async () => {
    let written: Buffer | undefined;
    mockWriteFile.mockImplementationOnce(async (_path, data) => {
      written = data as Buffer;
    });
    await saveTokens(tokens);
    mockReadFile.mockResolvedValueOnce(written as any);
    const loaded = await loadTokens();
    expect(loaded).toEqual(tokens);
  });

  it("returns null when no token file exists", async () => {
    mockReadFile.mockRejectedValueOnce(ENOENT);
    const loaded = await loadTokens();
    expect(loaded).toBeNull();
  });

  it("returns null and warns when decryption fails (corrupt file)", async () => {
    mockReadFile.mockResolvedValueOnce(Buffer.from("not-a-valid-encrypted-blob-at-all-1234") as any);
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    const loaded = await loadTokens();
    expect(loaded).toBeNull();
    expect(consoleSpy).toHaveBeenCalledWith(expect.stringContaining("decryption failed"));
  });

  it("clearTokens removes the token file and tolerates it already being gone", async () => {
    await clearTokens();
    expect(mockUnlink).toHaveBeenCalledWith(expect.stringContaining("tokens.enc"));

    mockUnlink.mockRejectedValueOnce(ENOENT);
    await expect(clearTokens()).resolves.toBeUndefined();
  });
});

describe("withTokenLock", () => {
  it("acquires the lock, runs fn, and releases the lock afterward", async () => {
    const order: string[] = [];
    mockOpen.mockImplementationOnce(async () => {
      order.push("open");
      return { close: vi.fn().mockResolvedValue(undefined) } as any;
    });
    mockUnlink.mockImplementationOnce(async () => {
      order.push("unlink");
    });

    const result = await withTokenLock(async () => {
      order.push("fn");
      return "done";
    });

    expect(result).toBe("done");
    expect(order).toEqual(["open", "fn", "unlink"]);
    expect(mockOpen).toHaveBeenCalledWith(expect.stringContaining("tokens.lock"), "wx");
  });

  it("releases the lock even when fn throws", async () => {
    await expect(
      withTokenLock(async () => {
        throw new Error("refresh failed");
      })
    ).rejects.toThrow("refresh failed");
    expect(mockUnlink).toHaveBeenCalledWith(expect.stringContaining("tokens.lock"));
  });

  it("retries until an existing lock is released, then proceeds", async () => {
    mockOpen
      .mockRejectedValueOnce(Object.assign(new Error("EEXIST"), { code: "EEXIST" }))
      .mockResolvedValueOnce({ close: vi.fn().mockResolvedValue(undefined) } as any);
    mockStat.mockResolvedValueOnce({ mtimeMs: Date.now() } as any); // fresh lock - not stale

    const result = await withTokenLock(async () => "ok");
    expect(result).toBe("ok");
    expect(mockOpen).toHaveBeenCalledTimes(2);
  });

  it("removes and retakes a stale lock left by a crashed process", async () => {
    mockOpen
      .mockRejectedValueOnce(Object.assign(new Error("EEXIST"), { code: "EEXIST" }))
      .mockResolvedValueOnce({ close: vi.fn().mockResolvedValue(undefined) } as any);
    mockStat.mockResolvedValueOnce({ mtimeMs: Date.now() - 60_000 } as any); // 60s old - stale

    const result = await withTokenLock(async () => "ok");
    expect(result).toBe("ok");
    expect(mockUnlink).toHaveBeenCalledWith(expect.stringContaining("tokens.lock"));
  });
});
