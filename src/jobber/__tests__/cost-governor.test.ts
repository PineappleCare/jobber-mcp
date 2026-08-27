import { describe, it, expect, vi, afterEach } from "vitest";
import { CostGovernor, BudgetUnavailableError, RequestRateLimitError } from "../cost-governor.js";

/** A controllable clock for deterministic elapsed-time-refill and request-rate-ceiling tests. */
function fakeClock(start = 0) {
  let current = start;
  return {
    now: () => current,
    advance: (ms: number) => {
      current += ms;
    },
  };
}

describe("CostGovernor", () => {
  describe("normal cost tracking", () => {
    it("starts with the documented default budget (10000 @ 500/s)", () => {
      const governor = new CostGovernor();
      expect(governor.getState()).toEqual({
        currentlyAvailable: 10000,
        restoreRate: 500,
        maximumAvailable: 10000,
      });
    });

    it("recordCost updates currentlyAvailable/restoreRate/maximumAvailable from a response", () => {
      const governor = new CostGovernor();
      governor.recordCost({
        requestedQueryCost: 220,
        actualQueryCost: 183,
        throttleStatus: { maximumAvailable: 10000, currentlyAvailable: 8213, restoreRate: 500 },
      });
      expect(governor.getState()).toEqual({
        currentlyAvailable: 8213,
        restoreRate: 500,
        maximumAvailable: 10000,
      });
    });

    it("getLastCost returns null before any recordCost call", () => {
      expect(new CostGovernor().getLastCost()).toBeNull();
    });

    it("getLastCost returns the full extension from the most recent recordCost call", () => {
      const governor = new CostGovernor();
      const cost = {
        requestedQueryCost: 220,
        actualQueryCost: 183,
        throttleStatus: { maximumAvailable: 10000, currentlyAvailable: 8213, restoreRate: 500 },
      };
      governor.recordCost(cost);
      expect(governor.getLastCost()).toEqual(cost);
    });
  });

  describe("checkBudget - enough budget available", () => {
    it("returns immediately without sleeping when budget already covers maxCost", async () => {
      const sleepFn = vi.fn().mockResolvedValue(undefined);
      const governor = new CostGovernor(sleepFn);
      await governor.checkBudget(500);
      expect(sleepFn).not.toHaveBeenCalled();
    });
  });

  describe("checkBudget - refill wait math (<=5s)", () => {
    it("waits (needed - available) / restoreRate seconds, converted to ms", async () => {
      const clock = fakeClock();
      const sleepFn = vi.fn().mockResolvedValue(undefined);
      const governor = new CostGovernor(sleepFn, clock.now);
      governor.recordCost({
        requestedQueryCost: 0,
        actualQueryCost: 0,
        throttleStatus: { maximumAvailable: 10000, currentlyAvailable: 100, restoreRate: 500 },
      });
      // need 600, have 100 → (600-100)/500 = 1s = 1000ms
      await governor.checkBudget(600);
      expect(sleepFn).toHaveBeenCalledWith(1000);
    });

    it("reserves the requested maxCost after waiting out the refill", async () => {
      const clock = fakeClock();
      const sleepFn = vi.fn().mockResolvedValue(undefined);
      const governor = new CostGovernor(sleepFn, clock.now);
      governor.recordCost({
        requestedQueryCost: 0,
        actualQueryCost: 0,
        throttleStatus: { maximumAvailable: 10000, currentlyAvailable: 100, restoreRate: 500 },
      });
      await governor.checkBudget(600);
      // Refilled to 600 (100 + 1s*500), then the requested 600 is reserved immediately.
      expect(governor.getState().currentlyAvailable).toBe(0);
    });
  });

  describe("checkBudget - first call on a fresh governor", () => {
    it("waits out a deficit against the default budget/restore rate without any prior recordCost", async () => {
      const clock = fakeClock();
      const sleepFn = vi.fn().mockResolvedValue(undefined);
      const governor = new CostGovernor(sleepFn, clock.now);
      // Default budget is 10000 @ 500/s - asking for 10001 on the very first call (no
      // recordCost/assumeDepleted priming) needs a 2ms wait, well under the 5s cap.
      await governor.checkBudget(10001);
      expect(sleepFn).toHaveBeenCalledWith(2);
      // The post-wait credit is clamped to maximumAvailable (10000) before the requested 10001
      // is subtracted, so asking for more than the account's absolute ceiling in one call leaves
      // the balance transiently negative rather than reaching the full requested amount.
      expect(governor.getState().currentlyAvailable).toBe(-1);
    });
  });

  describe("checkBudget - long wait rejection (>5s)", () => {
    it("throws BudgetUnavailableError immediately without sleeping when the wait exceeds 5s", async () => {
      const clock = fakeClock();
      const sleepFn = vi.fn().mockResolvedValue(undefined);
      const governor = new CostGovernor(sleepFn, clock.now);
      governor.recordCost({
        requestedQueryCost: 0,
        actualQueryCost: 0,
        throttleStatus: { maximumAvailable: 10000, currentlyAvailable: 0, restoreRate: 500 },
      });
      // need 3000, have 0 → 3000/500 = 6s > 5s cap
      await expect(governor.checkBudget(3000)).rejects.toThrow(BudgetUnavailableError);
      expect(sleepFn).not.toHaveBeenCalled();
    });

    it("error message reports the wait in whole seconds", async () => {
      const clock = fakeClock();
      const governor = new CostGovernor(vi.fn().mockResolvedValue(undefined), clock.now);
      governor.recordCost({
        requestedQueryCost: 0,
        actualQueryCost: 0,
        throttleStatus: { maximumAvailable: 10000, currentlyAvailable: 0, restoreRate: 500 },
      });
      await expect(governor.checkBudget(3000)).rejects.toThrow("API budget refilling, try again in 6s");
    });

    it("treats exactly 5s as within budget (boundary - waits, does not throw)", async () => {
      const clock = fakeClock();
      const sleepFn = vi.fn().mockResolvedValue(undefined);
      const governor = new CostGovernor(sleepFn, clock.now);
      governor.recordCost({
        requestedQueryCost: 0,
        actualQueryCost: 0,
        throttleStatus: { maximumAvailable: 10000, currentlyAvailable: 0, restoreRate: 500 },
      });
      // need 2500, have 0 → 2500/500 = 5s exactly
      await expect(governor.checkBudget(2500)).resolves.toBeUndefined();
      expect(sleepFn).toHaveBeenCalledWith(5000);
    });
  });

  describe("recordCost - validation", () => {
    it("ignores a cost payload with a missing throttleStatus and leaves state unchanged", () => {
      const governor = new CostGovernor();
      const before = governor.getState();
      // @ts-expect-error - deliberately malformed to test validation
      governor.recordCost({ requestedQueryCost: 1, actualQueryCost: 1 });
      expect(governor.getState()).toEqual(before);
    });

    it("ignores a cost payload with a non-finite currentlyAvailable and leaves state unchanged", () => {
      const governor = new CostGovernor();
      const before = governor.getState();
      governor.recordCost({
        requestedQueryCost: 1,
        actualQueryCost: 1,
        throttleStatus: { maximumAvailable: 10000, currentlyAvailable: NaN, restoreRate: 500 },
      });
      expect(governor.getState()).toEqual(before);
    });

    it("ignores a cost payload with a zero or negative restoreRate and leaves state unchanged", () => {
      const governor = new CostGovernor();
      const before = governor.getState();
      governor.recordCost({
        requestedQueryCost: 1,
        actualQueryCost: 1,
        throttleStatus: { maximumAvailable: 10000, currentlyAvailable: 5000, restoreRate: -500 },
      });
      expect(governor.getState()).toEqual(before);
    });

    it("ignores a cost payload with a restoreRate of exactly zero and leaves state unchanged", () => {
      const governor = new CostGovernor();
      const before = governor.getState();
      governor.recordCost({
        requestedQueryCost: 1,
        actualQueryCost: 1,
        throttleStatus: { maximumAvailable: 10000, currentlyAvailable: 5000, restoreRate: 0 },
      });
      expect(governor.getState()).toEqual(before);
    });

    it("ignores a cost payload with a non-finite restoreRate and leaves state unchanged", () => {
      const governor = new CostGovernor();
      const before = governor.getState();
      governor.recordCost({
        requestedQueryCost: 1,
        actualQueryCost: 1,
        throttleStatus: { maximumAvailable: 10000, currentlyAvailable: 5000, restoreRate: NaN },
      });
      expect(governor.getState()).toEqual(before);
    });

    it("accepts a well-formed cost payload", () => {
      const governor = new CostGovernor();
      governor.recordCost({
        requestedQueryCost: 1,
        actualQueryCost: 1,
        throttleStatus: { maximumAvailable: 10000, currentlyAvailable: 5000, restoreRate: 500 },
      });
      expect(governor.getState().currentlyAvailable).toBe(5000);
    });
  });

  describe("elapsed-time refill", () => {
    it("credits budget for time elapsed since the last update, even with no explicit wait", async () => {
      const clock = fakeClock();
      const sleepFn = vi.fn().mockResolvedValue(undefined);
      const governor = new CostGovernor(sleepFn, clock.now);
      governor.recordCost({
        requestedQueryCost: 0,
        actualQueryCost: 0,
        throttleStatus: { maximumAvailable: 10000, currentlyAvailable: 100, restoreRate: 500 },
      });
      // 2 seconds pass with no requests in between - 2s * 500/s = 1000 should be credited.
      clock.advance(2000);
      await governor.checkBudget(500);
      expect(sleepFn).not.toHaveBeenCalled();
      // 100 + 1000 refill - 500 reserved = 600
      expect(governor.getState().currentlyAvailable).toBe(600);
    });

    it("does not refill past maximumAvailable", async () => {
      const clock = fakeClock();
      const governor = new CostGovernor(vi.fn().mockResolvedValue(undefined), clock.now);
      governor.recordCost({
        requestedQueryCost: 0,
        actualQueryCost: 0,
        throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 900, restoreRate: 500 },
      });
      clock.advance(10_000); // would refill 5000, far more than the 100 headroom
      await governor.checkBudget(1);
      expect(governor.getState().currentlyAvailable).toBe(999);
    });
  });

  describe("reservation", () => {
    it("accounts for a prior checkBudget's reservation when a second call runs before any recordCost", async () => {
      const clock = fakeClock();
      const sleepFn = vi.fn().mockResolvedValue(undefined);
      const governor = new CostGovernor(sleepFn, clock.now);
      governor.recordCost({
        requestedQueryCost: 0,
        actualQueryCost: 0,
        throttleStatus: { maximumAvailable: 10000, currentlyAvailable: 1000, restoreRate: 500 },
      });
      await governor.checkBudget(600); // reserves 600, leaving 400
      expect(governor.getState().currentlyAvailable).toBe(400);

      // A second concurrent call for 600 more should see only 400 available, not the stale 1000.
      await governor.checkBudget(600);
      // need 600, have 400 → (600-400)/500 = 400ms wait
      expect(sleepFn).toHaveBeenCalledWith(400);
    });

    it("releaseReservation restores budget without exceeding maximumAvailable", () => {
      const governor = new CostGovernor();
      governor.recordCost({
        requestedQueryCost: 0,
        actualQueryCost: 0,
        throttleStatus: { maximumAvailable: 1000, currentlyAvailable: 900, restoreRate: 500 },
      });
      governor.releaseReservation(500);
      expect(governor.getState().currentlyAvailable).toBe(1000);
    });
  });

  describe("checkBudget - concurrent callers", () => {
    afterEach(() => {
      vi.useRealTimers();
    });

    it("serializes two concurrent calls instead of letting the second start before the first finishes", async () => {
      vi.useFakeTimers();
      // Real (faked) setTimeout + real (faked) Date.now - the point of this test is to observe
      // actual elapsed wall-clock time, not a hand-mocked sleepFn.
      const governor = new CostGovernor();
      governor.recordCost({
        requestedQueryCost: 0,
        actualQueryCost: 0,
        throttleStatus: { maximumAvailable: 10000, currentlyAvailable: 0, restoreRate: 500 },
      });

      let p1Resolved = false;
      let p2Resolved = false;
      const p1 = governor.checkBudget(100).then(() => {
        p1Resolved = true;
      });
      const p2 = governor.checkBudget(100).then(() => {
        p2Resolved = true;
      });

      // Both need 100 with nothing available, so each individually needs a 200ms wait. If the
      // second caller's check ran off the same stale currentlyAvailable=0 reading instead of
      // waiting for the first to actually finish reserving its share, it would also resolve by
      // t=200ms - letting two 100-cost requests through in a window the real budget can only
      // support one of.
      await vi.advanceTimersByTimeAsync(200);
      expect(p1Resolved).toBe(true);
      expect(p2Resolved).toBe(false);

      await vi.advanceTimersByTimeAsync(200);
      expect(p2Resolved).toBe(true);

      await Promise.all([p1, p2]);
      expect(governor.getState().currentlyAvailable).toBe(0);
    });
  });

  describe("assumeDepleted / backoffMsFor", () => {
    it("assumeDepleted zeroes currentlyAvailable", () => {
      const governor = new CostGovernor();
      governor.assumeDepleted();
      expect(governor.getState().currentlyAvailable).toBe(0);
    });

    it("backoffMsFor computes the same wait math as checkBudget's internal refill wait", () => {
      const governor = new CostGovernor();
      governor.recordCost({
        requestedQueryCost: 0,
        actualQueryCost: 0,
        throttleStatus: { maximumAvailable: 10000, currentlyAvailable: 100, restoreRate: 500 },
      });
      expect(governor.backoffMsFor(600)).toBe(1000);
    });

    it("backoffMsFor is zero when enough budget is already available", () => {
      const governor = new CostGovernor();
      expect(governor.backoffMsFor(500)).toBe(0);
    });
  });

  describe("request-rate ceiling (2500 per 5 minutes)", () => {
    it("throws RequestRateLimitError on the 2501st admission within the window", async () => {
      const clock = fakeClock();
      const governor = new CostGovernor(vi.fn().mockResolvedValue(undefined), clock.now);
      for (let i = 0; i < 2500; i++) {
        await governor.checkBudget(1);
        clock.advance(1); // stay well within the 5-minute window
      }
      await expect(governor.checkBudget(1)).rejects.toThrow(RequestRateLimitError);
    });

    it("admits a new request once the oldest timestamp ages out of the 5-minute window", async () => {
      const clock = fakeClock();
      const governor = new CostGovernor(vi.fn().mockResolvedValue(undefined), clock.now);
      for (let i = 0; i < 2500; i++) {
        await governor.checkBudget(1);
      }
      clock.advance(5 * 60 * 1000 + 1); // age every prior timestamp out of the window
      await expect(governor.checkBudget(1)).resolves.toBeUndefined();
    });
  });
});
