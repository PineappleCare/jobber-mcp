import { vi, describe, it, expect, beforeEach } from "vitest";
import { createHash } from "crypto";

const { mockExchangeCodeForTokensPure, mockRefreshTokensPure } = vi.hoisted(() => ({
  mockExchangeCodeForTokensPure: vi.fn(),
  mockRefreshTokensPure: vi.fn(),
}));

vi.mock("../../auth/oauth.js", () => ({
  exchangeCodeForTokensPure: mockExchangeCodeForTokensPure,
  refreshTokensPure: mockRefreshTokensPure,
}));

import { app, sessions, buildSessionContext, sweepStaleSessions } from "../http.js";
import type { SessionRecord } from "../http.js";

function fakeTransport() {
  return { close: vi.fn().mockResolvedValue(undefined) } as any;
}

function seedSession(overrides: Partial<SessionRecord> = {}): string {
  const id = `session-${Math.random().toString(36).slice(2)}`;
  sessions.set(id, {
    transport: fakeTransport(),
    mcpServer: null,
    tokens: null,
    pendingOAuthNonce: null,
    pendingCodeVerifier: null,
    pendingAuthorizeUrl: null,
    createdAt: Date.now(),
    lastActivityAt: Date.now(),
    apiKeyHash: hashAuthHeader(undefined),
    refreshInFlight: null,
    accountId: undefined,
    ...overrides,
  });
  return id;
}

// Mirrors http.ts's hashPresentedApiKey - sha256 of the raw Authorization header value (or "" when
// absent), so tests can seed/assert sessions bound to a specific presented key.
function hashAuthHeader(authHeader: string | undefined): string {
  return createHash("sha256").update(authHeader ?? "").digest("hex");
}

beforeEach(() => {
  sessions.clear();
  vi.clearAllMocks();
  delete process.env.MCP_API_KEY;
  delete process.env.MCP_BASE_URL;
  delete process.env.MCP_ALLOWED_ORIGINS;
});

describe("GET /health", () => {
  it("returns ok without leaking the session count", async () => {
    seedSession();
    seedSession();
    const res = await app.request("/health");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });
});

function stateFor(sessionId: string, nonce: string): string {
  return Buffer.from(`${sessionId}:${nonce}`, "utf8").toString("base64url");
}

function cookieHeaderFrom(res: Response): string {
  const setCookie = res.headers.get("set-cookie") ?? "";
  return setCookie.split(";")[0];
}

/** Drives the full two-hop flow (/oauth/start then /oauth/callback) so the binding cookie is set. */
async function startThenCallback(sessionId: string, nonce: string, callbackQuery: string) {
  const state = stateFor(sessionId, nonce);
  const startRes = await app.request(`/oauth/start?state=${state}`);
  const cookie = cookieHeaderFrom(startRes);
  const callbackRes = await app.request(`/oauth/callback?${callbackQuery}&state=${state}`, {
    headers: cookie ? { cookie } : {},
  });
  return { startRes, callbackRes, cookie };
}

describe("GET /oauth/start", () => {
  it("returns 400 when state is missing", async () => {
    const res = await app.request("/oauth/start");
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/Missing state/);
  });

  it("returns 'Session Not Found' for an unknown session", async () => {
    const state = stateFor("no-such-session", "some-nonce");
    const res = await app.request(`/oauth/start?state=${state}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/Session Not Found/);
  });

  it("sets an HttpOnly, SameSite=Lax cookie and redirects to the stored authorize URL", async () => {
    const id = seedSession({
      pendingOAuthNonce: "the-nonce",
      pendingAuthorizeUrl: "https://fake-jobber.test/oauth/authorize?x=1",
    });
    const state = stateFor(id, "the-nonce");
    const res = await app.request(`/oauth/start?state=${state}`);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://fake-jobber.test/oauth/authorize?x=1");
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/oauth_nonce=the-nonce/);
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
  });
});

describe("GET /oauth/callback", () => {
  it("returns 400 when code or state is missing", async () => {
    const res = await app.request("/oauth/callback");
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/Missing code or state/);
  });

  it("returns 400 when Jobber reports an OAuth error, without reflecting the raw error text (XSS)", async () => {
    const res = await app.request("/oauth/callback?error=" + encodeURIComponent("<script>alert(1)</script>"));
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).not.toContain("<script>alert(1)</script>");
    expect(body).toMatch(/identity provider returned an error/i);
  });

  it("returns 'Session Not Found' for a well-formed state that doesn't decode to a known session", async () => {
    const state = stateFor("unknown-session-id", "some-nonce");
    const res = await app.request(`/oauth/callback?code=abc&state=${state}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/Session Not Found/);
  });

  it("returns 400 for a malformed (non-colon) state", async () => {
    const res = await app.request("/oauth/callback?code=abc&state=garbage-not-a-real-state");
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/Invalid state parameter/);
  });

  it("returns 400 when the nonce does not match (CSRF protection)", async () => {
    const id = seedSession({ pendingOAuthNonce: "expected-nonce" });
    const state = stateFor(id, "wrong-nonce");
    const res = await app.request(`/oauth/callback?code=abc&state=${state}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/Invalid State/);
    expect(mockExchangeCodeForTokensPure).not.toHaveBeenCalled();
  });

  it("returns 400 when no /oauth/start cookie was ever set (login-CSRF protection)", async () => {
    const id = seedSession({ pendingOAuthNonce: "the-nonce" });
    const state = stateFor(id, "the-nonce");
    const res = await app.request(`/oauth/callback?code=abc&state=${state}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/Invalid State/);
    expect(mockExchangeCodeForTokensPure).not.toHaveBeenCalled();
  });

  it("returns 400 when the cookie doesn't match the session's nonce (forged/stale cookie)", async () => {
    const id = seedSession({ pendingOAuthNonce: "the-nonce" });
    const state = stateFor(id, "the-nonce");
    const res = await app.request(`/oauth/callback?code=abc&state=${state}`, {
      headers: { cookie: "oauth_nonce=someone-elses-nonce" },
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/Invalid State/);
    expect(mockExchangeCodeForTokensPure).not.toHaveBeenCalled();
  });

  it("exchanges the code and stores tokens on success, once the /oauth/start cookie is presented", async () => {
    const id = seedSession({
      pendingOAuthNonce: "the-nonce",
      pendingAuthorizeUrl: "https://fake-jobber.test/oauth/authorize?x=1",
    });
    mockExchangeCodeForTokensPure.mockResolvedValue({
      access_token: "at",
      refresh_token: "rt",
      expires_at: Date.now() + 3600_000,
      account_id: "acc1",
    });
    const { callbackRes } = await startThenCallback(id, "the-nonce", "code=abc123");
    expect(callbackRes.status).toBe(200);
    expect(await callbackRes.text()).toMatch(/Authentication Successful/);
    expect(mockExchangeCodeForTokensPure).toHaveBeenCalledWith("abc123", expect.stringContaining("/oauth/callback"), undefined);
    expect(sessions.get(id)?.tokens?.access_token).toBe("at");
    expect(sessions.get(id)?.pendingOAuthNonce).toBeNull();
  });

  it("writes the audit log entry inside a session context, without the fail-closed 'missing session context' warning", async () => {
    const previousTransport = process.env.TRANSPORT;
    process.env.TRANSPORT = "http";
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const id = seedSession({
        pendingOAuthNonce: "the-nonce",
        pendingAuthorizeUrl: "https://fake-jobber.test/oauth/authorize?x=1",
      });
      mockExchangeCodeForTokensPure.mockResolvedValue({
        access_token: "at",
        refresh_token: "rt",
        expires_at: Date.now() + 3600_000,
        account_id: "acc1",
      });
      const { callbackRes } = await startThenCallback(id, "the-nonce", "code=abc123");
      expect(callbackRes.status).toBe(200);
      expect(errorSpy).not.toHaveBeenCalledWith(expect.stringMatching(/missing session context/i));
    } finally {
      if (previousTransport === undefined) delete process.env.TRANSPORT;
      else process.env.TRANSPORT = previousTransport;
      errorSpy.mockRestore();
    }
  });

  it("returns 500 with a fixed message when token exchange fails, without reflecting the raw error (XSS)", async () => {
    const id = seedSession({
      pendingOAuthNonce: "the-nonce",
      pendingAuthorizeUrl: "https://fake-jobber.test/oauth/authorize?x=1",
    });
    mockExchangeCodeForTokensPure.mockRejectedValue(new Error("<script>alert(document.domain)</script>"));
    const { callbackRes } = await startThenCallback(id, "the-nonce", "code=abc");
    expect(callbackRes.status).toBe(500);
    const body = await callbackRes.text();
    expect(body).not.toContain("<script>alert(document.domain)</script>");
    expect(body).toMatch(/try authenticating again/i);
  });
});

describe("buildSessionContext - getAccessToken refresh-on-expiry", () => {
  it("refreshes an already-expired token before returning it", async () => {
    const record: SessionRecord = {
      transport: fakeTransport(),
      mcpServer: null,
      tokens: {
        access_token: "AT-old",
        refresh_token: "RT-old",
        expires_at: Date.now() - 60 * 60 * 1000, // expired an hour ago
      },
      pendingOAuthNonce: null,
      pendingCodeVerifier: null,
      pendingAuthorizeUrl: null,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      apiKeyHash: hashAuthHeader(undefined),
      refreshInFlight: null,
      accountId: undefined,
    };
    mockRefreshTokensPure.mockResolvedValue({
      access_token: "AT-refreshed",
      refresh_token: "RT-refreshed",
      expires_at: Date.now() + 3600_000,
    });

    const ctx = buildSessionContext(record, "session-1");
    const accessToken = await ctx.getAccessToken();

    expect(accessToken).toBe("AT-refreshed");
    expect(mockRefreshTokensPure).toHaveBeenCalledWith("RT-old");
    expect(record.tokens?.access_token).toBe("AT-refreshed");
  });

  it("does not refresh a token that still has more than 5 minutes left", async () => {
    const record: SessionRecord = {
      transport: fakeTransport(),
      mcpServer: null,
      tokens: {
        access_token: "AT-fresh",
        refresh_token: "RT-fresh",
        expires_at: Date.now() + 60 * 60 * 1000,
      },
      pendingOAuthNonce: null,
      pendingCodeVerifier: null,
      pendingAuthorizeUrl: null,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      apiKeyHash: hashAuthHeader(undefined),
      refreshInFlight: null,
      accountId: undefined,
    };

    const ctx = buildSessionContext(record, "session-1");
    const accessToken = await ctx.getAccessToken();

    expect(accessToken).toBe("AT-fresh");
    expect(mockRefreshTokensPure).not.toHaveBeenCalled();
  });

  it("reads and writes the account id through the underlying session record", () => {
    const record: SessionRecord = {
      transport: fakeTransport(),
      mcpServer: null,
      tokens: null,
      pendingOAuthNonce: null,
      pendingCodeVerifier: null,
      pendingAuthorizeUrl: null,
      createdAt: Date.now(),
      lastActivityAt: Date.now(),
      apiKeyHash: hashAuthHeader(undefined),
      refreshInFlight: null,
      accountId: undefined,
    };

    const ctx = buildSessionContext(record, "session-1");
    expect(ctx.getAccountId()).toBeUndefined();

    ctx.setAccountId("acct-123");
    expect(record.accountId).toBe("acct-123");
    expect(ctx.getAccountId()).toBe("acct-123");
  });
});

describe("/mcp", () => {
  it("rejects requests without a bearer token when MCP_API_KEY is set", async () => {
    process.env.MCP_API_KEY = "secret-key";
    const res = await app.request("/mcp", { method: "POST" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Unauthorized" });
  });

  it("rejects requests with the wrong bearer token", async () => {
    process.env.MCP_API_KEY = "secret-key";
    const res = await app.request("/mcp", { method: "POST", headers: { authorization: "Bearer wrong" } });
    expect(res.status).toBe(401);
  });

  it("does not reject requests with the correct bearer token", async () => {
    process.env.MCP_API_KEY = "secret-key";
    const res = await app.request("/mcp", { method: "POST", headers: { authorization: "Bearer secret-key" } });
    expect(res.status).not.toBe(401);
  });

  it("returns 404 for an unknown mcp-session-id", async () => {
    const res = await app.request("/mcp", { method: "POST", headers: { "mcp-session-id": "does-not-exist" } });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "Session not found" });
  });

  describe("session binding and idle timeout", () => {
    it("returns 404 for a valid session id presented with a different API key than created it", async () => {
      const id = seedSession({ apiKeyHash: hashAuthHeader("Bearer created-with-this-key") });
      const res = await app.request("/mcp", {
        method: "POST",
        headers: { "mcp-session-id": id, authorization: "Bearer some-other-key" },
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "Session not found" });
    });

    it("accepts a valid session id presented with the same (hashed) key that created it", async () => {
      const id = seedSession({ apiKeyHash: hashAuthHeader("Bearer the-right-key") });
      const res = await app.request("/mcp", {
        method: "POST",
        headers: { "mcp-session-id": id, authorization: "Bearer the-right-key" },
      });
      expect(res.status).not.toBe(404);
    });

    it("bumps lastActivityAt on a successful lookup", async () => {
      const id = seedSession({ apiKeyHash: hashAuthHeader(undefined), lastActivityAt: 0 });
      await app.request("/mcp", { method: "POST", headers: { "mcp-session-id": id } });
      expect(sessions.get(id)!.lastActivityAt).toBeGreaterThan(0);
    });
  });

  describe("sweepStaleSessions", () => {
    it("removes a session idle for more than 30 minutes", () => {
      const id = seedSession({ lastActivityAt: Date.now() - 31 * 60 * 1000 });
      sweepStaleSessions();
      expect(sessions.has(id)).toBe(false);
    });

    it("removes a session older than 24 hours even if recently active", () => {
      const id = seedSession({
        createdAt: Date.now() - 25 * 60 * 60 * 1000,
        lastActivityAt: Date.now(),
      });
      sweepStaleSessions();
      expect(sessions.has(id)).toBe(false);
    });

    it("keeps a recently active, recently created session", () => {
      const id = seedSession({ createdAt: Date.now(), lastActivityAt: Date.now() });
      sweepStaleSessions();
      expect(sessions.has(id)).toBe(true);
    });
  });

  describe("Host/Origin allowlist (DNS-rebinding protection)", () => {
    it("rejects a request with a mismatched Host header when MCP_BASE_URL is configured", async () => {
      process.env.MCP_BASE_URL = "http://127.0.0.1:3000";
      const res = await app.request("/mcp", { method: "POST", headers: { host: "evil.example" } });
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({ error: "Forbidden - Host/Origin not allowed" });
    });

    it("allows a request with the Host header matching MCP_BASE_URL", async () => {
      process.env.MCP_BASE_URL = "http://127.0.0.1:3000";
      const res = await app.request("/mcp", { method: "POST", headers: { host: "127.0.0.1:3000" } });
      expect(res.status).not.toBe(403);
    });

    it("rejects a request with a disallowed Origin header", async () => {
      process.env.MCP_BASE_URL = "http://127.0.0.1:3000";
      const res = await app.request("/mcp", { method: "POST", headers: { origin: "https://evil.example" } });
      expect(res.status).toBe(403);
    });

    it("allows a request with an Origin matching MCP_BASE_URL", async () => {
      process.env.MCP_BASE_URL = "http://127.0.0.1:3000";
      const res = await app.request("/mcp", { method: "POST", headers: { origin: "http://127.0.0.1:3000" } });
      expect(res.status).not.toBe(403);
    });

    it("allows an Origin listed in MCP_ALLOWED_ORIGINS even if it differs from MCP_BASE_URL", async () => {
      process.env.MCP_BASE_URL = "http://127.0.0.1:3000";
      process.env.MCP_ALLOWED_ORIGINS = "https://proxy.example, https://cdn.example";
      const res = await app.request("/mcp", { method: "POST", headers: { origin: "https://cdn.example" } });
      expect(res.status).not.toBe(403);
    });

    it("does not block requests when MCP_BASE_URL is unset", async () => {
      delete process.env.MCP_BASE_URL;
      const res = await app.request("/mcp", { method: "POST", headers: { host: "anything.example" } });
      expect(res.status).not.toBe(403);
    });
  });
});
