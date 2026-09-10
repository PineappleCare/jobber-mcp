import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { setCookie, getCookie, deleteCookie } from "hono/cookie";
import { readFileSync } from "fs";
import { randomUUID, timingSafeEqual, createHash } from "crypto";
import { McpServer, WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/server";
import { registerAllTools } from "../registerAllTools.js";
import { exchangeCodeForTokensPure, refreshTokensPure } from "../auth/oauth.js";
import type { JobberTokens } from "../auth/oauth.js";
import { sessionStorage } from "../utils/sessionContext.js";
import type { SessionContext } from "../utils/sessionContext.js";
import { appendAuditLog } from "../utils/auditLog.js";
import { clearGovernorForSession } from "../jobber/client.js";
import { clearTokens, loadTokens, saveTokens, withTokenLock } from "../auth/tokenStorage.js";

const pkg = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));

const OAUTH_NONCE_COOKIE = "oauth_nonce";
const OAUTH_COOKIE_MAX_AGE_SECONDS = 300; // matches the stdio flow's 5-minute callback timeout

export interface SessionRecord {
  transport: WebStandardStreamableHTTPServerTransport;
  mcpServer: McpServer | null;
  tokens: JobberTokens | null;
  pendingOAuthNonce: string | null;
  pendingCodeVerifier: string | null;
  pendingAuthorizeUrl: string | null;
  createdAt: number;
  lastActivityAt: number;
  apiKeyHash: string;
  refreshInFlight: Promise<string> | null;
  // See SessionContext.getAccountId() in utils/sessionContext.ts for the tri-state meaning.
  accountId: string | null | undefined;
}

export const sessions = new Map<string, SessionRecord>();

function createMcpServer(): McpServer {
  const server = new McpServer({ name: "jobber-mcp", version: pkg.version });
  registerAllTools(server);
  return server;
}

async function doGetAccessToken(record: SessionRecord): Promise<string> {
  if (!record.tokens) {
    record.tokens = await loadTokens();
    if (!record.tokens) {
      throw new Error(
        "Not authenticated. Call the 'authenticate' tool to get a login URL, complete OAuth in your browser, then try again."
      );
    }
  }
  if (Date.now() > record.tokens.expires_at - 5 * 60 * 1000) {
    record.tokens = await withTokenLock(async () => {
      const persisted = (await loadTokens()) ?? record.tokens!;
      if (Date.now() <= persisted.expires_at - 5 * 60 * 1000) return persisted;
      const refreshed = await refreshTokensPure(persisted.refresh_token);
      const durable = { ...refreshed, account_id: persisted.account_id };
      await saveTokens(durable);
      return durable;
    });
  }
  return record.tokens.access_token;
}

export function buildSessionContext(record: SessionRecord, sessionId: string): SessionContext {
  return {
    sessionId,
    // Concurrent calls within the same session await the same in-flight
    // refresh instead of racing (see getValidAccessToken in oauth.ts for the
    // same pattern in stdio mode).
    getAccessToken: async () => {
      if (record.refreshInFlight) return record.refreshInFlight;
      record.refreshInFlight = doGetAccessToken(record);
      try {
        return await record.refreshInFlight;
      } finally {
        record.refreshInFlight = null;
      }
    },
    storeTokens: async (tokens: JobberTokens) => { record.tokens = tokens; await saveTokens(tokens); },
    getTokens: () => record.tokens,
    clearTokens: async () => { record.tokens = null; await clearTokens(); },
    setPendingNonce: (nonce: string) => { record.pendingOAuthNonce = nonce; },
    setPendingCodeVerifier: (codeVerifier: string) => { record.pendingCodeVerifier = codeVerifier; },
    setPendingAuthorizeUrl: (url: string) => { record.pendingAuthorizeUrl = url; },
    getAccountId: () => record.accountId,
    setAccountId: (accountId: string | null) => { record.accountId = accountId; },
  };
}

// Only a hash of the API key is bound to a session (see hashPresentedApiKey below) - this doesn't
// give per-tenant isolation, since MCP_API_KEY is a single shared secret today, not a per-caller
// credential. What it does buy: a leaked mcp-session-id alone (e.g. from a proxy access log) can't
// be replayed into a live session without also presenting a valid API key.
const SESSION_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const SESSION_ABSOLUTE_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** Exported for tests: sweeps sessions idle >30min or older than the 24h absolute cap. */
export function sweepStaleSessions(): void {
  const now = Date.now();
  for (const [id, rec] of sessions) {
    if (now - rec.createdAt > SESSION_ABSOLUTE_TIMEOUT_MS || now - rec.lastActivityAt > SESSION_IDLE_TIMEOUT_MS) {
      rec.transport.close().catch(() => {});
      sessions.delete(id);
      clearGovernorForSession(id, rec.accountId);
    }
  }
}

// Runs every 5 minutes so idle sessions are reaped close to the 30-minute mark, not up to an hour late.
setInterval(sweepStaleSessions, 5 * 60 * 1000).unref();

/**
 * DNS-rebinding / cross-origin protection for the externally-reachable endpoints. The SDK's own
 * `enableDnsRebindingProtection`/`allowedHosts`/`allowedOrigins` transport options are marked
 * deprecated in favor of external middleware, which is what this is. Computed per-request (not
 * memoized at module load) so it reflects the current MCP_BASE_URL/MCP_ALLOWED_ORIGINS env vars -
 * relevant for tests, and cheap regardless.
 */
function isAllowedHostAndOrigin(req: Request): boolean {
  const baseUrl = (process.env.MCP_BASE_URL ?? "").trim();
  if (!baseUrl) return true; // no base URL configured - nothing to allowlist against

  let allowedHost: string;
  let allowedOrigin: string;
  try {
    const parsed = new URL(baseUrl);
    allowedHost = parsed.host;
    allowedOrigin = parsed.origin;
  } catch {
    return true; // malformed MCP_BASE_URL is a separate config problem, not this middleware's job
  }

  const extraOrigins = (process.env.MCP_ALLOWED_ORIGINS ?? "")
    .split(",")
    .map((o) => o.trim())
    .filter(Boolean);
  const allowedOrigins = new Set([allowedOrigin, ...extraOrigins]);

  const hostHeader = req.headers.get("host");
  if (hostHeader && hostHeader !== allowedHost) return false;

  const originHeader = req.headers.get("origin");
  if (originHeader && !allowedOrigins.has(originHeader)) return false;

  return true;
}

// Hashes whatever Authorization header was presented (including when MCP_API_KEY auth is
// disabled and the header is absent/irrelevant) so a session can be bound to "the credential
// that created it" without storing the raw key.
function hashPresentedApiKey(req: Request): string {
  const auth = req.headers.get("authorization") ?? "";
  return createHash("sha256").update(auth).digest("hex");
}

function requireApiKey(req: Request): Response | null {
  const key = process.env.MCP_API_KEY;
  if (!key) return null;
  const auth = req.headers.get("authorization") ?? "";
  const expectedBuf = Buffer.from(`Bearer ${key}`, "utf8");
  const actualBuf = Buffer.from(auth, "utf8");
  const authValid =
    expectedBuf.length === actualBuf.length && timingSafeEqual(expectedBuf, actualBuf);
  if (!authValid) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  return null;
}

export const app = new Hono();

app.get("/health", (c) => c.json({ ok: true }));

app.use("/mcp", async (c, next) => {
  if (!isAllowedHostAndOrigin(c.req.raw)) {
    return c.json({ error: "Forbidden - Host/Origin not allowed" }, 403);
  }
  await next();
});
app.use("/oauth/start", async (c, next) => {
  if (!isAllowedHostAndOrigin(c.req.raw)) {
    return c.json({ error: "Forbidden - Host/Origin not allowed" }, 403);
  }
  await next();
});
app.use("/oauth/callback", async (c, next) => {
  if (!isAllowedHostAndOrigin(c.req.raw)) {
    return c.json({ error: "Forbidden - Host/Origin not allowed" }, 403);
  }
  await next();
});

app.all("/mcp", async (c) => {
  const unauthorized = requireApiKey(c.req.raw);
  if (unauthorized) return unauthorized;

  try {
    const incomingSessionId = c.req.header("mcp-session-id");

    if (!incomingSessionId) {
      // New connection: allocate record and create transport
      const now = Date.now();
      const record: SessionRecord = {
        transport: null as unknown as WebStandardStreamableHTTPServerTransport,
        mcpServer: null,
        tokens: null,
        pendingOAuthNonce: null,
        pendingCodeVerifier: null,
        pendingAuthorizeUrl: null,
        createdAt: now,
        lastActivityAt: now,
        apiKeyHash: hashPresentedApiKey(c.req.raw),
        refreshInFlight: null,
        accountId: undefined,
      };

      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
        onsessioninitialized: async (sessionId) => {
          record.tokens = await loadTokens();
          record.accountId = record.tokens?.account_id;
          record.mcpServer = createMcpServer();
          sessions.set(sessionId, record);
          await record.mcpServer.connect(transport);
        },
        onsessionclosed: (sessionId) => {
          const accountId = sessions.get(sessionId)?.accountId;
          sessions.delete(sessionId);
          clearGovernorForSession(sessionId, accountId);
        },
      });
      record.transport = transport;

      // Placeholder context for the initialize request - no tools run
      // during initialization, so getAccessToken is never called.
      const tempCtx: SessionContext = {
        sessionId: "",
        getAccessToken: async () => { throw new Error("Not authenticated"); },
        storeTokens: () => {},
        getTokens: () => null,
        clearTokens: () => {},
        setPendingNonce: () => {},
        setPendingCodeVerifier: () => {},
        setPendingAuthorizeUrl: () => {},
        getAccountId: () => null,
        setAccountId: () => {},
      };

      return await sessionStorage.run(tempCtx, () => transport.handleRequest(c.req.raw));
    }

    // Existing session: route to its transport. A session id alone isn't enough - the caller must
    // also present the same API key that created it (see hashPresentedApiKey above), so a leaked
    // session id can't be replayed on its own. Reject with the same 404 as an unknown session so
    // neither response distinguishes "no such session" from "wrong key for this session".
    const record = sessions.get(incomingSessionId);
    if (!record || !constantTimeEqual(record.apiKeyHash, hashPresentedApiKey(c.req.raw))) {
      return c.json({ error: "Session not found" }, 404);
    }
    record.lastActivityAt = Date.now();
    const ctx = buildSessionContext(record, incomingSessionId);
    return await sessionStorage.run(ctx, () => record.transport.handleRequest(c.req.raw));
  } catch (err: any) {
    console.error("[http] /mcp error:", err.message);
    return c.json({ error: "Internal server error" }, 500);
  }
});

function decodeState(state: string): { sessionId: string; nonce: string } | null {
  try {
    const payload = Buffer.from(state, "base64url").toString("utf8");
    const colonIdx = payload.indexOf(":");
    if (colonIdx < 0) return null;
    return { sessionId: payload.slice(0, colonIdx), nonce: payload.slice(colonIdx + 1) };
  } catch {
    return null;
  }
}

function constantTimeEqual(a: string, b: string): boolean {
  const aBuf = Buffer.from(a, "utf8");
  const bBuf = Buffer.from(b, "utf8");
  return aBuf.length === bBuf.length && timingSafeEqual(aBuf, bBuf);
}

// The browser's first touch of this server in the HTTP OAuth flow: the `authenticate` tool points
// here (not directly at Jobber) so this handler can plant an HttpOnly binding cookie before ever
// redirecting to Jobber. /oauth/callback later requires that cookie to match, in addition to the
// existing state-embedded nonce - closing the login-CSRF gap where an attacker with their own
// valid code/state pair could otherwise complete the callback against a victim's session.
app.get("/oauth/start", (c) => {
  const state = c.req.query("state");
  if (!state) {
    return c.html("<h1>Bad Request</h1><p>Missing state parameter.</p>", 400);
  }

  const decoded = decodeState(state);
  if (!decoded) {
    return c.html("<h1>Bad Request</h1><p>Invalid state parameter.</p>", 400);
  }

  const record = sessions.get(decoded.sessionId);
  if (!record || !record.pendingOAuthNonce || !record.pendingAuthorizeUrl) {
    return c.html("<h1>Session Not Found</h1><p>Unknown or expired session. Please try again.</p>", 400);
  }
  if (!constantTimeEqual(record.pendingOAuthNonce, decoded.nonce)) {
    return c.html("<h1>Invalid State</h1><p>State mismatch - possible CSRF attack.</p>", 400);
  }

  setCookie(c, OAUTH_NONCE_COOKIE, record.pendingOAuthNonce, {
    httpOnly: true,
    sameSite: "Lax",
    secure: (process.env.MCP_BASE_URL ?? "").trim().startsWith("https://"),
    maxAge: OAUTH_COOKIE_MAX_AGE_SECONDS,
    path: "/oauth/callback",
  });

  return c.redirect(record.pendingAuthorizeUrl, 302);
});

app.get("/oauth/callback", async (c) => {
  const code = c.req.query("code");
  const state = c.req.query("state");
  const oauthError = c.req.query("error");

  if (oauthError) {
    console.error("[http] OAuth callback returned an error:", oauthError);
    return c.html("<h1>Authentication Error</h1><p>The identity provider returned an error. Please try authenticating again.</p>", 400);
  }
  if (!code || !state) {
    return c.html("<h1>Bad Request</h1><p>Missing code or state parameter.</p>", 400);
  }

  const decoded = decodeState(state);
  if (!decoded) {
    return c.html("<h1>Bad Request</h1><p>Invalid state parameter.</p>", 400);
  }
  const { sessionId, nonce } = decoded;

  const record = sessions.get(sessionId);
  if (!record || !record.pendingOAuthNonce) {
    return c.html("<h1>Session Not Found</h1><p>Unknown or expired session. Please try again.</p>", 400);
  }

  const cookieNonce = getCookie(c, OAUTH_NONCE_COOKIE);
  deleteCookie(c, OAUTH_NONCE_COOKIE, { path: "/oauth/callback" });

  // Both the state-embedded nonce and the cookie planted by /oauth/start must match the session's
  // stored nonce - the former proves the callback carries a value this server generated, the
  // latter proves the browser completing it is the same one /oauth/start redirected.
  const nonceValid = constantTimeEqual(record.pendingOAuthNonce, nonce);
  const cookieValid = cookieNonce !== undefined && constantTimeEqual(record.pendingOAuthNonce, cookieNonce);

  if (!nonceValid || !cookieValid) {
    return c.html("<h1>Invalid State</h1><p>State mismatch - possible CSRF attack.</p>", 400);
  }

  record.pendingOAuthNonce = null;
  record.pendingAuthorizeUrl = null;
  const codeVerifier = record.pendingCodeVerifier ?? undefined;
  record.pendingCodeVerifier = null;

  try {
    const redirectUri = `${(process.env.MCP_BASE_URL ?? "").trim()}/oauth/callback`;
    const tokens = await exchangeCodeForTokensPure(code, redirectUri, codeVerifier);
    record.tokens = tokens;
    await saveTokens(tokens);

    const ctx = buildSessionContext(record, sessionId);
    await sessionStorage.run(ctx, () =>
      appendAuditLog({ tool: "oauth_callback", args: {}, outcome: "success", account_id: tokens.account_id })
    );

    return c.html(
      `<!DOCTYPE html><html><head><title>Authentication Successful</title></head>` +
      `<body><h1>✅ Authentication Successful</h1>` +
      `<p>You are now connected to Jobber. You can close this tab and return to Claude.</p>` +
      `</body></html>`
    );
  } catch (err: any) {
    console.error("[http] OAuth callback error:", err.message);
    return c.html(
      "<h1>Authentication Failed</h1><p>Please try authenticating again, or contact the account owner if this persists.</p>",
      500
    );
  }
});

export function startHttpServer(): void {
  const port = parseInt(process.env.PORT ?? "3000", 10);
  serve({ fetch: app.fetch, port }, () => {
    const baseUrl = (process.env.MCP_BASE_URL ?? `http://127.0.0.1:${port}`).trim();
    console.error(`[http] Jobber MCP server listening on port ${port}`);
    console.error(`[http] MCP endpoint : ${baseUrl}/mcp`);
    console.error(`[http] Health check : ${baseUrl}/health`);
  });
}
