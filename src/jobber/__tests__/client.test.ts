import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";

const { mockGetValidAccessToken, mockRequireSessionContext } = vi.hoisted(() => ({
  mockGetValidAccessToken: vi.fn(),
  mockRequireSessionContext: vi.fn(),
}));

vi.mock("../../auth/oauth.js", () => ({
  getValidAccessToken: mockGetValidAccessToken,
}));

vi.mock("../../utils/sessionContext.js", () => ({
  requireSessionContext: mockRequireSessionContext,
}));

import {
  jobberGraphQL,
  JobberApiError,
  JobberPermissionError,
  getGovernorForSession,
  getGovernorForAccount,
  clearGovernorForSession,
  resetStdioGovernorForTests,
} from "../client.js";

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  const h = new Headers(headers);
  return {
    status,
    json: async () => body,
    headers: h,
  };
}

function httpCtx(sessionId: string, accessToken = "session-token") {
  return {
    sessionId,
    getAccessToken: vi.fn().mockResolvedValue(accessToken),
    storeTokens: vi.fn(),
    getTokens: vi.fn().mockReturnValue(null),
    clearTokens: vi.fn(),
    setPendingNonce: vi.fn(),
    setPendingCodeVerifier: vi.fn(),
    // Default to "already attempted and failed" so existing tests (which only mock the fetch
    // responses for their own request) don't unexpectedly need to also mock an account-id
    // resolution call. Tests that specifically exercise account-id resolution/sharing override this.
    getAccountId: vi.fn().mockReturnValue(null),
    setAccountId: vi.fn(),
  };
}

// Unlike httpCtx() above (whose getAccountId always returns null, i.e. "already tried and
// failed," so existing tests don't need to also mock an account-id resolution call), this helper
// starts with getAccountId() === undefined ("not yet attempted") and actually stores whatever
// setAccountId() is called with, so a test can drive a real resolve-then-reuse cycle.
function httpCtxWithAccountResolution(sessionId: string, accessToken = "session-token") {
  let accountId: string | null | undefined;
  return {
    sessionId,
    getAccessToken: vi.fn().mockResolvedValue(accessToken),
    storeTokens: vi.fn(),
    getTokens: vi.fn().mockReturnValue(null),
    clearTokens: vi.fn(),
    setPendingNonce: vi.fn(),
    setPendingCodeVerifier: vi.fn(),
    getAccountId: vi.fn(() => accountId),
    setAccountId: vi.fn((id: string | null) => {
      accountId = id;
    }),
  };
}

let sessionCounter = 0;
function freshSessionId(): string {
  sessionCounter++;
  return `test-session-${sessionCounter}`;
}

beforeEach(() => {
  vi.clearAllMocks();
  resetStdioGovernorForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("jobberGraphQL - request shape", () => {
  it("stdio mode: resolves the token via getValidAccessToken and posts the version header + bearer auth", async () => {
    mockRequireSessionContext.mockReturnValue(null);
    mockGetValidAccessToken.mockResolvedValue("stdio-token");
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { data: { ok: true }, extensions: { cost: costExt(9000) } }));
    vi.stubGlobal("fetch", fetchMock);

    const data = await jobberGraphQL("query { x }", undefined, 10);
    expect(data).toEqual({ ok: true });

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.getjobber.com/api/graphql");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("Bearer stdio-token");
    expect(init.headers["X-JOBBER-GRAPHQL-VERSION"]).toBeTruthy();
  });

  it("HTTP mode: resolves the token via the session context, not getValidAccessToken", async () => {
    const ctx = httpCtx(freshSessionId(), "http-token");
    mockRequireSessionContext.mockReturnValue(ctx);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(200, { data: { ok: true }, extensions: { cost: costExt(9000) } }));
    vi.stubGlobal("fetch", fetchMock);

    await jobberGraphQL("query { x }", undefined, 10);
    expect(ctx.getAccessToken).toHaveBeenCalled();
    expect(mockGetValidAccessToken).not.toHaveBeenCalled();
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Authorization).toBe("Bearer http-token");
  });
});

describe("jobberGraphQL - success + cost recording", () => {
  it("records the response's cost extension into the session's governor", async () => {
    const sessionId = freshSessionId();
    const ctx = httpCtx(sessionId);
    mockRequireSessionContext.mockReturnValue(ctx);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { data: { ok: true }, extensions: { cost: costExt(4321) } }))
    );

    await jobberGraphQL("query { x }", undefined, 10);
    expect(getGovernorForSession(sessionId).getState().currentlyAvailable).toBe(4321);
  });
});

describe("jobberGraphQL - pre-request budget check", () => {
  it("rejects immediately without calling fetch when the budget wait would exceed 5s", async () => {
    const sessionId = freshSessionId();
    const ctx = httpCtx(sessionId);
    mockRequireSessionContext.mockReturnValue(ctx);
    // Deplete the session's governor so a huge maxCost needs a >5s wait.
    getGovernorForSession(sessionId).recordCost(costExtRaw({ maximumAvailable: 10000, currentlyAvailable: 0, restoreRate: 1 }));

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    await expect(jobberGraphQL("query { x }", undefined, 9000)).rejects.toThrow("API budget refilling");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("jobberGraphQL - account-id-based governor sharing", () => {
  it("resolves the account id on a session's first call and caches it via setAccountId", async () => {
    const ctx = httpCtxWithAccountResolution(freshSessionId());
    mockRequireSessionContext.mockReturnValue(ctx);

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, { data: { account: { id: "acct-1" } }, extensions: { cost: costExt(9999) } })
      )
      .mockResolvedValueOnce(jsonResponse(200, { data: { ok: true }, extensions: { cost: costExt(9000) } }));
    vi.stubGlobal("fetch", fetchMock);

    const data = await jobberGraphQL("query { x }", undefined, 10);
    expect(data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(ctx.setAccountId).toHaveBeenCalledWith("acct-1");
    const firstCallBody = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(firstCallBody.query).toMatch(/AccountId/);
  });

  it("two sessions that resolve to the same account id share one governor's budget", async () => {
    const accountId = `shared-acct-${freshSessionId()}`;
    const ctxA = httpCtxWithAccountResolution(freshSessionId());
    const ctxB = httpCtxWithAccountResolution(freshSessionId());

    mockRequireSessionContext.mockReturnValue(ctxA);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(200, { data: { account: { id: accountId } }, extensions: { cost: costExt(9999) } })
        )
        .mockResolvedValueOnce(jsonResponse(200, { data: { ok: true }, extensions: { cost: costExt(3000) } }))
    );
    await jobberGraphQL("query { x }", undefined, 10);

    mockRequireSessionContext.mockReturnValue(ctxB);
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(200, { data: { account: { id: accountId } }, extensions: { cost: costExt(9999) } })
        )
        .mockResolvedValueOnce(jsonResponse(200, { data: { ok: true }, extensions: { cost: costExt(1500) } }))
    );
    await jobberGraphQL("query { x }", undefined, 10);

    // Both sessions' calls updated the *same* governor - its final state reflects session B's
    // last response (1500), which is only possible if both sessions share one CostGovernor
    // instead of each tracking its own independent 10,000-point budget.
    expect(getGovernorForAccount(accountId)!.getState().currentlyAvailable).toBe(1500);
  });

  it("falls back to a per-session governor, without retrying resolution, when account-id resolution fails", async () => {
    const ctx = httpCtxWithAccountResolution(freshSessionId());
    mockRequireSessionContext.mockReturnValue(ctx);

    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockRejectedValueOnce(new Error("network blip"))
        .mockResolvedValueOnce(jsonResponse(200, { data: { ok: true }, extensions: { cost: costExt(9000) } }))
    );
    const data = await jobberGraphQL("query { x }", undefined, 10);
    expect(data).toEqual({ ok: true });
    expect(ctx.setAccountId).toHaveBeenCalledWith(null);

    // A second call on the same session must not retry account-id resolution (it's cached as
    // failed) - exactly one fetch call for the real request, none for a resolution retry.
    const fetchMock2 = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { data: { ok: true }, extensions: { cost: costExt(8000) } }));
    vi.stubGlobal("fetch", fetchMock2);
    await jobberGraphQL("query { x }", undefined, 10);
    expect(fetchMock2).toHaveBeenCalledTimes(1);
  });

  it("keeps a shared account governor alive for a still-open sibling session, removing it only once all its sessions close", async () => {
    const accountId = `refcount-acct-${freshSessionId()}`;
    const ctxA = httpCtxWithAccountResolution(freshSessionId());
    const ctxB = httpCtxWithAccountResolution(freshSessionId());

    for (const ctx of [ctxA, ctxB]) {
      mockRequireSessionContext.mockReturnValue(ctx);
      vi.stubGlobal(
        "fetch",
        vi
          .fn()
          .mockResolvedValueOnce(
            jsonResponse(200, { data: { account: { id: accountId } }, extensions: { cost: costExt(9999) } })
          )
          .mockResolvedValueOnce(jsonResponse(200, { data: { ok: true }, extensions: { cost: costExt(5000) } }))
      );
      await jobberGraphQL("query { x }", undefined, 10);
    }

    expect(getGovernorForAccount(accountId)).toBeDefined();

    clearGovernorForSession(ctxA.sessionId, accountId);
    expect(getGovernorForAccount(accountId)).toBeDefined(); // ctxB's session is still open

    clearGovernorForSession(ctxB.sessionId, accountId);
    expect(getGovernorForAccount(accountId)).toBeUndefined(); // both sessions on this account are now closed
  });
});

describe("jobberGraphQL - GraphQL errors", () => {
  it("throws JobberApiError with the joined error messages for generic GraphQL errors", async () => {
    mockRequireSessionContext.mockReturnValue(null);
    mockGetValidAccessToken.mockResolvedValue("t");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(200, { errors: [{ message: "Client not found" }] }))
    );

    await expect(jobberGraphQL("query { x }", undefined, 10)).rejects.toThrow(JobberApiError);
    await expect(jobberGraphQL("query { x }", undefined, 10)).rejects.toThrow("Client not found");
  });

  it("throws JobberPermissionError with a pricing-page link for plan/permission errors", async () => {
    mockRequireSessionContext.mockReturnValue(null);
    mockGetValidAccessToken.mockResolvedValue("t");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, { errors: [{ message: "Not authorized", extensions: { code: "FORBIDDEN" } }] })
      )
    );

    await expect(jobberGraphQL("query { x }", undefined, 10)).rejects.toThrow(JobberPermissionError);
    await expect(jobberGraphQL("query { x }", undefined, 10)).rejects.toThrow(/pricing/);
  });

  it("still records the cost extension into the governor on a generic (non-throttle) error response", async () => {
    const sessionId = freshSessionId();
    const ctx = httpCtx(sessionId);
    mockRequireSessionContext.mockReturnValue(ctx);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, { errors: [{ message: "Client not found" }], extensions: { cost: costExt(1234) } })
      )
    );

    await expect(jobberGraphQL("query { x }", undefined, 10)).rejects.toThrow(JobberApiError);
    expect(getGovernorForSession(sessionId).getState().currentlyAvailable).toBe(1234);
  });

  it("does not misclassify an unrelated error mentioning 'plan' as a permission error", async () => {
    mockRequireSessionContext.mockReturnValue(null);
    mockGetValidAccessToken.mockResolvedValue("t");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        jsonResponse(200, { errors: [{ message: "This visit has no plan assigned" }] })
      )
    );

    const err = await jobberGraphQL("query { x }", undefined, 10).catch((e) => e);
    expect(err).toBeInstanceOf(JobberApiError);
    expect(err).not.toBeInstanceOf(JobberPermissionError);
    expect(err.message).toContain("This visit has no plan assigned");
  });
});

describe("jobberGraphQL - HTTP 401", () => {
  it("throws a re-authenticate message on a bare 401", async () => {
    mockRequireSessionContext.mockReturnValue(null);
    mockGetValidAccessToken.mockResolvedValue("t");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(401, {})));

    await expect(jobberGraphQL("query { x }", undefined, 10)).rejects.toThrow(JobberApiError);
    await expect(jobberGraphQL("query { x }", undefined, 10)).rejects.toThrow(/401.*authenticate/i);
  });

  it("throws the re-authenticate message even when Jobber's 401 body carries an errors array", async () => {
    mockRequireSessionContext.mockReturnValue(null);
    mockGetValidAccessToken.mockResolvedValue("t");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(jsonResponse(401, { errors: [{ message: "Invalid token" }] }))
    );

    const err = await jobberGraphQL("query { x }", undefined, 10).catch((e) => e);
    expect(err).toBeInstanceOf(JobberApiError);
    expect(err.message).toMatch(/401.*authenticate/i);
    expect(err).not.toBeInstanceOf(JobberPermissionError);
  });
});

describe("jobberGraphQL - malformed / non-JSON responses", () => {
  it("throws a named error instead of returning undefined when the body is non-JSON", async () => {
    mockRequireSessionContext.mockReturnValue(null);
    mockGetValidAccessToken.mockResolvedValue("t");
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        json: async () => {
          throw new SyntaxError("Unexpected token");
        },
        headers: new Headers(),
      })
    );

    await expect(jobberGraphQL("query { x }", undefined, 10)).rejects.toThrow(JobberApiError);
    await expect(jobberGraphQL("query { x }", undefined, 10)).rejects.toThrow(/non-JSON/);
  });

  it("throws a named error instead of returning undefined when a 200 response has no data field", async () => {
    mockRequireSessionContext.mockReturnValue(null);
    mockGetValidAccessToken.mockResolvedValue("t");
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse(200, {})));

    await expect(jobberGraphQL("query { x }", undefined, 10)).rejects.toThrow(JobberApiError);
    await expect(jobberGraphQL("query { x }", undefined, 10)).rejects.toThrow(/no data field/);
  });
});

describe("jobberGraphQL - network failures", () => {
  it("wraps a rejected fetch (network error/timeout) in a named JobberApiError", async () => {
    mockRequireSessionContext.mockReturnValue(null);
    mockGetValidAccessToken.mockResolvedValue("t");
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("fetch failed")));

    await expect(jobberGraphQL("query { x }", undefined, 10)).rejects.toThrow(JobberApiError);
    await expect(jobberGraphQL("query { x }", undefined, 10)).rejects.toThrow(/Jobber API request failed/);
  });

  it("wraps an aborted/timed-out request the same way as any other rejected fetch", async () => {
    mockRequireSessionContext.mockReturnValue(null);
    mockGetValidAccessToken.mockResolvedValue("t");
    // client.ts passes AbortSignal.timeout(30_000) to fetch; a real timeout surfaces as fetch
    // rejecting with an abort-shaped error, going through the same catch/wrap path as any
    // other network failure - this locks in that it's not silently swallowed or misreported.
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new DOMException("The operation was aborted", "TimeoutError"))
    );

    await expect(jobberGraphQL("query { x }", undefined, 10)).rejects.toThrow(JobberApiError);
    await expect(jobberGraphQL("query { x }", undefined, 10)).rejects.toThrow(/Jobber API request failed/);
  });

  it("actually wires a real AbortSignal into the fetch call, not just a documented timeout constant", async () => {
    // AbortSignal.timeout() schedules via Node's internal timer wheel, which vitest's fake-timer
    // shim does not intercept - advancing fake time here never fires it (confirmed: the naive
    // version of this test hangs for the real 30s and times out). So instead of waiting out the
    // real 30s, this proves the actual plumbing: fetch receives a genuine AbortSignal, and when
    // that signal is aborted (as AbortSignal.timeout would do on expiry), the abort propagates
    // through fetch and is wrapped as a JobberApiError - the same path a real timeout takes.
    mockRequireSessionContext.mockReturnValue(null);
    mockGetValidAccessToken.mockResolvedValue("t");

    let capturedSignal: AbortSignal | undefined;
    const fetchMock = vi.fn().mockImplementation((_url: string, init: { signal: AbortSignal }) => {
      capturedSignal = init.signal;
      return new Promise((_resolve, reject) => {
        init.signal.addEventListener("abort", () => {
          reject(new DOMException("The operation was aborted", "TimeoutError"));
        });
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = jobberGraphQL("query { x }", undefined, 10);
    // Let postOnce run far enough (past the budget-check await chain) to call fetch and capture
    // the signal it was given.
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(capturedSignal).toBeInstanceOf(AbortSignal);
    expect(capturedSignal!.aborted).toBe(false);

    (capturedSignal as any).dispatchEvent(new Event("abort"));

    await expect(resultPromise).rejects.toThrow(/Jobber API request failed/);
  });
});

describe("jobberGraphQL - HTTP 5xx", () => {
  it("retries a transient 5xx with backoff and succeeds once the server recovers", async () => {
    vi.useFakeTimers();
    mockRequireSessionContext.mockReturnValue(null);
    mockGetValidAccessToken.mockResolvedValue("t");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(500, {}))
      .mockResolvedValueOnce(jsonResponse(502, {}))
      .mockResolvedValueOnce(jsonResponse(200, { data: { x: 1 } }));
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = jobberGraphQL("query { x }", undefined, 10);
    await vi.advanceTimersByTimeAsync(1000); // first 5xx backoff
    await vi.advanceTimersByTimeAsync(2000); // second 5xx backoff
    await expect(resultPromise).resolves.toEqual({ x: 1 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("gives up after MAX_5XX_RETRIES and throws a named error for a persistent bare 500", async () => {
    vi.useFakeTimers();
    mockRequireSessionContext.mockReturnValue(null);
    mockGetValidAccessToken.mockResolvedValue("t");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(500, {}));
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = jobberGraphQL("query { x }", undefined, 10);
    const assertion = expect(resultPromise).rejects.toThrow(JobberApiError);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3); // 1 initial attempt + 2 retries
  });

  it("retries a 5xx that also carries a GraphQL errors array, surfacing the message only once retries are exhausted", async () => {
    vi.useFakeTimers();
    mockRequireSessionContext.mockReturnValue(null);
    mockGetValidAccessToken.mockResolvedValue("t");
    // The 5xx-retry branch runs before the errors-array branch, so a 5xx with a real errors
    // payload should still be retried like any other 5xx, not treated as immediately permanent.
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse(500, { errors: [{ message: "Internal error processing request" }] })
    );
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = jobberGraphQL("query { x }", undefined, 10);
    const assertion = expect(resultPromise).rejects.toThrow(/Internal error processing request/);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a bare 4xx with no errors array", async () => {
    mockRequireSessionContext.mockReturnValue(null);
    mockGetValidAccessToken.mockResolvedValue("t");
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(400, {}));
    vi.stubGlobal("fetch", fetchMock);

    await expect(jobberGraphQL("query { x }", undefined, 10)).rejects.toThrow(JobberApiError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("jobberGraphQL - THROTTLED (HTTP 200 body)", () => {
  it("detects THROTTLED even though the HTTP status is 200, waits, and retries once, then succeeds", async () => {
    vi.useFakeTimers();
    const sessionId = freshSessionId();
    const ctx = httpCtx(sessionId);
    mockRequireSessionContext.mockReturnValue(ctx);
    // Throttle response carries real cost data (currentlyAvailable: 0) so the retry must wait.
    const throttleCost = costExtRaw({ maximumAvailable: 10000, currentlyAvailable: 0, restoreRate: 500 });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
          extensions: { cost: throttleCost },
        })
      )
      .mockResolvedValueOnce(jsonResponse(200, { data: { ok: true }, extensions: { cost: costExt(9000) } }));
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = jobberGraphQL("query { x }", undefined, 10);
    // need 10, have 0, restoreRate 500 → 20ms wait
    await vi.advanceTimersByTimeAsync(19);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const data = await resultPromise;
    expect(data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("waits a real, nonzero backoff before retrying when THROTTLED arrives with no extensions.cost data", async () => {
    vi.useFakeTimers();
    const sessionId = freshSessionId();
    const ctx = httpCtx(sessionId);
    mockRequireSessionContext.mockReturnValue(ctx);
    // Governor's stale state looks like plenty of budget is available - the bug this guards
    // against is retrying instantly against that stale reading instead of actually waiting.
    getGovernorForSession(sessionId).recordCost(
      costExtRaw({ maximumAvailable: 10000, currentlyAvailable: 10000, restoreRate: 500 })
    );

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(200, { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { ok: true }, extensions: { cost: costExt(9000) } }));
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = jobberGraphQL("query { x }", undefined, 1000);
    // No cost data → assumeDepleted() zeroes budget; need 1000, have 0, restoreRate 500 → 2000ms wait.
    await vi.advanceTimersByTimeAsync(1999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const data = await resultPromise;
    expect(data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("handles a fresh stdio governor's very first call landing against an already-drained account", async () => {
    vi.useFakeTimers();
    // Distinct from the HTTP-session THROTTLED tests above: this is the singleton stdio governor
    // on a brand-new process, with no prior recordCost/assumeDepleted priming - the optimistic
    // default (10000) is all it knows going in, and the real account turns out to already be
    // drained by another integration before this process ever gets a successful response.
    mockRequireSessionContext.mockReturnValue(null);
    mockGetValidAccessToken.mockResolvedValue("stdio-token");
    const throttleCost = costExtRaw({ maximumAvailable: 10000, currentlyAvailable: 0, restoreRate: 500 });

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(200, {
          errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
          extensions: { cost: throttleCost },
        })
      )
      .mockResolvedValueOnce(jsonResponse(200, { data: { ok: true }, extensions: { cost: costExt(9000) } }));
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = jobberGraphQL("query { x }", undefined, 10);
    // need 10, have 0, restoreRate 500 → 20ms wait
    await vi.advanceTimersByTimeAsync(19);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const data = await resultPromise;
    expect(data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails with a clear error when THROTTLED occurs twice in a row (no third attempt)", async () => {
    vi.useFakeTimers();
    const sessionId = freshSessionId();
    const ctx = httpCtx(sessionId);
    mockRequireSessionContext.mockReturnValue(ctx);

    const throttled = jsonResponse(200, { errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }] });
    const fetchMock = vi.fn().mockResolvedValue(throttled);
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = jobberGraphQL("query { x }", undefined, 10);
    const assertion = expect(resultPromise).rejects.toThrow(/throttled/i);
    await vi.advanceTimersByTimeAsync(1000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});

describe("jobberGraphQL - HTTP 429", () => {
  it("honors the Retry-After header and succeeds on the retried request", async () => {
    mockRequireSessionContext.mockReturnValue(null);
    mockGetValidAccessToken.mockResolvedValue("t");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, {}, { "Retry-After": "0" }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { ok: true }, extensions: { cost: costExt(9000) } }));
    vi.stubGlobal("fetch", fetchMock);

    const data = await jobberGraphQL("query { x }", undefined, 10);
    expect(data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("falls back to exponential backoff when Retry-After is absent", async () => {
    vi.useFakeTimers();
    mockRequireSessionContext.mockReturnValue(null);
    mockGetValidAccessToken.mockResolvedValue("t");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, {}))
      .mockResolvedValueOnce(jsonResponse(200, { data: { ok: true }, extensions: { cost: costExt(9000) } }));
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = jobberGraphQL("query { x }", undefined, 10);
    await vi.advanceTimersByTimeAsync(1000);
    const data = await resultPromise;
    expect(data).toEqual({ ok: true });
  });

  it("falls back to exponential backoff when Retry-After is present but non-numeric", async () => {
    vi.useFakeTimers();
    mockRequireSessionContext.mockReturnValue(null);
    mockGetValidAccessToken.mockResolvedValue("t");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, {}, { "Retry-After": "Wed, 21 Oct 2099 07:28:00 GMT" }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { ok: true }, extensions: { cost: costExt(9000) } }));
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = jobberGraphQL("query { x }", undefined, 10);
    // A non-numeric Retry-After must not collapse to a ~0ms retry; it should
    // fall back to the same backoff schedule used when the header is absent.
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const data = await resultPromise;
    expect(data).toEqual({ ok: true });
  });

  it("treats a negative Retry-After as invalid and falls back to the default backoff schedule instead of retrying instantly", async () => {
    vi.useFakeTimers();
    mockRequireSessionContext.mockReturnValue(null);
    mockGetValidAccessToken.mockResolvedValue("t");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, {}, { "Retry-After": "-5" }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { ok: true }, extensions: { cost: costExt(9000) } }));
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = jobberGraphQL("query { x }", undefined, 10);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const data = await resultPromise;
    expect(data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clamps an excessively large Retry-After to 10s instead of waiting the full header value", async () => {
    vi.useFakeTimers();
    mockRequireSessionContext.mockReturnValue(null);
    mockGetValidAccessToken.mockResolvedValue("t");

    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse(429, {}, { "Retry-After": "999999" }))
      .mockResolvedValueOnce(jsonResponse(200, { data: { ok: true }, extensions: { cost: costExt(9000) } }));
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = jobberGraphQL("query { x }", undefined, 10);
    await vi.advanceTimersByTimeAsync(9999);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    const data = await resultPromise;
    expect(data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("fails after exceeding 3 retries", async () => {
    vi.useFakeTimers();
    mockRequireSessionContext.mockReturnValue(null);
    mockGetValidAccessToken.mockResolvedValue("t");

    const fetchMock = vi.fn().mockResolvedValue(jsonResponse(429, {}, { "Retry-After": "0" }));
    vi.stubGlobal("fetch", fetchMock);

    const resultPromise = jobberGraphQL("query { x }", undefined, 10);
    const assertion = expect(resultPromise).rejects.toThrow(/429/);
    await vi.advanceTimersByTimeAsync(10);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(4); // 1 initial + 3 retries
  });
});

function costExtRaw(throttleStatus: { maximumAvailable: number; currentlyAvailable: number; restoreRate: number }) {
  return {
    requestedQueryCost: 0,
    actualQueryCost: 0,
    throttleStatus,
  };
}

function costExt(currentlyAvailable: number) {
  return costExtRaw({ maximumAvailable: 10000, currentlyAvailable, restoreRate: 500 });
}
