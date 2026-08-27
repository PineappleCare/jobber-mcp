import { vi, describe, it, expect, beforeAll, beforeEach } from "vitest";

const { mockClearTokens, mockLoadTokens, mockGetValidAccessToken, mockBuildAuthorizationUrl, mockRevokeToken, mockAppendAuditLog, mockRequireSessionContext } = vi.hoisted(() => ({
  mockClearTokens: vi.fn(),
  mockLoadTokens: vi.fn(),
  mockGetValidAccessToken: vi.fn(),
  mockBuildAuthorizationUrl: vi.fn(),
  mockRevokeToken: vi.fn().mockResolvedValue(undefined),
  mockAppendAuditLog: vi.fn(),
  mockRequireSessionContext: vi.fn(),
}));

vi.mock("../tokenStorage.js", () => ({
  clearTokens: mockClearTokens,
  loadTokens: mockLoadTokens,
}));

vi.mock("../oauth.js", () => ({
  getValidAccessToken: mockGetValidAccessToken,
  buildAuthorizationUrl: mockBuildAuthorizationUrl,
  revokeToken: mockRevokeToken,
}));

vi.mock("../../utils/auditLog.js", () => ({
  appendAuditLog: mockAppendAuditLog,
}));

vi.mock("../../utils/sessionContext.js", () => ({
  requireSessionContext: mockRequireSessionContext,
}));

import { registerAuthTools } from "../authTools.js";

const handlers: Record<string, (args?: any) => Promise<any>> = {};
const fakeServer = {
  registerTool: vi.fn((name: string, _schema: any, handler: (args?: any) => Promise<any>) => {
    handlers[name] = handler;
  }),
};

beforeAll(() => {
  registerAuthTools(fakeServer as any);
});

beforeEach(() => {
  vi.clearAllMocks();
});

function fakeCtx(overrides: Partial<Record<string, any>> = {}) {
  return {
    sessionId: "sess-1",
    getAccessToken: vi.fn(),
    storeTokens: vi.fn(),
    getTokens: vi.fn().mockReturnValue(null),
    clearTokens: vi.fn(),
    setPendingNonce: vi.fn(),
    setPendingCodeVerifier: vi.fn(),
    setPendingAuthorizeUrl: vi.fn(),
    ...overrides,
  };
}

describe("auth_status", () => {
  it("reports unauthenticated when no tokens exist (stdio)", async () => {
    mockRequireSessionContext.mockReturnValue(null);
    mockLoadTokens.mockResolvedValue(null);

    const result = await handlers["auth_status"]();
    expect(JSON.parse(result.content[0].text)).toEqual({ authenticated: false });
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "auth_status", outcome: "success" })
    );
  });

  it("reports authenticated with minutes-to-expiry when tokens exist", async () => {
    mockRequireSessionContext.mockReturnValue(null);
    mockLoadTokens.mockResolvedValue({
      access_token: "at",
      refresh_token: "rt",
      expires_at: Date.now() + 30 * 60 * 1000,
    });

    const result = await handlers["auth_status"]();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.authenticated).toBe(true);
    expect(parsed.token_expired).toBe(false);
    expect(parsed.token_expires_in_minutes).toBeGreaterThanOrEqual(29);
  });

  it("flags an expired token with a warning", async () => {
    mockRequireSessionContext.mockReturnValue(null);
    mockLoadTokens.mockResolvedValue({
      access_token: "at",
      refresh_token: "rt",
      expires_at: Date.now() - 60 * 1000,
    });

    const result = await handlers["auth_status"]();
    const parsed = JSON.parse(result.content[0].text);
    expect(parsed.token_expired).toBe(true);
    expect(parsed.warning).toMatch(/authenticate/i);
  });

  it("reads tokens from the session context in HTTP mode", async () => {
    const ctx = fakeCtx({ getTokens: vi.fn().mockReturnValue({ access_token: "at", refresh_token: "rt", expires_at: Date.now() + 60_000 }) });
    mockRequireSessionContext.mockReturnValue(ctx);

    const result = await handlers["auth_status"]();
    expect(mockLoadTokens).not.toHaveBeenCalled();
    expect(JSON.parse(result.content[0].text).authenticated).toBe(true);
  });
});

describe("authenticate", () => {
  it("stdio mode: blocks on getValidAccessToken and reports success", async () => {
    mockRequireSessionContext.mockReturnValue(null);
    mockGetValidAccessToken.mockResolvedValue("at");

    const result = await handlers["authenticate"]();
    expect(mockGetValidAccessToken).toHaveBeenCalled();
    expect(result.content[0].text).toContain("Successfully authenticated");
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "authenticate", outcome: "success" })
    );
  });

  it("stdio mode: reports an error result when the OAuth flow throws", async () => {
    mockRequireSessionContext.mockReturnValue(null);
    mockGetValidAccessToken.mockRejectedValue(new Error("boom"));

    const result = await handlers["authenticate"]();
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("boom");
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "authenticate", outcome: "error", error_message: "boom" })
    );
  });

  it("HTTP mode: returns this server's own /oauth/start URL (not the raw Jobber URL), and stores pending nonce/verifier/authorize-url", async () => {
    const originalBaseUrl = process.env.MCP_BASE_URL;
    process.env.MCP_BASE_URL = "http://127.0.0.1:3000";
    try {
      const ctx = fakeCtx();
      mockRequireSessionContext.mockReturnValue(ctx);
      mockBuildAuthorizationUrl.mockReturnValue({
        url: "https://jobber.example/authorize?x=1",
        nonce: "nonce-abc",
        codeVerifier: "verifier-xyz",
        state: "encoded-state-value",
      });

      const result = await handlers["authenticate"]();
      expect(mockGetValidAccessToken).not.toHaveBeenCalled();
      expect(ctx.setPendingNonce).toHaveBeenCalledWith("nonce-abc");
      expect(ctx.setPendingCodeVerifier).toHaveBeenCalledWith("verifier-xyz");
      expect(ctx.setPendingAuthorizeUrl).toHaveBeenCalledWith("https://jobber.example/authorize?x=1");
      expect(result.content[0].text).toContain("http://127.0.0.1:3000/oauth/start?state=encoded-state-value");
      expect(result.content[0].text).not.toContain("jobber.example");
    } finally {
      process.env.MCP_BASE_URL = originalBaseUrl;
    }
  });
});

describe("logout", () => {
  it("stdio mode: clears the token file and attempts revocation with the stored access token", async () => {
    mockRequireSessionContext.mockReturnValue(null);
    mockLoadTokens.mockResolvedValue({ access_token: "at", refresh_token: "rt", expires_at: 0, account_id: "acc-1" });

    const result = await handlers["logout"]();
    expect(mockRevokeToken).toHaveBeenCalledWith("at");
    expect(mockClearTokens).toHaveBeenCalled();
    expect(result.content[0].text).toContain("Logged out");
    expect(mockAppendAuditLog).toHaveBeenCalledWith(
      expect.objectContaining({ tool: "logout", outcome: "success", account_id: "acc-1" })
    );
  });

  it("HTTP mode: clears the in-memory session tokens instead of the file, and attempts revocation", async () => {
    const ctx = fakeCtx({ getTokens: vi.fn().mockReturnValue({ access_token: "at-2", account_id: "acc-2" }) });
    mockRequireSessionContext.mockReturnValue(ctx);

    const result = await handlers["logout"]();
    expect(mockRevokeToken).toHaveBeenCalledWith("at-2");
    expect(ctx.clearTokens).toHaveBeenCalled();
    expect(mockClearTokens).not.toHaveBeenCalled();
    expect(result.content[0].text).toContain("Logged out");
  });

  it("skips revocation when there is no access token to revoke", async () => {
    mockRequireSessionContext.mockReturnValue(null);
    mockLoadTokens.mockResolvedValue(null);

    const result = await handlers["logout"]();
    expect(mockRevokeToken).not.toHaveBeenCalled();
    expect(mockClearTokens).toHaveBeenCalled();
    expect(result.content[0].text).toContain("Logged out");
  });

  it("still clears local tokens and reports success even if revokeToken unexpectedly rejects", async () => {
    mockRequireSessionContext.mockReturnValue(null);
    mockLoadTokens.mockResolvedValue({ access_token: "at", refresh_token: "rt", expires_at: 0, account_id: "acc-1" });
    // Real revokeToken (oauth.ts) is documented never to throw; this proves logout doesn't depend on it.
    mockRevokeToken.mockRejectedValueOnce(new Error("network error"));

    const result = await handlers["logout"]();
    expect(mockClearTokens).toHaveBeenCalled();
    expect(result.content[0].text).toContain("Logged out");
    expect(result.isError).toBeUndefined();
  });
});
