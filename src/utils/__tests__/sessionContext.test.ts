import { describe, it, expect, afterEach } from "vitest";
import { sessionStorage, getSessionContext, isStdioMode, requireSessionContext } from "../sessionContext.js";
import type { SessionContext } from "../sessionContext.js";

const ORIGINAL_TRANSPORT = process.env.TRANSPORT;

afterEach(() => {
  if (ORIGINAL_TRANSPORT === undefined) delete process.env.TRANSPORT;
  else process.env.TRANSPORT = ORIGINAL_TRANSPORT;
});

describe("isStdioMode", () => {
  it("defaults to stdio when TRANSPORT is unset", () => {
    delete process.env.TRANSPORT;
    expect(isStdioMode()).toBe(true);
  });

  it("is false when TRANSPORT=http", () => {
    process.env.TRANSPORT = "http";
    expect(isStdioMode()).toBe(false);
  });

  it("is case-insensitive", () => {
    process.env.TRANSPORT = "STDIO";
    expect(isStdioMode()).toBe(true);
  });
});

describe("getSessionContext / sessionStorage", () => {
  it("returns undefined outside of sessionStorage.run", () => {
    expect(getSessionContext()).toBeUndefined();
  });

  it("returns the context set by sessionStorage.run", async () => {
    const ctx = makeFakeContext("session-1");
    await sessionStorage.run(ctx, async () => {
      expect(getSessionContext()).toBe(ctx);
    });
  });
});

describe("requireSessionContext", () => {
  it("returns null in stdio mode when no context is set", () => {
    delete process.env.TRANSPORT;
    expect(requireSessionContext()).toBeNull();
  });

  it("throws in HTTP mode when no context is set (fail-closed)", () => {
    process.env.TRANSPORT = "http";
    expect(() => requireSessionContext()).toThrow(/missing session context/i);
  });

  it("returns the context in HTTP mode when one is set", async () => {
    process.env.TRANSPORT = "http";
    const ctx = makeFakeContext("session-2");
    await sessionStorage.run(ctx, async () => {
      expect(requireSessionContext()).toBe(ctx);
    });
  });
});

function makeFakeContext(sessionId: string): SessionContext {
  return {
    sessionId,
    getAccessToken: async () => "fake-token",
    storeTokens: () => {},
    getTokens: () => null,
    clearTokens: () => {},
    setPendingNonce: () => {},
    setPendingCodeVerifier: () => {},
    setPendingAuthorizeUrl: () => {},
    getAccountId: () => null,
    setAccountId: () => {},
  };
}
