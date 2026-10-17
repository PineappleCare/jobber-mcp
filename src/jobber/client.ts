import { getValidAccessToken } from "../auth/oauth.js";
import { requireSessionContext } from "../utils/sessionContext.js";
import type { SessionContext } from "../utils/sessionContext.js";
import { BudgetUnavailableError, CostGovernor, type AdmissionControl } from "./cost-governor.js";
import { ACCOUNT_ID_QUERY } from "./queries.js";
import {
  JobberApiError,
  JobberAuthenticationError,
  JobberGraphQLRequestError,
  JobberOutcomeUncertainError,
  JobberPermissionError,
} from "./errors.js";

export {
  JobberApiError,
  JobberAuthenticationError,
  JobberGraphQLRequestError,
  JobberOutcomeUncertainError,
  JobberPermissionError,
} from "./errors.js";

export const JOBBER_GRAPHQL_VERSION = process.env.JOBBER_GRAPHQL_VERSION ?? "2025-04-16";

function getGraphqlUrl(): string {
  return process.env.JOBBER_GRAPHQL_URL ?? "https://api.getjobber.com/api/graphql";
}

const MAX_THROTTLE_RETRIES = 1;
const MAX_429_RETRIES = 3;
const DEFAULT_429_BACKOFF_MS = [1000, 2000, 4000];
const MAX_READ_ATTEMPTS = 4;
const REQUEST_TIMEOUT_MS = 30_000;
// Staff tools preserve partial mutation data. Voice recovery must distinguish
// native validation errors from top-level execution errors merged into that data.
const mutationExecutionFailures = new WeakSet<object>();
export function hasMutationExecutionErrors(data: unknown): boolean {
  return data !== null && typeof data === "object" && mutationExecutionFailures.has(data);
}
const MAX_5XX_RETRIES = 2;
const FIVE_XX_BACKOFF_MS = [1000, 2000];

let stdioGovernor = new CostGovernor();

// Per-session governors, used for a session until (and unless) its Jobber account id is
// resolved - see accountGovernors below for the account-keyed governors that supersede these
// once resolution succeeds.
const sessionGovernors = new Map<string, CostGovernor>();

// Two HTTP sessions authenticated against the same Jobber account are meant to share one real
// budget, since Jobber meters per app+account, not per MCP session. Ref-counted by session id so
// closing one session on a shared account doesn't wipe the budget state a sibling session still
// open on that account is relying on.
const accountGovernors = new Map<string, { governor: CostGovernor; sessionIds: Set<string> }>();
const accountResolutionInFlight = new Map<string, Promise<string | null>>();
const accountResolutionRetryAt = new Map<string, number>();

/** Exposed for tests: lets a test prime a session's (pre-account-resolution) budget before calling jobberGraphQL. */
export function getGovernorForSession(sessionId: string | undefined): CostGovernor {
  if (sessionId === undefined) return stdioGovernor;
  let governor = sessionGovernors.get(sessionId);
  if (!governor) {
    governor = new CostGovernor();
    sessionGovernors.set(sessionId, governor);
  }
  return governor;
}

/** Exposed for tests: inspects the shared governor for an account id, if one has been created. */
export function getGovernorForAccount(accountId: string): CostGovernor | undefined {
  return accountGovernors.get(accountId)?.governor;
}

function getSharedAccountGovernor(accountId: string, sessionId: string, seed?: CostGovernor): CostGovernor {
  let entry = accountGovernors.get(accountId);
  if (!entry) {
    const governor = new CostGovernor();
    if (seed) governor.seedFrom(seed);
    entry = { governor, sessionIds: new Set() };
    accountGovernors.set(accountId, entry);
  }
  entry.sessionIds.add(sessionId);
  return entry.governor;
}

const ACCOUNT_ID_QUERY_COST = 1; // deliberately the cheapest possible query - see queries.ts

/**
 * Resolves the Jobber account id for a session so its governor can be shared with any other
 * session on the same account, instead of each session assuming it owns the account's full
 * budget. Resolution failures are reported as unresolved (null); callers then fail closed until
 * the shared account budget can be identified instead of dispatching on an isolated estimate.
 */
async function resolveAccountId(ctx: SessionContext, control: AdmissionControl): Promise<string | null> {
  let admission: number | undefined;
  const governor = getGovernorForSession(ctx.sessionId);
  try {
    const token = await ctx.getAccessToken();
    const tokenAccountId = ctx.getTokens()?.account_id;
    if (tokenAccountId) return tokenAccountId;
    admission = await governor.admit(ACCOUNT_ID_QUERY_COST, control);
    try {
      const { status, body, retryAfterHeader } = await postOnce(token, ACCOUNT_ID_QUERY, undefined, control);
      governor.settleAdmission(admission);
      if (body?.extensions?.cost) {
        governor.recordCost(body.extensions.cost);
      } else if (status === 429 || isThrottled(body)) {
        governor.assumeDepleted();
        governor.deferUntil(retryAfterAt(retryAfterHeader));
      }
      const id = body?.data?.account?.id;
      if (status === 429 || isThrottled(body)) accountResolutionRetryAt.set(ctx.sessionId, governor.getCooldownUntil());
      return status === 200 && typeof id === "string" && id.length > 0 ? id : null;
    } catch (error) {
      governor.settleAdmission(admission);
      throw error;
    }
  } catch (err: any) {
    accountResolutionRetryAt.set(ctx.sessionId, Math.max(Date.now() + 1000, Number(err?.retryAt) || 0));
    console.error(
      "[jobber] Could not resolve account id for cost-governor sharing; this session will budget independently:",
      err?.message ?? err
    );
    return null;
  }
}

/** Picks (and, on a session's first call, resolves/caches) the governor to use for a request. */
async function getGovernorForContext(ctx: SessionContext | null, control: AdmissionControl): Promise<CostGovernor> {
  // "" is the http.ts initialize-request placeholder sessionId, never a real one - treat it as
  // absent (falsy `||`, not `??`) so it doesn't allocate a bogus session-keyed governor.
  const sessionId = ctx?.sessionId || undefined;
  if (ctx === null || sessionId === undefined) return stdioGovernor;

  let accountId = ctx.getAccountId();
  if (!accountId) {
    // Tokens are issued by Jobber and carry the verified account identity. Load/refresh
    // them before falling back to the inexpensive account query.
    await ctx.getAccessToken();
    accountId = ctx.getAccountId() ?? ctx.getTokens()?.account_id;
  }
  if (accountId) {
    accountResolutionRetryAt.delete(sessionId);
    ctx.setAccountId(accountId);
    return getSharedAccountGovernor(accountId, sessionId, getGovernorForSession(sessionId));
  }
  if (!accountId) {
    const blockedUntil = accountResolutionRetryAt.get(sessionId) || 0;
    if (blockedUntil > Date.now()) throw new BudgetUnavailableError(Math.ceil((blockedUntil - Date.now()) / 1000), blockedUntil, "account_budget_unavailable");
    let pending = accountResolutionInFlight.get(sessionId);
    if (!pending) {
      pending = resolveAccountId(ctx, control).finally(() => accountResolutionInFlight.delete(sessionId));
      accountResolutionInFlight.set(sessionId, pending);
    }
    accountId = await pending;
    if (accountId) ctx.setAccountId(accountId);
  }
  if (!accountId) {
    const now = Date.now();
    const retryAt = Math.max(now + 1000, accountResolutionRetryAt.get(sessionId) || 0);
    accountResolutionRetryAt.set(sessionId, retryAt);
    const reasonCode = retryAt > now + 1000 ? "provider_throttled" : "account_budget_unavailable";
    throw new BudgetUnavailableError(Math.ceil((retryAt - now) / 1000), retryAt, reasonCode);
  }
  return getSharedAccountGovernor(accountId, sessionId, getGovernorForSession(sessionId));
}

/**
 * Called by the HTTP transport when a session closes, to avoid an unbounded Map. Pass the
 * session's resolved account id (if any) so a still-open sibling session on the same account
 * keeps its shared governor instead of losing it the moment any one session on that account closes.
 */
export function clearGovernorForSession(sessionId: string, accountId?: string | null): void {
  sessionGovernors.delete(sessionId);
  if (accountId) {
    const entry = accountGovernors.get(accountId);
    if (entry) {
      entry.sessionIds.delete(sessionId);
      if (entry.sessionIds.size === 0) accountGovernors.delete(accountId);
    }
  }
}

/** Exposed for tests: resets the shared stdio-mode governor so budget state doesn't leak across tests. */
export function resetStdioGovernorForTests(): void {
  stdioGovernor = new CostGovernor();
}

async function resolveAccessToken(ctx: SessionContext | null): Promise<string> {
  if (ctx) return ctx.getAccessToken();
  return getValidAccessToken();
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Request cancelled"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(signal?.reason ?? new Error("Request cancelled")); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function retryAfterAt(header: string | null | undefined, fallbackMs = 1000): number {
  const value = header?.trim();
  if (value) {
    if (/^(?:\d+(?:\.\d+)?|\.\d+)$/.test(value)) return Date.now() + Number(value) * 1000;
    if (/^-\d/.test(value)) return Date.now() + fallbackMs;
    const date = Date.parse(value);
    if (Number.isFinite(date)) return Math.max(Date.now(), date);
  }
  return Date.now() + fallbackMs;
}

function combineSignal(signal: AbortSignal | undefined, deadlineAt: number | undefined): { signal: AbortSignal; cleanup: () => void } {
  const controller = new AbortController();
  const timeoutMs = Math.max(1, Math.min(REQUEST_TIMEOUT_MS, deadlineAt === undefined ? REQUEST_TIMEOUT_MS : deadlineAt - Date.now()));
  const timer = setTimeout(() => controller.abort(new Error("Jobber request timed out")), timeoutMs);
  const onAbort = () => controller.abort(signal?.reason ?? new Error("Request cancelled"));
  if (signal?.aborted) onAbort();
  else signal?.addEventListener("abort", onAbort, { once: true });
  return { signal: controller.signal, cleanup: () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); } };
}

interface RawGraphQLResponse {
  status: number;
  retryAfterHeader: string | null;
  body: any;
  parseFailed: boolean;
}

async function postOnce(
  token: string,
  query: string,
  variables: Record<string, unknown> | undefined,
  control: AdmissionControl = {}
): Promise<RawGraphQLResponse> {
  let res: Response;
  const request = combineSignal(control.signal, control.deadlineAt);
  try {
    res = await fetch(getGraphqlUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-JOBBER-GRAPHQL-VERSION": JOBBER_GRAPHQL_VERSION,
      },
      body: JSON.stringify({ query, variables }),
      signal: request.signal,
    });
  } catch (err: any) {
    if (control.signal?.aborted) throw control.signal.reason ?? err;
    throw new JobberApiError(`Jobber API request failed: ${err.message}`);
  } finally {
    request.cleanup();
  }
  let body: any = {};
  let parseFailed = false;
  try {
    body = await res.json();
  } catch {
    parseFailed = true;
  }
  return { status: res.status, retryAfterHeader: res.headers.get("Retry-After"), body, parseFailed };
}

function isThrottled(body: any): boolean {
  return Array.isArray(body?.errors) && body.errors.some((e: any) => e?.extensions?.code === "THROTTLED");
}

function isPermissionError(body: any): boolean {
  return Array.isArray(body?.errors) && body.errors.some((e: any) => {
    const code = e?.extensions?.code;
    return code === "FORBIDDEN" || code === "ACCESS_DENIED";
  });
}

function mergeMutationErrorsIntoData<T>(data: T, errors: any[]): T | undefined {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return undefined;
  for (const [field, value] of Object.entries(data as Record<string, any>)) {
    if (value === null || typeof value !== "object" || !Array.isArray(value.userErrors)) continue;
    const userErrors = errors.map((error) => ({
      message: String(error?.message ?? "Jobber returned an unspecified GraphQL error"),
      ...(Array.isArray(error?.path) ? { path: error.path.map(String) } : {}),
    }));
    return {
      ...(data as Record<string, any>),
      [field]: { ...value, userErrors: [...value.userErrors, ...userErrors] },
    } as T;
  }
  return undefined;
}

/**
 * Executes a fixed, pre-reviewed GraphQL document against Jobber's API,
 * enforcing the tool's declared max cost via the cost governor and handling
 * THROTTLED (which Jobber can send as HTTP 200) and HTTP 429 per the spec.
 */
async function executeGraphQL<T = any>(
  query: string,
  variables: Record<string, unknown> | undefined,
  maxCost: number,
  isMutation: boolean,
  control: AdmissionControl = {}
): Promise<T> {
  const ctx = requireSessionContext();
  const governor = await getGovernorForContext(ctx, control);
  const token = await resolveAccessToken(ctx);
  let throttleRetries = 0;
  let rateLimitRetries = 0;
  let fiveXxRetries = 0;
  let attempts = 0;

  for (;;) {
      if (!isMutation && attempts >= MAX_READ_ATTEMPTS) throw new JobberApiError("Jobber read exceeded its bounded retry attempts.");
      const admission = await governor.admit(maxCost, control);
      attempts++;
      let response: RawGraphQLResponse;
      try {
        response = await postOnce(token, query, variables, control);
        governor.settleAdmission(admission);
      } catch (error: any) {
        // Fetch was dispatched. Its cost and request-count reservation stays spent even
        // when a timeout or transport failure hides the provider response.
        governor.settleAdmission(admission);
        if (isMutation) {
          throw new JobberOutcomeUncertainError(
            `${error.message} The write outcome is unknown; check Jobber before trying again.`
          );
        }
        throw error;
      }
      const { status, retryAfterHeader, body, parseFailed } = response;
      if (body?.extensions?.cost) governor.recordCost(body.extensions.cost);

      if (status === 429) {
        const fallback = DEFAULT_429_BACKOFF_MS[Math.min(rateLimitRetries, DEFAULT_429_BACKOFF_MS.length - 1)];
        const retryAt = retryAfterAt(retryAfterHeader, fallback);
        governor.deferUntil(retryAt);
        if (isMutation) {
          throw new JobberOutcomeUncertainError(
            "Jobber rate-limited this write before a result was returned. Its outcome is unknown; check Jobber before trying again."
          );
        }
        if (rateLimitRetries >= MAX_429_RETRIES || attempts >= MAX_READ_ATTEMPTS) {
          throw new JobberApiError("Jobber rate limit (HTTP 429) exceeded after 3 retries.");
        }
        rateLimitRetries++;
        if (retryAt - Date.now() > 5000) throw new BudgetUnavailableError(Math.ceil((retryAt - Date.now()) / 1000), retryAt, "provider_throttled");
        continue;
      }

      if (isThrottled(body)) {
        const reported = body?.extensions?.cost?.requestedQueryCost;
        const required = typeof reported === "number" && Number.isFinite(reported) ? Math.max(maxCost, reported) : maxCost;
        if (!body?.extensions?.cost) governor.assumeDepleted();
        const refillMs = body?.extensions?.cost
          ? Math.max(1, governor.backoffMsFor(required))
          : Math.max(1000, governor.backoffMsFor(required));
        governor.deferUntil(Date.now() + refillMs);
        if (isMutation) {
          throw new JobberOutcomeUncertainError(
            "Jobber throttled this write before a result was returned. Its outcome is unknown; check Jobber before trying again."
          );
        }
        if (throttleRetries >= MAX_THROTTLE_RETRIES) {
          throw new JobberApiError(
            "Jobber API is still throttled after one retry. The API cost budget needs more time to refill - please try again shortly."
          );
        }
        throttleRetries++;
        if (attempts >= MAX_READ_ATTEMPTS) throw new JobberApiError("Jobber read exceeded its bounded retry attempts.");
        if (refillMs > 5000) throw new BudgetUnavailableError(Math.ceil(refillMs / 1000), Date.now() + refillMs);
        continue;
      }

      // Checked ahead of the generic errors-array/status branches below: Jobber can return a 401
      // either bare or with an `errors` array attached, and either way the actionable guidance is
      // the same - the access token was rejected, not a generic API/GraphQL failure.
      if (status === 401) {
        throw new JobberAuthenticationError(
          "Jobber API error: HTTP 401 - access token was rejected; run the authenticate tool to log in again."
        );
      }

      // 5xx is typically transient for a read (gateway blips, deploys), so reads retry a
      // couple of times. A mutation gets no retry: the remote side could have committed before
      // returning a gateway error. Checked ahead of the errors-array/generic-status branches so
      // a 5xx with an errors array follows the same safe mutation behavior.
      if (isMutation && status >= 500) {
        throw new JobberOutcomeUncertainError(
          "Jobber returned a server error for this write. Its outcome is unknown; check Jobber before trying again."
        );
      }
      if (!isMutation && status >= 500 && fiveXxRetries < MAX_5XX_RETRIES) {
        fiveXxRetries++;
        if (attempts >= MAX_READ_ATTEMPTS) throw new JobberApiError("Jobber read exceeded its bounded retry attempts.");
        await sleep(FIVE_XX_BACKOFF_MS[Math.min(fiveXxRetries - 1, FIVE_XX_BACKOFF_MS.length - 1)], control.signal);
        continue;
      }
      if (!isMutation && status >= 500) {
        const detail = Array.isArray(body?.errors)
          ? ` - ${body.errors.map((error: any) => error.message).join("; ")}`
          : "";
        throw new JobberApiError(`Jobber API error: HTTP ${status}${detail}`);
      }

      if (Array.isArray(body?.errors) && body.errors.length > 0) {
        if (isMutation && status < 400 && body.data !== undefined) {
          const merged = mergeMutationErrorsIntoData<T>(body.data, body.errors);
          if (merged !== undefined) {mutationExecutionFailures.add(merged as object);return merged;}
        }
        const message = body.errors.map((e: any) => e.message).join("; ");
        if (isPermissionError(body)) throw new JobberPermissionError(message);
        throw new JobberGraphQLRequestError(`Jobber API error: ${message}`);
      }

      if (status >= 400) {
        throw new JobberGraphQLRequestError(`Jobber API error: HTTP ${status}`);
      }

      if (parseFailed) {
        if (isMutation) {
          throw new JobberOutcomeUncertainError(
            "Jobber returned a non-JSON response for this write. Its outcome is unknown; check Jobber before trying again."
          );
        }
        throw new JobberApiError("Jobber API returned a non-JSON response");
      }

      if (body?.extensions?.cost) {
        // Already applied before interpreting the response so errors and successful reads
        // update the same shared account budget.
      }

      if (body?.data === undefined) {
        if (isMutation) {
          throw new JobberOutcomeUncertainError(
            "Jobber returned no result for this write. Its outcome is unknown; check Jobber before trying again."
          );
        }
        throw new JobberApiError("Jobber API response had no data field");
      }

      return body.data as T;
  }
}

/**
 * Executes a fixed, reviewed read query. Read requests may use bounded retries
 * for transient Jobber throttling and server failures.
 */
export async function jobberGraphQL<T = any>(
  query: string,
  variables: Record<string, unknown> | undefined,
  maxCost: number,
  control: AdmissionControl = {}
): Promise<T> {
  return executeGraphQL(query, variables, maxCost, false, control);
}

/**
 * Executes a fixed, reviewed mutation. It deliberately performs no automatic
 * retry after a throttled, rate-limited, or 5xx response because Jobber may
 * have committed the mutation even when the caller did not receive a result.
 */
export async function jobberGraphQLWrite<T = any>(
  query: string,
  variables: Record<string, unknown> | undefined,
  maxCost: number,
  control: AdmissionControl = {}
): Promise<T> {
  return executeGraphQL(query, variables, maxCost, true, control);
}
