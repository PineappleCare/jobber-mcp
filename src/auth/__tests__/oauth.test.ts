import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import net from "node:net";
import http from "node:http";
import crypto from "node:crypto";

const { mockSaveTokens, mockLoadTokens, mockOpen } = vi.hoisted(() => ({
  mockSaveTokens: vi.fn().mockResolvedValue(undefined),
  mockLoadTokens: vi.fn(),
  mockOpen: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("../tokenStorage.js", () => ({
  saveTokens: mockSaveTokens,
  loadTokens: mockLoadTokens,
  // No real cross-process contention in these tests - just run the callback directly.
  withTokenLock: (fn: () => Promise<unknown>) => fn(),
}));

vi.mock("open", () => ({ default: mockOpen }));

import {
  runOAuthFlow,
  buildAuthorizationUrl,
  exchangeCodeForTokensPure,
  refreshTokensPure,
  revokeToken,
  getValidAccessToken,
} from "../oauth.js";

const ENV_KEYS = [
  "JOBBER_CLIENT_ID",
  "JOBBER_CLIENT_SECRET",
  "JOBBER_REDIRECT_PORT",
  "JOBBER_AUTH_URL",
  "JOBBER_TOKEN_URL",
  "MCP_BASE_URL",
] as const;
type EnvKey = (typeof ENV_KEYS)[number];

const DEFAULT_ENV: Record<EnvKey, string> = {
  JOBBER_CLIENT_ID: "test-client-id",
  JOBBER_CLIENT_SECRET: "test-client-secret",
  JOBBER_REDIRECT_PORT: "5679",
  JOBBER_AUTH_URL: "https://fake-jobber.test/oauth/authorize",
  JOBBER_TOKEN_URL: "https://fake-jobber.test/oauth/token",
  MCP_BASE_URL: "http://127.0.0.1:3000",
};

function applyEnv(overrides: Partial<Record<EnvKey, string>> = {}) {
  const merged = { ...DEFAULT_ENV, ...overrides };
  for (const key of ENV_KEYS) {
    process.env[key] = merged[key];
  }
}

function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      })
      .on("error", reject);
  });
}

function waitForPortOpen(port: number, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ port, host: "127.0.0.1" }, () => {
        socket.destroy();
        resolve();
      });
      socket.on("error", () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) reject(new Error(`port ${port} did not open in time`));
        else setTimeout(attempt, 20);
      });
    };
    attempt();
  });
}

function jsonResponse(status: number, body: unknown) {
  return {
    ok: status < 400,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  applyEnv();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("exchangeCodeForTokensPure", () => {
  it("posts grant_type=authorization_code with client credentials and computes expires_at", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { access_token: "AT1", refresh_token: "RT1", expires_in: 3600 })
    );
    vi.stubGlobal("fetch", fetchMock);

    const before = Date.now();
    const tokens = await exchangeCodeForTokensPure("auth-code-1", "http://127.0.0.1:5679/callback");
    const after = Date.now();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://fake-jobber.test/oauth/token");
    expect(options.method).toBe("POST");
    const body = options.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code-1");
    expect(body.get("client_id")).toBe("test-client-id");
    expect(body.get("client_secret")).toBe("test-client-secret");
    expect(body.get("redirect_uri")).toBe("http://127.0.0.1:5679/callback");

    expect(tokens.access_token).toBe("AT1");
    expect(tokens.refresh_token).toBe("RT1");
    expect(tokens.expires_at).toBeGreaterThanOrEqual(before + 3600 * 1000);
    expect(tokens.expires_at).toBeLessThanOrEqual(after + 3600 * 1000);
  });

  it("throws a descriptive error on failure, without ever including the client secret", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue({ ok: false, status: 401, text: async () => '{"error":"invalid_client"}' });
    vi.stubGlobal("fetch", fetchMock);

    let caught: Error | undefined;
    try {
      await exchangeCodeForTokensPure("bad-code", "http://127.0.0.1:5679/callback");
    } catch (err) {
      caught = err as Error;
    }
    expect(caught?.message).toMatch(/Token exchange failed/);
    expect(caught?.message).not.toContain("test-client-secret");
  });

  it("includes code_verifier in the request body when one is supplied", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(200, { access_token: "AT1", refresh_token: "RT1", expires_in: 3600 })
    );
    vi.stubGlobal("fetch", fetchMock);

    await exchangeCodeForTokensPure("auth-code-1", "http://127.0.0.1:5679/callback", "verifier-xyz");

    const [, options] = fetchMock.mock.calls[0];
    const body = options.body as URLSearchParams;
    expect(body.get("code_verifier")).toBe("verifier-xyz");
  });

  it("throws a clear error when the token response is missing expires_in, instead of producing NaN", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { access_token: "AT1", refresh_token: "RT1" }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(exchangeCodeForTokensPure("auth-code-1", "http://127.0.0.1:5679/callback")).rejects.toThrow(
      /expires_in/
    );
  });

  it("throws a clear error when the token response is missing access_token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { refresh_token: "RT1", expires_in: 3600 }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(exchangeCodeForTokensPure("auth-code-1", "http://127.0.0.1:5679/callback")).rejects.toThrow(
      /access_token/
    );
  });
});

describe("refreshTokensPure", () => {
  it("posts grant_type=refresh_token with client credentials", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { access_token: "AT2", refresh_token: "RT2", expires_in: 1800 }));
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await refreshTokensPure("old-refresh-token");

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://fake-jobber.test/oauth/token");
    const body = options.body as URLSearchParams;
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("old-refresh-token");
    expect(body.get("client_id")).toBe("test-client-id");
    expect(body.get("client_secret")).toBe("test-client-secret");
    expect(tokens.access_token).toBe("AT2");
    expect(tokens.refresh_token).toBe("RT2");
  });

  it("falls back to the old refresh_token when Jobber's response omits one", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { access_token: "AT3", expires_in: 1800 }));
    vi.stubGlobal("fetch", fetchMock);

    const tokens = await refreshTokensPure("keep-me");
    expect(tokens.refresh_token).toBe("keep-me");
  });

  it("throws a generic re-authenticate message on failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => "" });
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshTokensPure("x")).rejects.toThrow("Token refresh failed, please re-authenticate.");
  });
});

describe("revokeToken", () => {
  it("posts the appDisconnect mutation to the GraphQL endpoint, authenticated with the token", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { data: { appDisconnect: { app: { id: "1" } } } }));
    vi.stubGlobal("fetch", fetchMock);

    await revokeToken("access-token-to-revoke");

    const [url, options] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.getjobber.com/api/graphql");
    expect(options.method).toBe("POST");
    expect(options.headers.Authorization).toBe("Bearer access-token-to-revoke");
    expect(options.headers["X-JOBBER-GRAPHQL-VERSION"]).toBeTruthy();
    const body = JSON.parse(options.body as string);
    expect(body.query).toMatch(/appDisconnect/);
  });

  it("respects JOBBER_GRAPHQL_URL when set", async () => {
    process.env.JOBBER_GRAPHQL_URL = "https://fake-jobber.test/graphql";
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(200, { data: {} }));
    vi.stubGlobal("fetch", fetchMock);

    await revokeToken("at");

    expect(fetchMock.mock.calls[0][0]).toBe("https://fake-jobber.test/graphql");
    delete process.env.JOBBER_GRAPHQL_URL;
  });

  it("never throws when Jobber returns a non-OK response", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 404, text: async () => "not found" });
    vi.stubGlobal("fetch", fetchMock);

    await expect(revokeToken("at")).resolves.toBeUndefined();
  });

  it("never throws when Jobber returns a 200 with a GraphQL errors array, but logs the detail", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { errors: [{ message: "Not authorized to disconnect this app" }] }));
    vi.stubGlobal("fetch", fetchMock);
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(revokeToken("at")).resolves.toBeUndefined();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Not authorized to disconnect this app"));
    errorSpy.mockRestore();
  });

  it("never throws when the network request itself fails", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("ECONNREFUSED"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(revokeToken("at")).resolves.toBeUndefined();
  });
});

describe("buildAuthorizationUrl", () => {
  it("builds a Jobber authorize URL and encodes state as base64url(sessionId:nonce)", () => {
    const { url, nonce } = buildAuthorizationUrl("session-123");
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe("https://fake-jobber.test/oauth/authorize");
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("client_id")).toBe("test-client-id");
    expect(parsed.searchParams.get("redirect_uri")).toBe("http://127.0.0.1:3000/oauth/callback");

    const state = parsed.searchParams.get("state")!;
    const decoded = Buffer.from(state, "base64url").toString("utf8");
    expect(decoded).toBe(`session-123:${nonce}`);
  });

  it("generates a fresh nonce/state on each call", () => {
    const first = buildAuthorizationUrl("session-abc");
    const second = buildAuthorizationUrl("session-abc");
    expect(first.nonce).not.toBe(second.nonce);
  });

  it("includes a PKCE code_challenge derived from the returned code_verifier", () => {
    const { url, codeVerifier } = buildAuthorizationUrl("session-123");
    const parsed = new URL(url);
    expect(parsed.searchParams.get("code_challenge_method")).toBe("S256");
    const expectedChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
    expect(parsed.searchParams.get("code_challenge")).toBe(expectedChallenge);
  });

  it("generates a fresh code_verifier on each call", () => {
    const first = buildAuthorizationUrl("session-abc");
    const second = buildAuthorizationUrl("session-abc");
    expect(first.codeVerifier).not.toBe(second.codeVerifier);
  });
});

describe("runOAuthFlow (local callback server, end-to-end)", () => {
  it("opens the browser, waits for the callback, exchanges the code, and saves tokens", async () => {
    const TEST_PORT = "58234";
    applyEnv({ JOBBER_REDIRECT_PORT: TEST_PORT });
    let capturedAuthUrl = "";
    mockOpen.mockImplementation(async (url: string) => {
      capturedAuthUrl = url;
    });

    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/oauth/token")) {
        return jsonResponse(200, { access_token: "AT-flow", refresh_token: "RT-flow", expires_in: 3600 });
      }
      throw new Error(`Unexpected fetch to ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const flowPromise = runOAuthFlow();

    await vi.waitFor(
      () => {
        if (!capturedAuthUrl) throw new Error("authorize URL not captured yet");
      },
      { timeout: 2000, interval: 10 }
    );
    await waitForPortOpen(Number(TEST_PORT));

    const state = new URL(capturedAuthUrl).searchParams.get("state")!;
    const callbackRes = await httpGet(
      `http://127.0.0.1:${TEST_PORT}/callback?code=auth-code-xyz&state=${state}`
    );
    expect(callbackRes.status).toBe(200);
    expect(callbackRes.body).toContain("Authentication successful");

    const tokens = await flowPromise;
    expect(tokens.access_token).toBe("AT-flow");
    expect(mockSaveTokens).toHaveBeenCalledWith(expect.objectContaining({ access_token: "AT-flow" }));
  });

  it("rejects with a state-mismatch error when the callback state does not match", async () => {
    const TEST_PORT = "58236";
    applyEnv({ JOBBER_REDIRECT_PORT: TEST_PORT });
    let capturedAuthUrl = "";
    mockOpen.mockImplementation(async (url: string) => {
      capturedAuthUrl = url;
    });
    vi.stubGlobal("fetch", vi.fn());

    const flowPromise = runOAuthFlow();
    flowPromise.catch(() => {}); // avoid unhandled rejection before the assertion below

    await vi.waitFor(
      () => {
        if (!capturedAuthUrl) throw new Error("authorize URL not captured yet");
      },
      { timeout: 2000, interval: 10 }
    );
    await waitForPortOpen(Number(TEST_PORT));

    await httpGet(`http://127.0.0.1:${TEST_PORT}/callback?code=whatever&state=forged-state`);
    await expect(flowPromise).rejects.toThrow("State mismatch");
  });

  it("does not reflect an attacker-controlled error param into the callback HTML response", async () => {
    const TEST_PORT = "58237";
    applyEnv({ JOBBER_REDIRECT_PORT: TEST_PORT });
    let capturedAuthUrl = "";
    mockOpen.mockImplementation(async (url: string) => {
      capturedAuthUrl = url;
    });
    vi.stubGlobal("fetch", vi.fn());

    const flowPromise = runOAuthFlow();
    flowPromise.catch(() => {}); // avoid unhandled rejection before the assertion below

    await vi.waitFor(
      () => {
        if (!capturedAuthUrl) throw new Error("authorize URL not captured yet");
      },
      { timeout: 2000, interval: 10 }
    );
    await waitForPortOpen(Number(TEST_PORT));

    const payload = "<script>alert(document.domain)</script>";
    const callbackRes = await httpGet(
      `http://127.0.0.1:${TEST_PORT}/callback?error=${encodeURIComponent(payload)}`
    );
    expect(callbackRes.status).toBe(200);
    expect(callbackRes.body).not.toContain(payload);
    expect(callbackRes.body).not.toContain("<script>");
    expect(callbackRes.body).toMatch(/try authenticating again/i);

    await expect(flowPromise).rejects.toThrow(/OAuth error/);
  });

  it("returns 404 for a request to a path other than /callback, then still completes a real /callback", async () => {
    const TEST_PORT = "58238";
    applyEnv({ JOBBER_REDIRECT_PORT: TEST_PORT });
    let capturedAuthUrl = "";
    mockOpen.mockImplementation(async (url: string) => {
      capturedAuthUrl = url;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const u = String(url);
        if (u.includes("/oauth/token")) {
          return jsonResponse(200, { access_token: "AT-404test", refresh_token: "RT", expires_in: 3600 });
        }
        throw new Error(`Unexpected fetch to ${u}`);
      })
    );

    const flowPromise = runOAuthFlow();

    await vi.waitFor(
      () => {
        if (!capturedAuthUrl) throw new Error("authorize URL not captured yet");
      },
      { timeout: 2000, interval: 10 }
    );
    await waitForPortOpen(Number(TEST_PORT));

    const favRes = await httpGet(`http://127.0.0.1:${TEST_PORT}/favicon.ico`);
    expect(favRes.status).toBe(404);

    const state = new URL(capturedAuthUrl).searchParams.get("state")!;
    const callbackRes = await httpGet(`http://127.0.0.1:${TEST_PORT}/callback?code=xyz&state=${state}`);
    expect(callbackRes.status).toBe(200);

    const tokens = await flowPromise;
    expect(tokens.access_token).toBe("AT-404test");
  });

  it("clears the 5-minute callback timeout once the callback completes successfully", async () => {
    const TEST_PORT = "58239";
    applyEnv({ JOBBER_REDIRECT_PORT: TEST_PORT });
    let capturedAuthUrl = "";
    mockOpen.mockImplementation(async (url: string) => {
      capturedAuthUrl = url;
    });
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: unknown) => {
        const u = String(url);
        if (u.includes("/oauth/token")) {
          return jsonResponse(200, { access_token: "AT-timeout-test", refresh_token: "RT", expires_in: 3600 });
        }
        throw new Error(`Unexpected fetch to ${u}`);
      })
    );
    const clearTimeoutSpy = vi.spyOn(global, "clearTimeout");

    const flowPromise = runOAuthFlow();
    await vi.waitFor(
      () => {
        if (!capturedAuthUrl) throw new Error("authorize URL not captured yet");
      },
      { timeout: 2000, interval: 10 }
    );
    await waitForPortOpen(Number(TEST_PORT));

    const state = new URL(capturedAuthUrl).searchParams.get("state")!;
    await httpGet(`http://127.0.0.1:${TEST_PORT}/callback?code=abc&state=${state}`);
    await flowPromise;

    expect(clearTimeoutSpy).toHaveBeenCalled();
    clearTimeoutSpy.mockRestore();
  });

  it("rejects gracefully instead of crashing the process when the redirect port is already in use", async () => {
    const TEST_PORT = "58237";
    applyEnv({ JOBBER_REDIRECT_PORT: TEST_PORT });

    // Occupy the port first, so runOAuthFlow's own server.listen() hits EADDRINUSE.
    const blocker = net.createServer();
    await new Promise<void>((resolve) => blocker.listen(Number(TEST_PORT), "127.0.0.1", resolve));
    try {
      mockOpen.mockResolvedValue(undefined);
      vi.stubGlobal("fetch", vi.fn());

      await expect(runOAuthFlow()).rejects.toThrow(/JOBBER_REDIRECT_PORT/);
    } finally {
      await new Promise<void>((resolve) => blocker.close(() => resolve()));
    }
  });
});

describe("getValidAccessToken", () => {
  const TEST_PORT = "58235";

  beforeEach(() => {
    applyEnv({ JOBBER_REDIRECT_PORT: TEST_PORT });
  });

  it("runs the full OAuth flow when no tokens are stored", async () => {
    mockLoadTokens.mockResolvedValue(null);

    let capturedAuthUrl = "";
    mockOpen.mockImplementation(async (url: string) => {
      capturedAuthUrl = url;
    });

    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/oauth/token")) {
        return jsonResponse(200, { access_token: "AT-new", refresh_token: "RT-new", expires_in: 3600 });
      }
      throw new Error(`Unexpected fetch to ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const tokenPromise = getValidAccessToken();

    await vi.waitFor(
      () => {
        if (!capturedAuthUrl) throw new Error("authorize URL not captured yet");
      },
      { timeout: 2000, interval: 10 }
    );
    await waitForPortOpen(Number(TEST_PORT));

    const state = new URL(capturedAuthUrl).searchParams.get("state")!;
    await httpGet(`http://127.0.0.1:${TEST_PORT}/callback?code=new-code&state=${state}`);

    const accessToken = await tokenPromise;
    expect(accessToken).toBe("AT-new");
  });

  it("refreshes when the stored token is within 5 minutes of expiry", async () => {
    mockLoadTokens.mockResolvedValue({
      access_token: "AT-old",
      refresh_token: "RT-old",
      expires_at: Date.now() + 60 * 1000, // 1 minute left - inside the 5-minute refresh window
    });

    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/oauth/token")) {
        return jsonResponse(200, { access_token: "AT-refreshed", refresh_token: "RT-refreshed", expires_in: 3600 });
      }
      throw new Error(`Unexpected fetch to ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const accessToken = await getValidAccessToken();
    expect(accessToken).toBe("AT-refreshed");
    expect(mockSaveTokens).toHaveBeenCalledWith(expect.objectContaining({ access_token: "AT-refreshed" }));
  });

  it("refreshes when the stored token is already expired (not just near expiry)", async () => {
    mockLoadTokens.mockResolvedValue({
      access_token: "AT-old",
      refresh_token: "RT-old",
      expires_at: Date.now() - 60 * 60 * 1000, // expired an hour ago
    });

    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/oauth/token")) {
        return jsonResponse(200, { access_token: "AT-refreshed", refresh_token: "RT-refreshed", expires_in: 3600 });
      }
      throw new Error(`Unexpected fetch to ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const accessToken = await getValidAccessToken();
    expect(accessToken).toBe("AT-refreshed");
    expect(mockSaveTokens).toHaveBeenCalledWith(expect.objectContaining({ access_token: "AT-refreshed" }));
  });

  it("does not refresh when the stored token has more than 5 minutes left", async () => {
    mockLoadTokens.mockResolvedValue({
      access_token: "AT-fresh",
      refresh_token: "RT-fresh",
      expires_at: Date.now() + 60 * 60 * 1000,
    });
    const fetchMock = vi.fn(async (url: unknown) => {
      throw new Error(`Unexpected fetch to ${String(url)} - should not refresh a fresh token`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const accessToken = await getValidAccessToken();
    expect(accessToken).toBe("AT-fresh");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("coalesces concurrent callers into a single in-flight refresh", async () => {
    mockLoadTokens.mockResolvedValue({
      access_token: "AT-old",
      refresh_token: "RT-old",
      expires_at: Date.now() + 60 * 1000,
    });

    let tokenCalls = 0;
    const fetchMock = vi.fn(async (url: unknown) => {
      const u = String(url);
      if (u.includes("/oauth/token")) {
        tokenCalls++;
        return jsonResponse(200, { access_token: "AT-refreshed", refresh_token: "RT-refreshed", expires_in: 3600 });
      }
      throw new Error(`Unexpected fetch to ${u}`);
    });
    vi.stubGlobal("fetch", fetchMock);

    const [a, b] = await Promise.all([getValidAccessToken(), getValidAccessToken()]);
    expect(a).toBe("AT-refreshed");
    expect(b).toBe("AT-refreshed");
    expect(tokenCalls).toBe(1);
  });
});
