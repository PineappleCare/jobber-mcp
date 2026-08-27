import { AsyncLocalStorage } from "async_hooks";
import type { JobberTokens } from "../auth/oauth.js";

export interface SessionContext {
  sessionId: string;
  getAccessToken(): Promise<string>;
  storeTokens(tokens: JobberTokens): void;
  getTokens(): JobberTokens | null;
  clearTokens(): void;
  setPendingNonce(nonce: string): void;
  setPendingCodeVerifier(codeVerifier: string): void;
  setPendingAuthorizeUrl(url: string): void;
  // Jobber account id, used to key the CostGovernor so two sessions on the same account share one
  // real budget (see resolveAccountId() in jobber/client.ts). `undefined` = not yet attempted;
  // `null` = attempted once and failed/unavailable, so this session falls back to a per-session
  // governor for its lifetime; a string = resolved.
  getAccountId(): string | null | undefined;
  setAccountId(accountId: string | null): void;
}

export const sessionStorage = new AsyncLocalStorage<SessionContext>();

export function getSessionContext(): SessionContext | undefined {
  return sessionStorage.getStore();
}

export function isStdioMode(): boolean {
  return (process.env.TRANSPORT ?? "stdio").toLowerCase() === "stdio";
}

// Fail-closed variant of getSessionContext(): in HTTP mode a missing context
// means some code path forgot to run inside sessionStorage.run(...), and
// silently falling back to the shared single-user token file would leak one
// session's Jobber identity into another's request. Only stdio mode (which
// never establishes a session context) is allowed to return null.
export function requireSessionContext(): SessionContext | null {
  const ctx = getSessionContext();
  if (!ctx && !isStdioMode()) {
    throw new Error(
      "Internal error: missing session context while running in HTTP mode. Refusing to fall back to shared token storage."
    );
  }
  return ctx ?? null;
}
