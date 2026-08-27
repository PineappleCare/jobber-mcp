import http from "http";
import crypto from "crypto";
import { z } from "zod";
import { saveTokens, loadTokens, withTokenLock } from "./tokenStorage.js";

function getAuthUrl() {
  return process.env.JOBBER_AUTH_URL ?? "https://api.getjobber.com/api/oauth/authorize";
}
function getTokenUrl() {
  return process.env.JOBBER_TOKEN_URL ?? "https://api.getjobber.com/api/oauth/token";
}
function getGraphqlUrl() {
  return process.env.JOBBER_GRAPHQL_URL ?? "https://api.getjobber.com/api/graphql";
}
const JOBBER_GRAPHQL_VERSION = process.env.JOBBER_GRAPHQL_VERSION ?? "2025-04-16";

export interface JobberTokens {
  access_token: string;
  refresh_token: string;
  expires_at: number; // Unix timestamp (ms)
  account_id?: string;
}

// A missing/non-numeric expires_in previously produced expires_at: NaN, which silently disabled
// refresh forever (Date.now() > NaN - 300000 is always false). Validate the shape Jobber promises
// instead of trusting `as any`.
const TokenResponseSchema = z.object({
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().positive(),
});

function parseTokenResponse(data: unknown): z.infer<typeof TokenResponseSchema> {
  const parsed = TokenResponseSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`Jobber's token response was missing or had an invalid field: ${parsed.error.message}`);
  }
  return parsed.data;
}

function generatePkce(): { codeVerifier: string; codeChallenge: string } {
  const codeVerifier = crypto.randomBytes(32).toString("base64url");
  const codeChallenge = crypto.createHash("sha256").update(codeVerifier).digest("base64url");
  return { codeVerifier, codeChallenge };
}

export async function runOAuthFlow(): Promise<JobberTokens> {
  const clientId = (process.env.JOBBER_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.JOBBER_CLIENT_SECRET ?? "").trim();
  const port = (process.env.JOBBER_REDIRECT_PORT || "5679").trim();
  const redirectUri = `http://127.0.0.1:${port}/callback`;

  const state = crypto.randomBytes(16).toString("hex");
  const { codeVerifier, codeChallenge } = generatePkce();

  const authUrl =
    `${getAuthUrl()}?` +
    new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });

  const { default: open } = await import("open");
  await open(authUrl);
  console.error(`[auth] Please complete the login in your browser...`);

  const code = await waitForCallback(port, state);

  const tokens = await exchangeCodeForTokens(code, clientId, clientSecret, redirectUri, codeVerifier);

  await saveTokens(tokens);
  console.error(`[auth] ✅ Authentication successful, tokens saved.`);
  return tokens;
}

function waitForCallback(port: string, expectedState: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url!, `http://127.0.0.1:${port}`);

      if (url.pathname !== "/callback") {
        res.writeHead(404);
        res.end();
        return;
      }

      const code = url.searchParams.get("code");
      const state = url.searchParams.get("state");
      const error = url.searchParams.get("error");

      res.writeHead(200, { "Content-Type": "text/html" });

      if (error || !code) {
        console.error(`[auth] OAuth callback returned an error: ${error || "no code received"}`);
        res.end(`<h1>Authentication Failed</h1><p>Please try authenticating again. You can close this tab.</p>`);
        server.close();
        clearTimeout(timeoutHandle);
        reject(new Error(`OAuth error: ${error || "no code received"}`));
        return;
      }

      // Constant-time comparison to prevent timing attacks
      const expectedBuf = Buffer.from(expectedState, "utf8");
      const actualBuf = Buffer.from(state ?? "", "utf8");
      const stateValid =
        expectedBuf.length === actualBuf.length && crypto.timingSafeEqual(expectedBuf, actualBuf);

      if (!stateValid) {
        res.end(`<h1>Error: Invalid state parameter</h1>`);
        server.close();
        clearTimeout(timeoutHandle);
        reject(new Error("State mismatch - possible CSRF attack?"));
        return;
      }

      res.end(`<h1>Authentication successful!</h1><p>You can close this tab and continue in Claude.</p>`);
      server.close();
      clearTimeout(timeoutHandle);
      resolve(code);
    });

    server.on("error", (err: NodeJS.ErrnoException) => {
      reject(
        new Error(
          `Failed to start local OAuth callback server on port ${port}: ${err.message}. ` +
          `Set JOBBER_REDIRECT_PORT to a free port and try again.`
        )
      );
    });

    server.listen(parseInt(port), "127.0.0.1", () => {
      console.error(`[auth] Waiting for callback on http://127.0.0.1:${port}/callback`);
    });

    const timeoutHandle = setTimeout(() => {
      server.close();
      reject(new Error("OAuth timeout - no response received within 5 minutes"));
    }, 5 * 60 * 1000).unref();
  });
}

async function exchangeCodeForTokens(
  code: string,
  clientId: string,
  clientSecret: string,
  redirectUri: string,
  codeVerifier?: string
): Promise<JobberTokens> {
  const tokenUrl = getTokenUrl();

  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    client_id: clientId,
    client_secret: clientSecret,
    redirect_uri: redirectUri,
    ...(codeVerifier ? { code_verifier: codeVerifier } : {}),
  });

  const res = await fetch(tokenUrl, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(
      `Token exchange failed.\n` +
      `  Token URL  : ${tokenUrl}\n` +
      `  Redirect   : ${redirectUri}\n` +
      `  client_id  : ${clientId.substring(0, 6)}... (length ${clientId.length})\n` +
      `  Response   : ${err}\n` +
      `\nIf the error is "invalid_client": verify JOBBER_CLIENT_ID and JOBBER_CLIENT_SECRET match your Jobber developer app exactly.`
    );
  }

  const data = parseTokenResponse(await res.json());

  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token!,
    expires_at: Date.now() + data.expires_in * 1000,
  };
}

export function buildAuthorizationUrl(
  sessionId: string
): { url: string; nonce: string; codeVerifier: string; state: string } {
  const clientId = (process.env.JOBBER_CLIENT_ID ?? "").trim();
  const baseUrl = (process.env.MCP_BASE_URL ?? "").trim();
  const redirectUri = `${baseUrl}/oauth/callback`;
  const nonce = crypto.randomBytes(16).toString("hex");
  const state = Buffer.from(`${sessionId}:${nonce}`).toString("base64url");
  const { codeVerifier, codeChallenge } = generatePkce();
  const url =
    `${getAuthUrl()}?` +
    new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      state,
      code_challenge: codeChallenge,
      code_challenge_method: "S256",
    });
  return { url, nonce, codeVerifier, state };
}

export async function exchangeCodeForTokensPure(
  code: string,
  redirectUri: string,
  codeVerifier?: string
): Promise<JobberTokens> {
  const clientId = (process.env.JOBBER_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.JOBBER_CLIENT_SECRET ?? "").trim();
  return exchangeCodeForTokens(code, clientId, clientSecret, redirectUri, codeVerifier);
}

// Jobber has no REST OAuth revoke endpoint - disconnecting an app is done via the appDisconnect
// GraphQL mutation, authenticated with the token being revoked (same pattern as every other
// Jobber GraphQL call). Best-effort: `logout` must always clear local tokens regardless of what
// happens here. Never throws.
const APP_DISCONNECT_MUTATION = `mutation { appDisconnect { app { id } } }`;

export async function revokeToken(token: string): Promise<void> {
  try {
    const res = await fetch(getGraphqlUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-JOBBER-GRAPHQL-VERSION": JOBBER_GRAPHQL_VERSION,
      },
      body: JSON.stringify({ query: APP_DISCONNECT_MUTATION }),
    });

    if (!res.ok) {
      const err = await res.text();
      console.error(
        `[auth] Token revocation at Jobber failed (HTTP ${res.status}): ${err}; tokens cleared locally regardless.`
      );
      return;
    }

    const body = await res.json();
    if (Array.isArray(body?.errors) && body.errors.length > 0) {
      const message = body.errors.map((e: any) => e.message).join("; ");
      console.error(`[auth] Token revocation at Jobber failed (${message}); tokens cleared locally regardless.`);
    }
  } catch (err: any) {
    console.error(`[auth] Token revocation at Jobber failed (${err.message}); tokens cleared locally regardless.`);
  }
}

export async function refreshTokensPure(refreshToken: string): Promise<JobberTokens> {
  const clientId = (process.env.JOBBER_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.JOBBER_CLIENT_SECRET ?? "").trim();

  const res = await fetch(getTokenUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    throw new Error("Token refresh failed, please re-authenticate.");
  }

  const data = parseTokenResponse(await res.json());
  return {
    access_token: data.access_token,
    refresh_token: data.refresh_token || refreshToken,
    expires_at: Date.now() + data.expires_in * 1000,
  };
}

let inFlightAccessToken: Promise<string> | null = null;

// Concurrent callers await the same in-flight refresh instead of racing -
// otherwise two overlapping calls can both refresh, and if Jobber rotates
// the refresh token on use, the loser's saveTokens() can stomp the winner's
// and discard the only valid refresh token.
export async function getValidAccessToken(): Promise<string> {
  if (inFlightAccessToken) return inFlightAccessToken;
  inFlightAccessToken = doGetValidAccessToken();
  try {
    return await inFlightAccessToken;
  } finally {
    inFlightAccessToken = null;
  }
}

function needsRefresh(tokens: JobberTokens): boolean {
  return Date.now() > tokens.expires_at - 5 * 60 * 1000;
}

async function doGetValidAccessToken(): Promise<string> {
  const tokens = await loadTokens();

  if (!tokens) {
    const fresh = await runOAuthFlow();
    return fresh.access_token;
  }

  if (!needsRefresh(tokens)) {
    return tokens.access_token;
  }

  // Cross-process coordination: two OS processes can share tokens.enc. Re-read inside the lock
  // rather than trusting `tokens` captured above - another process may have already refreshed and
  // saved fresh tokens while this one was waiting for the lock, in which case reuse those instead
  // of refreshing again with a now-stale (and possibly already-rotated) refresh token.
  return withTokenLock(async () => {
    const latest = (await loadTokens()) ?? tokens;
    if (!needsRefresh(latest)) {
      return latest.access_token;
    }
    console.error("[auth] Token expiring soon, refreshing...");
    const refreshed = await refreshAccessToken(latest);
    return refreshed.access_token;
  });
}

async function refreshAccessToken(tokens: JobberTokens): Promise<JobberTokens> {
  const clientId = (process.env.JOBBER_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.JOBBER_CLIENT_SECRET ?? "").trim();

  const res = await fetch(getTokenUrl(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: tokens.refresh_token,
      client_id: clientId,
      client_secret: clientSecret,
    }),
  });

  if (!res.ok) {
    throw new Error("Token refresh failed, please log in again.");
  }

  const data = parseTokenResponse(await res.json());
  const newTokens: JobberTokens = {
    access_token: data.access_token,
    refresh_token: data.refresh_token || tokens.refresh_token,
    expires_at: Date.now() + data.expires_in * 1000,
    account_id: tokens.account_id,
  };

  await saveTokens(newTokens);
  return newTokens;
}
