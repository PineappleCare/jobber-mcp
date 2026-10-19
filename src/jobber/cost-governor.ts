import { z } from "zod";

export interface JobberThrottleStatus {
  maximumAvailable: number;
  currentlyAvailable: number;
  restoreRate: number;
}

export interface JobberCostExtension {
  requestedQueryCost: number;
  actualQueryCost: number;
  throttleStatus: JobberThrottleStatus;
}

const ThrottleStatusSchema = z.object({
  maximumAvailable: z.number().nonnegative(),
  currentlyAvailable: z.number().nonnegative(),
  restoreRate: z.number().positive(),
});

const CostExtensionSchema = z
  .object({
    requestedQueryCost: z.number(),
    actualQueryCost: z.number(),
    throttleStatus: ThrottleStatusSchema,
  })
  .passthrough();

export class BudgetUnavailableError extends Error {
  constructor(waitSeconds: number, readonly retryAt = Date.now() + waitSeconds * 1000, readonly reasonCode = "budget_refilling") {
    super(`API budget refilling, try again in ${waitSeconds}s`);
    this.name = "BudgetUnavailableError";
  }
}

export class RequestRateLimitError extends Error {
  constructor(waitSeconds: number, readonly retryAt = Date.now() + waitSeconds * 1000) {
    super(`Request rate limit (2500 per 5 minutes) reached, try again in ${waitSeconds}s`);
    this.name = "RequestRateLimitError";
  }
}

const MAX_WAIT_MS = 5000;
const DEFAULT_BUDGET = 10000;
const DEFAULT_RESTORE_RATE = 500;
const REQUEST_WINDOW_MS = 5 * 60 * 1000;
const REQUEST_CEILING = 2500;

export interface AdmissionControl { signal?: AbortSignal; deadlineAt?: number }

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.reject(signal.reason ?? new Error("Request cancelled"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(done, ms);
    const onAbort = () => { clearTimeout(timer); signal?.removeEventListener("abort", onAbort); reject(signal?.reason ?? new Error("Request cancelled")); };
    function done() { signal?.removeEventListener("abort", onAbort); resolve(); }
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Tracks Jobber's cost-based rate-limit budget for one access token (one
 * CostGovernor per session in HTTP mode, one process-wide instance in stdio
 * mode) and enforces a tool's declared max cost before each request.
 */
export class CostGovernor {
  private currentlyAvailable = DEFAULT_BUDGET;
  private restoreRate = DEFAULT_RESTORE_RATE;
  private maximumAvailable = DEFAULT_BUDGET;
  private lastCost: JobberCostExtension | null = null;
  private lastUpdatedAt: number;
  private requestAttempts: Array<{ id: number; at: number }> = [];
  private importedAttemptIds = new Set<number>();
  private admissionId = 0;
  private reservations = new Map<number, number>();
  private cooldownUntil = 0;
  // Serializes checkBudget calls on this governor: without this, two concurrent callers can
  // both read the same pre-wait currentlyAvailable, each independently wait, and each credit
  // itself as if its own wait were the only one - conjuring budget that only a single wait
  // window actually justifies. Chaining onto this queue ensures one call's full check-wait-
  // reserve sequence completes before the next one's begins.
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly sleepFn: (ms: number, signal?: AbortSignal) => Promise<void> = defaultSleep,
    private readonly now: () => number = Date.now
  ) {
    this.lastUpdatedAt = this.now();
  }

  /** Credits budget for time elapsed since the last update, without exceeding maximumAvailable. */
  private applyElapsedRefill(): void {
    const nowMs = this.now();
    const elapsedMs = Math.max(0, nowMs - this.lastUpdatedAt);
    if (elapsedMs > 0) {
      this.currentlyAvailable = Math.min(
        this.maximumAvailable,
        this.currentlyAvailable + (elapsedMs / 1000) * this.restoreRate
      );
    }
    this.lastUpdatedAt = nowMs;
  }

  /** Prunes request timestamps older than the 5-minute window and throws if the ceiling is already reached. */
  private requestRateRetryAt(): number | undefined {
    const nowMs = this.now();
    const cutoff = nowMs - REQUEST_WINDOW_MS;
    while (this.requestAttempts.length > 0 && this.requestAttempts[0].at < cutoff) {
      const expired=this.requestAttempts.shift()!;
      this.importedAttemptIds.delete(expired.id);
    }
    if (this.requestAttempts.length >= REQUEST_CEILING) return this.requestAttempts[0].at + REQUEST_WINDOW_MS;
    return undefined;
  }

  /** How long a caller would need to wait for `maxCost` budget to refill, given current state. */
  backoffMsFor(maxCost: number): number {
    const deficit = Math.max(0, maxCost - this.currentlyAvailable);
    return (deficit / this.restoreRate) * 1000;
  }

  /**
   * Called when Jobber signals THROTTLED without an extensions.cost payload - stale optimistic
   * state can't be trusted, so treat the budget as exhausted rather than retrying instantly.
   */
  assumeDepleted(): void {
    this.currentlyAvailable = 0;
    this.lastUpdatedAt = this.now();
  }

  deferUntil(timestamp: number): void {
    if (Number.isFinite(timestamp)) this.cooldownUntil = Math.max(this.cooldownUntil, timestamp);
  }

  getCooldownUntil(): number { return this.cooldownUntil; }

  /** Restores budget reserved by checkBudget for a request that never got a real recordCost update. */
  releaseReservation(amount: number): void {
    this.currentlyAvailable = Math.min(this.maximumAvailable, this.currentlyAvailable + amount);
  }

  /**
   * Ensures at least `maxCost` budget is available before a request is sent, then reserves it
   * (decrements currentlyAvailable) so concurrent callers on the same governor don't all pass the
   * check against the same stale reading. The reservation is a conservative placeholder: a
   * subsequent recordCost() from the real response overwrites currentlyAvailable outright, so it
   * self-corrects the instant real data arrives. Waits for the refill if it will take 5s or less;
   * otherwise throws immediately rather than hanging the tool call.
   */
  async checkBudget(maxCost: number): Promise<void> {
    const id = await this.admit(maxCost);
    this.settleAdmission(id);
  }

  /** Admit and reserve one real HTTP attempt. A response without a cost payload settles
   * the reservation as spent; only a request cancelled before dispatch may release it. */
  async admit(maxCost: number, control: AdmissionControl = {}): Promise<number> {
    const run = this.queue.then(() => this.checkBudgetSerialized(maxCost, control));
    // Keep the queue alive even if this call throws/rejects, so a failed caller doesn't
    // permanently wedge every subsequent call behind a rejected promise.
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async checkBudgetSerialized(maxCost: number, control: AdmissionControl): Promise<number> {
    if (!Number.isFinite(maxCost) || maxCost < 0) throw new RangeError("maxCost must be a finite non-negative number");
    if (maxCost > this.maximumAvailable) {
      throw new BudgetUnavailableError(
        Math.max(1, Math.ceil((maxCost - this.maximumAvailable) / this.restoreRate)),
        this.now() + Math.max(1, (maxCost - this.maximumAvailable) / this.restoreRate) * 1000,
        "budget_refilling"
      );
    }
    const waitStartedAt = this.now();
    for (;;) {
      if (control.signal?.aborted) throw control.signal.reason ?? new Error("Request cancelled");
      this.applyElapsedRefill();
      const now = this.now();
      const requestRetryAt = this.requestRateRetryAt();
      if (requestRetryAt) throw new RequestRateLimitError(Math.max(1, Math.ceil((requestRetryAt - now) / 1000)), requestRetryAt);
      const budgetWait = this.backoffMsFor(maxCost);
      const cooldownWait = Math.max(0, this.cooldownUntil - now);
      const waitMs = Math.max(budgetWait, cooldownWait);
      if (waitMs <= 0) break;
      const retryAt = now + waitMs;
      if (control.deadlineAt !== undefined && retryAt >= control.deadlineAt) {
        const seconds = Math.max(1, Math.ceil((retryAt - now) / 1000));
        throw new BudgetUnavailableError(seconds, retryAt, cooldownWait >= budgetWait ? "provider_throttled" : "budget_refilling");
      }
      if (waitMs > MAX_WAIT_MS) {
        const seconds = Math.max(1, Math.ceil(waitMs / 1000));
        throw new BudgetUnavailableError(seconds, retryAt, cooldownWait >= budgetWait ? "provider_throttled" : "budget_refilling");
      }
      await this.sleepFn(Math.ceil(waitMs), control.signal);
      if (this.now() - waitStartedAt >= MAX_WAIT_MS) {
        this.applyElapsedRefill();
        const remaining = Math.max(this.backoffMsFor(maxCost), this.cooldownUntil - this.now());
        if (remaining > 0) {
          const retryAt = this.now() + remaining;
          throw new BudgetUnavailableError(Math.max(1, Math.ceil(remaining / 1000)), retryAt);
        }
      }
    }
    if (control.signal?.aborted) throw control.signal.reason ?? new Error("Request cancelled");
    if (control.deadlineAt !== undefined && this.now() >= control.deadlineAt) throw new BudgetUnavailableError(1, this.now() + 1000);
    this.currentlyAvailable -= maxCost;
    this.requestAttempts.push({ id: nextAttemptIdentity++, at: this.now() });
    const id = ++this.admissionId;
    this.reservations.set(id, maxCost);
    return id;
  }

  /** The attempt reached the provider or its outcome is unknown; keep its reservation spent. */
  settleAdmission(id: number): void { this.reservations.delete(id); }

  /** Release only when cancellation is known to have happened before fetch dispatch. */
  releaseAdmission(id: number): void {
    const amount = this.reservations.get(id);
    if (amount === undefined) return;
    this.reservations.delete(id);
    this.releaseReservation(amount);
  }

  /** Carry the first account-resolution request's observations into the shared account bucket. */
  seedFrom(other: CostGovernor): void {
    this.applyElapsedRefill();
    other.applyElapsedRefill();
    this.restoreRate = Math.min(this.restoreRate, other.restoreRate);
    this.maximumAvailable = Math.min(this.maximumAvailable, other.maximumAvailable);
    const outstanding = [...this.reservations.values()].reduce((sum, amount) => sum + amount, 0);
    this.currentlyAvailable = Math.min(this.currentlyAvailable, other.currentlyAvailable - outstanding, this.maximumAvailable);
    this.lastUpdatedAt = Math.max(this.lastUpdatedAt, other.lastUpdatedAt);
    for (const attempt of other.requestAttempts) {
      if (attempt.at >= this.now() - REQUEST_WINDOW_MS && !this.importedAttemptIds.has(attempt.id)) {
        this.requestAttempts.push(attempt);
        this.importedAttemptIds.add(attempt.id);
      }
    }
    this.requestAttempts.sort((a,b)=>a.at-b.at || a.id-b.id);
    this.cooldownUntil = Math.max(this.cooldownUntil, other.cooldownUntil);
  }

  /** Updates tracked budget state from a GraphQL response's extensions.cost. Ignores malformed payloads. */
  recordCost(cost: JobberCostExtension, responseAdmissionId?: number): void {
    const parsed = CostExtensionSchema.safeParse(cost);
    if (!parsed.success) {
      console.error("[cost-governor] Ignoring malformed extensions.cost from Jobber:", parsed.error.message);
      return;
    }
    this.applyElapsedRefill();
    // Reservation estimates include every in-flight and completed attempt. Never let an
    // out-of-order provider snapshot raise that conservative estimate; refill does that safely.
    const siblingReservations = [...this.reservations.entries()]
      .filter(([id]) => id !== responseAdmissionId)
      .reduce((total, [, amount]) => total + amount, 0);
    this.currentlyAvailable = Math.min(
      this.currentlyAvailable,
      Math.max(0, parsed.data.throttleStatus.currentlyAvailable - siblingReservations),
      parsed.data.throttleStatus.maximumAvailable
    );
    this.restoreRate = parsed.data.throttleStatus.restoreRate;
    this.maximumAvailable = parsed.data.throttleStatus.maximumAvailable;
    this.lastUpdatedAt = this.now();
    this.lastCost = cost;
  }

  getState(): JobberThrottleStatus {
    return {
      currentlyAvailable: this.currentlyAvailable,
      restoreRate: this.restoreRate,
      maximumAvailable: this.maximumAvailable,
    };
  }

  /** The most recent response's full cost extension - used by scripts/measure-costs.mjs. */
  getLastCost(): JobberCostExtension | null {
    return this.lastCost;
  }
}

let nextAttemptIdentity = 0;
