import { getValidAccessToken } from "../auth/oauth.js";
import { requireSessionContext } from "../utils/sessionContext.js";
import type { SessionContext } from "../utils/sessionContext.js";
import { CostGovernor } from "./cost-governor.js";
import { ACCOUNT_ID_QUERY } from "./queries.js";

export const JOBBER_GRAPHQL_VERSION = process.env.JOBBER_GRAPHQL_VERSION ?? "2025-04-16";

function getGraphqlUrl(): string {
  return process.env.JOBBER_GRAPHQL_URL ?? "https://api.getjobber.com/api/graphql";
}

export class JobberApiError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JobberApiError";
  }
}

export class JobberPermissionError extends Error {
  constructor(originalMessage?: string) {
    super(
      "Jobber restricts this data to accounts on its top-tier plan. " +
      "Upgrade your Jobber plan to use this feature: https://getjobber.com/pricing/" +
      (originalMessage ? ` (Jobber said: ${originalMessage})` : "")
    );
    this.name = "JobberPermissionError";
  }
}

const MAX_THROTTLE_RETRIES = 1;
const MAX_429_RETRIES = 3;
const DEFAULT_429_BACKOFF_MS = [1000, 2000, 4000];
const MAX_RETRY_AFTER_MS = 10_000;
const REQUEST_TIMEOUT_MS = 30_000;
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

function getSharedAccountGovernor(accountId: string, sessionId: string): CostGovernor {
  let entry = accountGovernors.get(accountId);
  if (!entry) {
    entry = { governor: new CostGovernor(), sessionIds: new Set() };
    accountGovernors.set(accountId, entry);
  }
  entry.sessionIds.add(sessionId);
  return entry.governor;
}

const ACCOUNT_ID_QUERY_COST = 1; // deliberately the cheapest possible query - see queries.ts

/**
 * Resolves the Jobber account id for a session so its governor can be shared with any other
 * session on the same account, instead of each session assuming it owns the account's full
 * budget. Best-effort and non-fatal: any failure (network, budget, malformed/rejected query)
 * is swallowed and reported as unresolved (null) rather than failing or delaying the caller's
 * real request - that request then simply keeps using its own per-session governor, exactly as
 * it did before this resolution existed.
 */
async function resolveAccountId(ctx: SessionContext): Promise<string | null> {
  try {
    const token = await ctx.getAccessToken();
    const governor = getGovernorForSession(ctx.sessionId);
    await governor.checkBudget(ACCOUNT_ID_QUERY_COST);
    let costRecorded = false;
    try {
      const { status, body } = await postOnce(token, ACCOUNT_ID_QUERY, undefined);
      if (body?.extensions?.cost) {
        governor.recordCost(body.extensions.cost);
        costRecorded = true;
      }
      const id = body?.data?.account?.id;
      return status === 200 && typeof id === "string" && id.length > 0 ? id : null;
    } finally {
      if (!costRecorded) governor.releaseReservation(ACCOUNT_ID_QUERY_COST);
    }
  } catch (err: any) {
    console.error(
      "[jobber] Could not resolve account id for cost-governor sharing; this session will budget independently:",
      err?.message ?? err
    );
    return null;
  }
}

/** Picks (and, on a session's first call, resolves/caches) the governor to use for a request. */
async function getGovernorForContext(ctx: SessionContext | null): Promise<CostGovernor> {
  // "" is the http.ts initialize-request placeholder sessionId, never a real one - treat it as
  // absent (falsy `||`, not `??`) so it doesn't allocate a bogus session-keyed governor.
  const sessionId = ctx?.sessionId || undefined;
  if (ctx === null || sessionId === undefined) return stdioGovernor;

  let accountId = ctx.getAccountId();
  if (accountId === undefined) {
    accountId = await resolveAccountId(ctx);
    ctx.setAccountId(accountId);
  }
  return accountId ? getSharedAccountGovernor(accountId, sessionId) : getGovernorForSession(sessionId);
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

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  variables: Record<string, unknown> | undefined
): Promise<RawGraphQLResponse> {
  let res: Response;
  try {
    res = await fetch(getGraphqlUrl(), {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-JOBBER-GRAPHQL-VERSION": JOBBER_GRAPHQL_VERSION,
      },
      body: JSON.stringify({ query, variables }),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err: any) {
    throw new JobberApiError(`Jobber API request failed: ${err.message}`);
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

/**
 * Executes a fixed, pre-reviewed GraphQL document against Jobber's API,
 * enforcing the tool's declared max cost via the cost governor and handling
 * THROTTLED (which Jobber can send as HTTP 200) and HTTP 429 per the spec.
 */
async function executeGraphQL<T = any>(
  query: string,
  variables: Record<string, unknown> | undefined,
  maxCost: number,
  isMutation: boolean
): Promise<T> {
  const ctx = requireSessionContext();
  const governor = await getGovernorForContext(ctx);
  const token = await resolveAccessToken(ctx);

  await governor.checkBudget(maxCost);

  let throttleRetries = 0;
  let rateLimitRetries = 0;
  let fiveXxRetries = 0;
  let costRecorded = false;

  try {
    for (;;) {
      const { status, retryAfterHeader, body, parseFailed } = await postOnce(token, query, variables);

      if (status === 429) {
        if (isMutation) {
          throw new JobberApiError(
            "Jobber rate-limited this write before a result was returned. Its outcome is unknown; check Jobber before trying again."
          );
        }
        if (rateLimitRetries >= MAX_429_RETRIES) {
          throw new JobberApiError("Jobber rate limit (HTTP 429) exceeded after 3 retries.");
        }
        const parsedRetryAfter = retryAfterHeader ? parseInt(retryAfterHeader, 10) : NaN;
        // A negative Retry-After is treated the same as a missing/non-numeric one - fall back to
        // the default backoff schedule instead of sleeping a negative duration (which resolves
        // near-instantly and produces a tight retry loop against an endpoint that just said 429).
        const delayMs = !Number.isNaN(parsedRetryAfter) && parsedRetryAfter >= 0
          ? Math.min(parsedRetryAfter * 1000, MAX_RETRY_AFTER_MS)
          : DEFAULT_429_BACKOFF_MS[Math.min(rateLimitRetries, DEFAULT_429_BACKOFF_MS.length - 1)];
        rateLimitRetries++;
        await sleep(delayMs);
        continue;
      }

      if (isThrottled(body)) {
        if (isMutation) {
          throw new JobberApiError(
            "Jobber throttled this write before a result was returned. Its outcome is unknown; check Jobber before trying again."
          );
        }
        if (throttleRetries >= MAX_THROTTLE_RETRIES) {
          throw new JobberApiError(
            "Jobber API is still throttled after one retry. The API cost budget needs more time to refill - please try again shortly."
          );
        }
        throttleRetries++;
        if (body?.extensions?.cost) {
          governor.recordCost(body.extensions.cost);
          costRecorded = true;
        } else {
          // No cost data on this throttle response - stale optimistic state can't be trusted, so
          // assume the budget is exhausted rather than retrying instantly against it.
          governor.assumeDepleted();
        }
        await sleep(governor.backoffMsFor(maxCost));
        continue;
      }

      // Checked ahead of the generic errors-array/status branches below: Jobber can return a 401
      // either bare or with an `errors` array attached, and either way the actionable guidance is
      // the same - the access token was rejected, not a generic API/GraphQL failure.
      if (status === 401) {
        throw new JobberApiError(
          "Jobber API error: HTTP 401 - access token was rejected; run the authenticate tool to log in again."
        );
      }

      // 5xx is typically transient for a read (gateway blips, deploys), so reads retry a
      // couple of times. A mutation gets no retry: the remote side could have committed before
      // returning a gateway error. Checked ahead of the errors-array/generic-status branches so
      // a 5xx with an errors array follows the same safe mutation behavior.
      if (isMutation && status >= 500) {
        throw new JobberApiError(
          "Jobber returned a server error for this write. Its outcome is unknown; check Jobber before trying again."
        );
      }
      if (!isMutation && status >= 500 && fiveXxRetries < MAX_5XX_RETRIES) {
        fiveXxRetries++;
        await sleep(FIVE_XX_BACKOFF_MS[Math.min(fiveXxRetries - 1, FIVE_XX_BACKOFF_MS.length - 1)]);
        continue;
      }

      if (Array.isArray(body?.errors) && body.errors.length > 0) {
        if (body?.extensions?.cost) {
          governor.recordCost(body.extensions.cost);
          costRecorded = true;
        }
        const message = body.errors.map((e: any) => e.message).join("; ");
        if (isPermissionError(body)) throw new JobberPermissionError(message);
        throw new JobberApiError(`Jobber API error: ${message}`);
      }

      if (status >= 400) {
        throw new JobberApiError(`Jobber API error: HTTP ${status}`);
      }

      if (parseFailed) {
        throw new JobberApiError("Jobber API returned a non-JSON response");
      }

      if (body?.extensions?.cost) {
        governor.recordCost(body.extensions.cost);
        costRecorded = true;
      }

      if (body?.data === undefined) {
        throw new JobberApiError("Jobber API response had no data field");
      }

      return body.data as T;
    }
  } finally {
    // If nothing ever gave us a real extensions.cost update, checkBudget's reservation never got
    // corrected by real server data - release it so a failed/errored request doesn't permanently
    // under-count the budget.
    if (!costRecorded) {
      governor.releaseReservation(maxCost);
    }
  }
}

/**
 * Executes a fixed, reviewed read query. Read requests may use bounded retries
 * for transient Jobber throttling and server failures.
 */
export async function jobberGraphQL<T = any>(
  query: string,
  variables: Record<string, unknown> | undefined,
  maxCost: number
): Promise<T> {
  return executeGraphQL(query, variables, maxCost, false);
}

/**
 * Executes a fixed, reviewed mutation. It deliberately performs no automatic
 * retry after a throttled, rate-limited, or 5xx response because Jobber may
 * have committed the mutation even when the caller did not receive a result.
 */
export async function jobberGraphQLWrite<T = any>(
  query: string,
  variables: Record<string, unknown> | undefined,
  maxCost: number
): Promise<T> {
  return executeGraphQL(query, variables, maxCost, true);
}
