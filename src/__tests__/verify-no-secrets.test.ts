import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const { mockExecSync, mockReadFileSync } = vi.hoisted(() => ({
  mockExecSync: vi.fn(),
  mockReadFileSync: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execSync: mockExecSync }));
vi.mock("node:fs", () => ({ readFileSync: mockReadFileSync }));

const { findSecretMatches, main } = await import("../../scripts/verify-no-secrets.mjs");

describe("verify-no-secrets patterns", () => {
  it.each([
    ["quoted client_secret", 'client_secret: "abcdefghijklmnop"'],
    ["quoted camelCase clientSecret", 'clientSecret = "abcdefghijklmnop"'],
    ["quoted access_token", 'access_token: "abcdefghijklmnop"'],
    ["quoted refresh_token", 'refresh_token: "abcdefghijklmnop"'],
    ["quoted api_key", 'api_key: "abcdefghijklmnop"'],
    ["quoted encryption_key", 'encryption_key: "abcdefghijklmnop"'],
    ["quoted password", 'password: "abcdefghijklmnop"'],
    ["unquoted env-style CLIENT_SECRET", "CLIENT_SECRET=abcdefghijklmnop1234"],
    ["unquoted env-style ACCESS_TOKEN", "ACCESS_TOKEN=abcdefghijklmnop1234"],
    ["unquoted env-style REFRESH_TOKEN", "REFRESH_TOKEN=abcdefghijklmnop1234"],
    ["unquoted env-style API_KEY", "API_KEY=abcdefghijklmnop1234"],
    ["unquoted env-style ENCRYPTION_KEY", "ENCRYPTION_KEY=abcdefghijklmnop1234"],
    ["unquoted env-style PASSWORD", "PASSWORD=abcdefghijklmnop1234"],
    ["unquoted env-style value with a trailing comment", "REFRESH_TOKEN=abcdefghijklmnop1234 # rotate me"],
    ["url-embedded credentials", "postgres://user:hunter2@db.internal:5432/app"],
    ["bare 64-hex key", "a".repeat(64)],
    ["JWT-shaped string", "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U"],
    ["Bearer token", "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456"],
    ["lowercase bearer token", "authorization: bearer abcdefghijklmnopqrstuvwxyz123456"],
  ])("catches %s", (_label, sample) => {
    expect(findSecretMatches(sample).length).toBeGreaterThan(0);
  });

  it("does not flag an ordinary JS/TS property access like 'access_token: tokens.access_token,'", () => {
    expect(findSecretMatches("access_token: tokens.access_token,")).toEqual([]);
  });

  it("does not flag a short, non-secret-looking string", () => {
    expect(findSecretMatches("const client_secret = getSecret();")).toEqual([]);
  });
});

describe("verify-no-secrets main()", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    vi.clearAllMocks();
    exitSpy = vi.spyOn(process, "exit").mockImplementation(() => undefined as never);
    errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits 1 and logs a FAIL line when a packed file matches a secret pattern", () => {
    mockExecSync.mockReturnValue(JSON.stringify([{ files: [{ path: "build/index.js" }] }]));
    mockReadFileSync.mockReturnValue('client_secret: "abcdefghijklmnop"');

    main();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("FAIL"));
  });

  it("does not exit with failure when no packed file matches", () => {
    mockExecSync.mockReturnValue(JSON.stringify([{ files: [{ path: "build/index.js" }, { path: "README.md" }] }]));
    mockReadFileSync.mockReturnValue("nothing secret here");

    main();

    expect(exitSpy).not.toHaveBeenCalled();
  });
});
