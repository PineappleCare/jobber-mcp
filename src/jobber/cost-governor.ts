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
  constructor(waitSeconds: number) {
    super(`API budget refilling, try again in ${waitSeconds}s`);
    this.name = "BudgetUnavailableError";
  }
}

export class RequestRateLimitError extends Error {
  constructor(waitSeconds: number) {
    super(`Request rate limit (2500 per 5 minutes) reached, try again in ${waitSeconds}s`);
    this.name = "RequestRateLimitError";
  }
}

const MAX_WAIT_MS = 5000;
const DEFAULT_BUDGET = 10000;
const DEFAULT_RESTORE_RATE = 500;
const REQUEST_WINDOW_MS = 5 * 60 * 1000;
const REQUEST_CEILING = 2500;

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  private requestTimestamps: number[] = [];
  // Serializes checkBudget calls on this governor: without this, two concurrent callers can
  // both read the same pre-wait currentlyAvailable, each independently wait, and each credit
  // itself as if its own wait were the only one - conjuring budget that only a single wait
  // window actually justifies. Chaining onto this queue ensures one call's full check-wait-
  // reserve sequence completes before the next one's begins.
  private queue: Promise<void> = Promise.resolve();

  constructor(
    private readonly sleepFn: (ms: number) => Promise<void> = defaultSleep,
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
  private enforceRequestRateCeiling(): void {
    const nowMs = this.now();
    const cutoff = nowMs - REQUEST_WINDOW_MS;
    while (this.requestTimestamps.length > 0 && this.requestTimestamps[0] < cutoff) {
      this.requestTimestamps.shift();
    }
    if (this.requestTimestamps.length >= REQUEST_CEILING) {
      const retryInMs = this.requestTimestamps[0] + REQUEST_WINDOW_MS - nowMs;
      throw new RequestRateLimitError(Math.max(1, Math.ceil(retryInMs / 1000)));
    }
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
    const run = this.queue.then(() => this.checkBudgetSerialized(maxCost));
    // Keep the queue alive even if this call throws/rejects, so a failed caller doesn't
    // permanently wedge every subsequent call behind a rejected promise.
    this.queue = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  private async checkBudgetSerialized(maxCost: number): Promise<void> {
    this.enforceRequestRateCeiling();
    this.applyElapsedRefill();

    if (this.currentlyAvailable < maxCost) {
      const waitMs = this.backoffMsFor(maxCost);

      if (waitMs > MAX_WAIT_MS) {
        throw new BudgetUnavailableError(Math.ceil(waitMs / 1000));
      }

      await this.sleepFn(waitMs);
      this.currentlyAvailable = Math.min(
        this.maximumAvailable,
        this.currentlyAvailable + (waitMs / 1000) * this.restoreRate
      );
      this.lastUpdatedAt = this.now();
    }

    this.currentlyAvailable -= maxCost;
    this.requestTimestamps.push(this.now());
  }

  /** Updates tracked budget state from a GraphQL response's extensions.cost. Ignores malformed payloads. */
  recordCost(cost: JobberCostExtension): void {
    const parsed = CostExtensionSchema.safeParse(cost);
    if (!parsed.success) {
      console.error("[cost-governor] Ignoring malformed extensions.cost from Jobber:", parsed.error.message);
      return;
    }
    this.currentlyAvailable = parsed.data.throttleStatus.currentlyAvailable;
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
