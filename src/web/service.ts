import { randomUUID } from "node:crypto";
import { type BrowserPort, nativeId } from "./browser.js";
import { WebJournal } from "./storage.js";
import {
  cents,
  decimal,
  digest,
  distance,
  execution,
  paymentInput,
  pinInput,
  snapshot,
  type Execution,
  type Proposal,
  type Result,
  type Snapshot,
  WebError,
} from "./contracts.js";
import { resolveMaps } from "./maps.js";
export class WebService {
  private busy = false;
  private manual = false;
  private epoch: string;
  constructor(
    private journal: WebJournal,
    private browser: BrowserPort,
    private account: string,
    private resolve = resolveMaps,
  ) {
    this.epoch = journal.rotateEpoch();
  }
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.busy || this.manual) throw new WebError("browser_busy");
    this.busy = true;
    try {
      return await fn();
    } catch (e) {
      if (e instanceof WebError && e.code === "login_required")
        this.epoch = this.journal.rotateEpoch();
      throw e;
    } finally {
      this.busy = false;
    }
  }
  private check(s: Snapshot): void {
    if (s.account_id !== this.account || s.country !== "CA")
      throw new WebError("account_mismatch");
  }
  private checkProposal(p: Proposal): void {
    if (
      p.account_id !== this.account ||
      p.auth_epoch !== this.epoch ||
      p.expires_at <= Date.now()
    )
      throw new WebError("proposal_expired");
  }
  async status(): Promise<any> {
    if (this.manual)
      return {
        state: "manual_login",
        supported: ["payments", "property_pins"],
      };
    if (this.busy)
      return { state: "busy", supported: ["payments", "property_pins"] };
    return this.exclusive(async () => {
      await this.browser.identity();
      return { state: "ready", supported: ["payments", "property_pins"] };
    });
  }
  async login(start: boolean): Promise<void> {
    if (start) {
      if (this.busy || this.manual) throw new WebError("browser_busy");
      this.manual = true;
      this.epoch = this.journal.rotateEpoch();
      try {
        await this.browser.beginLogin();
      } catch (e) {
        this.manual = false;
        throw e;
      }
    } else {
      if (!this.manual) throw new WebError("manual_login_not_active");
      await this.browser.endLogin();
      this.epoch = this.journal.rotateEpoch();
      this.manual = false;
    }
  }
  private common(s: Snapshot) {
    return {
      proposal_id: randomUUID(),
      auth_epoch: this.epoch,
      expires_at: Date.now() + 1800000,
      account_id: this.account,
      target_id: s.target_id,
      client_id: s.client_id,
      client_name: s.client_name,
      title: s.title,
      target_url: s.url,
      expected_version: s.version,
      expected_snapshot: digest(s),
    };
  }
  async previewPayment(raw: unknown, state: unknown): Promise<Proposal> {
    return this.exclusive(async () => {
      const input = paymentInput.parse(raw),
        s = snapshot.parse(state);
      this.check(s);
      if (
        input.invoice_id !== s.target_id ||
        s.balance === undefined ||
        !s.payments
      )
        throw new WebError("invalid_invoice_snapshot");
      const amount = cents(input.amount),
        balance = cents(s.balance);
      if (balance <= 0n || amount > balance)
        throw new WebError("payment_exceeds_balance");
      // A similar entry is a review requirement, even if it could be a legitimate second payment.
      if (
        s.payments.some(
          (p) =>
            cents(p.amount) === amount && p.date === input.transaction_date,
        )
      )
        throw new WebError("possible_duplicate_payment");
      const form = await this.browser.prepare(s);
      const method = {
        cash: "Cash",
        cheque: "Cheque",
        e_transfer: "E-transfer",
        bank_transfer: "Other",
        other: "Other",
      }[input.method] as "Cash" | "Cheque" | "E-transfer" | "Other";
      if (!form.native_methods?.includes(method))
        throw new WebError("offline_method_unavailable");
      const details = [
        input.method === "bank_transfer"
          ? "Bank transfer received externally."
          : "",
        input.details,
      ]
        .filter(Boolean)
        .join("\n");
      if (details.length > 2000) throw new WebError("payment_details_too_long");
      const p: Proposal = {
        ...this.common(s),
        action: "record_invoice_payment",
        amount: input.amount,
        currency: "CAD",
        transaction_date: input.transaction_date,
        method: input.method,
        native_method: method,
        reference: input.reference,
        details,
        balance_before: s.balance,
        balance_after: decimal(balance - amount),
        send_receipt: false,
      };
      this.journal.putProposal(p, s);
      return p;
    });
  }
  async previewPin(raw: unknown, state: unknown): Promise<Proposal> {
    return this.exclusive(async () => {
      const input = pinInput.parse(raw),
        s = snapshot.parse(state);
      this.check(s);
      if (
        input.property_id !== s.target_id ||
        s.address === undefined ||
        s.coordinates === undefined
      )
        throw new WebError("invalid_property_snapshot");
      const coords = input.coordinates ?? (await this.resolve(input.maps_url!));
      await this.browser.prepare(s);
      const p: Proposal = {
        ...this.common(s),
        action: "update_property_map_pin",
        address: s.address,
        before: s.coordinates,
        coordinates: coords,
        map_url: `https://www.google.com/maps/search/?api=1&query=${coords.latitude},${coords.longitude}`,
        source_url: input.maps_url ?? null,
      };
      this.journal.putProposal(p, s);
      return p;
    });
  }
  async execute(raw: unknown, state: unknown): Promise<Result> {
    return this.exclusive(async () => {
      const input = execution.parse(raw),
        p = input.proposal,
        s = snapshot.parse(state);
      this.check(s);
      const prior = this.journal.operation(input.operation_id);
      if (prior) {
        if (digest(prior.execution) !== digest(input))
          throw new WebError("operation_payload_changed");
        return prior.result;
      }
      const saved = this.journal.getProposal(p.proposal_id);
      if (digest(saved.proposal) !== digest(p))
        throw new WebError("proposal_changed");
      this.checkProposal(p);
      if (digest(s) !== p.expected_snapshot)
        throw new WebError("record_changed_repreview_required");
      await this.browser.prepare(s, p);
      let dispatched = false;
      try {
        const record = await this.browser.submit(p, () => {
          // Form preparation and the final account check can cross the deadline.
          // Revalidate immediately before recording dispatch intent and Save.
          this.checkProposal(p);
          this.journal.begin(input);
          dispatched = true;
        });
        if (!dispatched) throw new WebError("adapter_did_not_dispatch");
        const result: Result = {
          operation_id: input.operation_id,
          outcome: "uncertain",
          ...(record ? { record_id: record } : {}),
          reason: "readback_required",
        };
        this.journal.save(result);
        return result;
      } catch (e) {
        if (!dispatched) throw e;
        const result: Result = {
          operation_id: input.operation_id,
          outcome: "uncertain",
          reason: "submission_or_readback_uncertain",
        };
        this.journal.save(result);
        return result;
      }
    });
  }
  get(id: string): { execution: Execution; result: Result } {
    const saved = this.journal.operation(id);
    if (!saved || saved.execution.proposal.account_id !== this.account)
      throw new WebError("operation_not_found");
    return saved;
  }
  async verify(id: string, state: unknown): Promise<Result> {
    return this.exclusive(async () => {
      const saved = this.get(id);
      if (
        saved.result.outcome === "completed" ||
        saved.result.outcome === "rejected"
      )
        return saved.result;
      const s = snapshot.parse(state);
      this.check(s);
      await this.browser.identity();
      const p = saved.execution.proposal;
      if (s.target_id !== p.target_id || s.client_id !== p.client_id)
        throw new WebError("verification_target_mismatch");
      let verified = false,
        record: string | undefined = saved.result.record_id;
      if (p.action === "record_invoice_payment") {
        const baseline = this.journal.getProposal(p.proposal_id)
          .baseline as Snapshot;
        const old = new Set(baseline.payments!.map((v) => v.id));
        const matches = (s.payments ?? []).filter(
          (v) =>
            !old.has(v.id) &&
            cents(v.amount) === cents(p.amount) &&
            v.date === p.transaction_date &&
            v.method === p.native_method &&
            v.details === p.details &&
            v.reference === p.reference &&
            v.client_id === p.client_id &&
            v.invoice_id === p.target_id,
        );
        // Returned payment identity is essential: matching amount/date alone cannot attribute another operator's payment.
        if (
          record &&
          matches.length === 1 &&
          nativeId(matches[0].id) === record &&
          s.balance === p.balance_after
        ) {
          verified = true;
          record = matches[0].id;
        }
      } else
        verified =
          !!s.coordinates &&
          s.address === p.address &&
          distance(p.coordinates, s.coordinates) <= 1;
      const result: Result = {
        operation_id: id,
        outcome: verified ? "completed" : "uncertain",
        ...(record ? { record_id: record } : {}),
        ...(!verified
          ? { reason: "readback_mismatch_or_insufficient_evidence" }
          : {}),
      };
      this.journal.save(result);
      return result;
    });
  }
}
