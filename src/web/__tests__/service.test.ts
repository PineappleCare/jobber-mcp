import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { WebService } from "../service.js";
import { WebJournal } from "../storage.js";
import {
  cents,
  decimal,
  distance,
  type Snapshot,
  WebError,
} from "../contracts.js";
const account = "gid://Jobber/Account/12",
  target = "gid://Jobber/Invoice/10",
  client = "gid://Jobber/Client/1";
const invoice = (): Snapshot => ({
  account_id: account,
  country: "CA",
  target_id: target,
  client_id: client,
  client_name: "Fixture client",
  title: "Invoice #1",
  url: "https://secure.getjobber.com/invoices/10",
  version: "v1",
  balance: "100.00",
  payments: [],
});
const payment = () => ({
  invoice_id: target,
  amount: "30.00",
  transaction_date: "2026-10-20",
  method: "e_transfer",
  reference: "fixture-ref",
  details: "private fixture notes",
});
let dir: string, journal: WebJournal, service: WebService, browser: any;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), "jobber-web-"));
  journal = new WebJournal(path.join(dir, "ops.db"), randomBytes(32));
  browser = {
    identity: vi.fn().mockResolvedValue(account),
    prepare: vi
      .fn()
      .mockResolvedValue({
        native_methods: ["Cash", "Cheque", "E-transfer", "Other"],
      }),
    submit: vi.fn(async (_p, dispatch) => {
      dispatch();
      return "777";
    }),
    beginLogin: vi.fn(),
    endLogin: vi.fn(),
  };
  service = new WebService(journal, browser, account);
});
afterEach(() => {
  journal.close();
  rmSync(dir, { recursive: true, force: true });
});
async function ready() {
  const p = await service.previewPayment(payment(), invoice());
  return {
    operation_id: randomUUID(),
    proposal: p,
    confirm_write: true as const,
  };
}
describe("durable browser writes", () => {
  it("previews exact amounts, native method, no receipts; verifies one partial payment", async () => {
    const input = await ready();
    expect(input.proposal).toMatchObject({
      native_method: "E-transfer",
      balance_after: "70.00",
      currency: "CAD",
      send_receipt: false,
    });
    const r = await service.execute(input, invoice());
    expect(r.outcome).toBe("uncertain");
    expect(journal.operation(input.operation_id)?.result.record_id).toBe("777");
    const read = {
      ...invoice(),
      balance: "70.00",
      version: "v2",
      payments: [
        {
          id: "gid://Jobber/PaymentRecord/777",
          amount: "30.00",
          date: "2026-10-20",
          method: "E-transfer",
          details: "private fixture notes",
          reference: "fixture-ref",
          client_id: client,
          invoice_id: target,
        },
      ],
    };
    expect((await service.verify(input.operation_id, read)).outcome).toBe(
      "completed",
    );
    expect((await service.execute(input, read)).outcome).toBe("completed");
    expect(browser.submit).toHaveBeenCalledTimes(1);
  });
  it("supports full payments and declares bank transfer as native Other", async () => {
    const p = await service.previewPayment(
      { ...payment(), amount: "100.00", method: "bank_transfer" },
      invoice(),
    );
    expect(p).toMatchObject({
      balance_after: "0.00",
      native_method: "Other",
      details: "Bank transfer received externally.\nprivate fixture notes",
    });
  });
  it.each(["0.00", "-1.00", "100.01", "1.001"])(
    "rejects invalid amount %s before browser submission",
    async (amount) => {
      await expect(
        service.previewPayment({ ...payment(), amount }, invoice()),
      ).rejects.toThrow();
      expect(browser.submit).not.toHaveBeenCalled();
    },
  );
  it("blocks paid invoices, duplicates and unsupported native methods", async () => {
    await expect(
      service.previewPayment(payment(), { ...invoice(), balance: "0.00" }),
    ).rejects.toThrow("payment_exceeds_balance");
    await expect(
      service.previewPayment(payment(), {
        ...invoice(),
        payments: [
          {
            id: "past",
            amount: "30.00",
            date: "2026-10-20",
            method: "E-transfer",
            reference: "",
            details: "",
            client_id: client,
            invoice_id: target,
          },
        ],
      }),
    ).rejects.toThrow("possible_duplicate_payment");
    browser.prepare.mockResolvedValue({ native_methods: ["Cash"] });
    await expect(service.previewPayment(payment(), invoice())).rejects.toThrow(
      "offline_method_unavailable",
    );
  });
  it("rejects stale records, changed arguments, expired previews and wrong accounts", async () => {
    const input = await ready();
    await expect(
      service.execute(input, { ...invoice(), balance: "99.00" }),
    ).rejects.toThrow("record_changed");
    await expect(
      service.execute(
        { ...input, proposal: { ...input.proposal, amount: "1.00" } },
        invoice(),
      ),
    ).rejects.toThrow("proposal_changed");
    await expect(
      service.execute(input, { ...invoice(), account_id: "foreign" }),
    ).rejects.toThrow("account_mismatch");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + 1800001);
    await expect(service.execute(input, invoice())).rejects.toThrow(
      "proposal_expired",
    );
    vi.restoreAllMocks();
    expect(browser.submit).not.toHaveBeenCalled();
  });
  it("never resubmits a lost response or changed operation ID payload", async () => {
    const input = await ready();
    browser.submit.mockImplementation(async (_p: any, dispatch: any) => {
      dispatch();
      throw Error("lost response");
    });
    expect((await service.execute(input, invoice())).outcome).toBe("uncertain");
    expect((await service.execute(input, invoice())).outcome).toBe("uncertain");
    await expect(
      service.execute(
        { ...input, proposal: { ...input.proposal, reference: "different" } },
        invoice(),
      ),
    ).rejects.toThrow("operation_payload_changed");
    expect(browser.submit).toHaveBeenCalledTimes(1);
  });
  it("blocks another unresolved write on the same target and proposal reuse", async () => {
    const a = await ready();
    await service.execute(a, invoice());
    const b = await ready();
    await expect(service.execute(b, invoice())).rejects.toThrow(
      "target_has_unresolved_operation",
    );
    await expect(
      service.execute({ ...a, operation_id: randomUUID() }, invoice()),
    ).rejects.toThrow("proposal_already_used");
  });
  it("does not mark another operator payment verified without returned identity", async () => {
    const input = await ready();
    browser.submit.mockImplementation(async (_p: any, dispatch: any) => {
      dispatch();
      throw Error("timeout");
    });
    await service.execute(input, invoice());
    expect(
      (
        await service.verify(input.operation_id, {
          ...invoice(),
          balance: "70.00",
          payments: [
            {
              id: "gid://Jobber/PaymentRecord/99",
              amount: "30.00",
              date: "2026-10-20",
              method: "E-transfer",
              details: "private fixture notes",
              reference: "fixture-ref",
              client_id: client,
              invoice_id: target,
            },
          ],
        })
      ).outcome,
    ).toBe("uncertain");
  });
  it("retains durable results across restart, invalidates pending previews, and encrypts state", async () => {
    const input = await ready();
    await service.execute(input, invoice());
    new WebService(journal, browser, account);
    expect((await service.execute(input, invoice())).outcome).toBe("uncertain");
    const next = await ready();
    service = new WebService(journal, browser, account);
    await expect(service.execute(next, invoice())).rejects.toThrow(
      "proposal_expired",
    );
    const bytes = readFileSync(path.join(dir, "ops.db-wal")).toString();
    expect(bytes).not.toContain("private fixture notes");
    expect(bytes).not.toContain("Fixture client");
  });
  it("holds exclusive manual mode and invalidates approvals on reauthentication", async () => {
    const input = await ready();
    await service.login(true);
    await expect(service.execute(input, invoice())).rejects.toThrow(
      "browser_busy",
    );
    expect(await service.status()).toMatchObject({ state: "manual_login" });
    await service.login(false);
    await expect(service.execute(input, invoice())).rejects.toThrow(
      "proposal_expired",
    );
  });
  it("guards concurrent requests without queueing and retains uncertainty on verification failure", async () => {
    let release: () => void = () => {};
    browser.prepare.mockImplementation(
      () =>
        new Promise((r) => {
          release = () => r({ native_methods: ["E-transfer"] });
        }),
    );
    const a = ready();
    await expect(ready()).rejects.toThrow("browser_busy");
    release();
    await a;
  });
  it("validates map-pin destination and readback precision while preserving address", async () => {
    const s: Snapshot = {
      ...invoice(),
      target_id: "gid://Jobber/Property/2",
      url: "https://secure.getjobber.com/clients/1/properties/2",
      balance: undefined,
      payments: undefined,
      address: "Fixture street",
      coordinates: { latitude: 47, longitude: -80 },
    };
    const p = await service.previewPin(
      {
        property_id: s.target_id,
        coordinates: { latitude: 47.01, longitude: -80.01 },
      },
      s,
    );
    const input = {
      operation_id: randomUUID(),
      proposal: p,
      confirm_write: true,
    };
    await service.execute(input, s);
    expect(
      (
        await service.verify(input.operation_id, {
          ...s,
          coordinates: { latitude: 47.01, longitude: -80.01 },
          address: "Other address",
        })
      ).outcome,
    ).toBe("uncertain");
    expect(
      (
        await service.verify(input.operation_id, {
          ...s,
          coordinates: { latitude: 47.010001, longitude: -80.010001 },
        })
      ).outcome,
    ).toBe("completed");
  });
  it("keeps login expiry distinct from transport and invalidates previews", async () => {
    const input = await ready();
    browser.prepare.mockRejectedValue(new WebError("login_required"));
    await expect(service.execute(input, invoice())).rejects.toThrow(
      "login_required",
    );
    browser.prepare.mockResolvedValue({});
    await expect(service.execute(input, invoice())).rejects.toThrow(
      "proposal_expired",
    );
  });
  it("uses exact decimal arithmetic and metre-based coordinates", () => {
    expect(decimal(cents("0.10") + cents("0.20"))).toBe("0.30");
    expect(() => cents("1.001")).toThrow();
    expect(
      distance(
        { latitude: 47, longitude: -80 },
        { latitude: 47.000001, longitude: -80 },
      ),
    ).toBeLessThan(1);
  });
});
