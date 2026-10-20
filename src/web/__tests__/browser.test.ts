import {
  beforeAll,
  afterAll,
  afterEach,
  describe,
  it,
  expect,
  vi,
} from "vitest";
import { chromium, type Browser } from "playwright";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { JobberBrowser } from "../browser.js";
import { WebJournal } from "../storage.js";
import type { Snapshot, Proposal } from "../contracts.js";
let browser: Browser;
const cleanup: (() => Promise<void>)[] = [];
beforeAll(async () => {
  browser = await chromium.launch({ headless: true });
});
afterAll(async () => {
  await browser?.close();
});
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});
const s: Snapshot = {
  account_id: "gid://Jobber/Account/12",
  country: "CA",
  target_id: "gid://Jobber/Invoice/10",
  client_id: "gid://Jobber/Client/1",
  client_name: "Fictional customer",
  title: "Invoice #1",
  url: "https://secure.getjobber.com/invoices/10",
  version: "v1",
  balance: "100.00",
  payments: [],
};
const payment = (): Proposal => ({
  proposal_id: randomUUID(),
  auth_epoch: randomUUID(),
  expires_at: Date.now() + 10000,
  account_id: s.account_id,
  target_id: s.target_id,
  client_id: s.client_id,
  client_name: s.client_name,
  title: s.title,
  target_url: s.url,
  expected_version: "v1",
  expected_snapshot: "fixture",
  action: "record_invoice_payment",
  amount: "30.00",
  currency: "CAD",
  transaction_date: "2026-10-20",
  method: "e_transfer",
  native_method: "E-transfer",
  reference: "REF",
  details: "Received externally",
  balance_before: "100.00",
  balance_after: "70.00",
  send_receipt: false,
});
async function setup(extra = false) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "jobber-browser-")),
    j = new WebJournal(path.join(dir, "state.db"), randomBytes(32));
  const context = await browser.newContext(),
    page = await context.newPage();
  const writes = { save: 0, receipt: 0, charge: 0, pin: 0 };
  // All network is intercepted. No production credentials, records or endpoints are contacted.
  await context.route("**/*", async (route) => {
    const u = new URL(route.request().url());
    let html = "";
    if (u.pathname === "/invoices/10")
      html =
        "<button onclick=\"location.href='/payments/new?clientId=1&invoiceId=10'\">Collect Payment</button>";
    else if (u.pathname === "/payments/new")
      html = `<label>Payment method <button role="combobox" aria-label="Payment method" onclick="document.getElementById('choices').hidden=false">Credit/debit card</button></label><div id="choices" role="listbox" hidden>${["Cash", "Cheque", "E-transfer", "Other"].map((n) => `<span onclick="document.querySelector('[role=combobox]').innerText='${n}';document.getElementById('choices').hidden=true;document.getElementById('charge').remove();document.getElementById('offline').hidden=false">${n}</span>`).join("")}</div><button id="charge" onclick="fetch('/fixture/charge')">Charge $100.00</button><div id="offline" hidden><label>Transaction Date<input aria-label="Transaction Date"></label><label>Reference #<input aria-label="Reference #"></label><label>Details<textarea aria-label="Details"></textarea></label><p>1 selected</p><div><a href="/invoices/10">#1</a><input id="amount" value="$100.00" onblur="this.value='$'+Number(this.value.replace('$','')).toFixed(2)"><input type="checkbox" checked></div>${extra ? '<div><a href="/invoices/11">#2</a><input type="checkbox" checked></div>' : ""}<button onclick="fetch('/fixture/save').then(()=>location.href='/payments/777')">Save</button><button onclick="fetch('/fixture/receipt')">Save and Email Receipt</button></div>`;
    else if (u.pathname === "/properties/2/manually_geocode")
      html =
        '<a href="/clients/1/properties/2">Cancel</a><label>Latitude<input aria-label="Latitude" value="47"></label><label>Longitude<input aria-label="Longitude" value="-80"></label><button onclick="fetch(\'/fixture/pin\').then(()=>location.href=\'/clients/1/properties/2\')">Save</button>';
    else if (u.pathname.startsWith("/fixture/")) {
      writes[u.pathname.split("/").at(-1)! as keyof typeof writes]++;
      await route.fulfill({ json: { ok: true } });
      return;
    }
    await route.fulfill({
      contentType: "text/html",
      body: html || "<p>Saved</p>",
    });
  });
  const port = new JobberBrowser(j, s.account_id);
  Object.assign(port as any, { browser, context, page });
  vi.spyOn(context.request, "get").mockResolvedValue({
    status: () => 200,
    ok: () => true,
    text: async () => '<script>const settings={account_id:"12"}</script>',
  } as any);
  cleanup.push(async () => {
    await context.close();
    j.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { port, writes, context, page };
}
describe("scripted browser fixture using inspected form contracts", () => {
  it("records exactly one payment through Save, never Charge or Save and Email Receipt", async () => {
    const { port, writes, page } = await setup();
    expect(await port.identity()).toBe(s.account_id);
    const p = payment();
    await port.prepare(s, p);
    expect(
      await page
        .getByRole("textbox", { name: "Details", exact: true })
        .inputValue(),
    ).toBe("Received externally");
    let dispatches = 0;
    expect(
      await port.submit(p, () => {
        dispatches++;
      }),
    ).toBe("777");
    expect(dispatches).toBe(1);
    expect(writes).toEqual({ save: 1, charge: 0, receipt: 0, pin: 0 });
  });
  it("refuses multiple selected invoices before dispatch", async () => {
    const { port, writes } = await setup(true);
    await expect(port.prepare(s, payment())).rejects.toThrow(
      "website_invoice_selection_changed",
    );
    expect(writes.save).toBe(0);
  });
  it("fills exact property coordinates, validates its parent, and saves once", async () => {
    const { port, writes } = await setup();
    const state = {
      ...s,
      target_id: "gid://Jobber/Property/2",
      url: "https://secure.getjobber.com/clients/1/properties/2",
      balance: undefined,
      payments: undefined,
      address: "Fictional street",
      coordinates: { latitude: 47, longitude: -80 },
    };
    const p: Proposal = {
      ...payment(),
      action: "update_property_map_pin",
      target_id: state.target_id,
      target_url: state.url,
      address: state.address,
      before: state.coordinates,
      coordinates: { latitude: 47.01, longitude: -80.01 },
      map_url: "https://www.google.com/maps?query=47.01,-80.01",
      source_url: null,
    } as any;
    await port.prepare(state, p);
    await port.submit(p, () => {});
    expect(writes).toEqual({ save: 0, charge: 0, receipt: 0, pin: 1 });
  });
  it("refuses a mismatched browser account and arbitrary native target URLs", async () => {
    const { port, context, writes } = await setup();
    vi.mocked(context.request.get).mockResolvedValue({
      status: () => 200,
      ok: () => true,
      text: async () => "<script>var x={account_id:13}</script>",
    } as any);
    await expect(port.prepare(s, payment())).rejects.toThrow(
      "browser_account_mismatch",
    );
    expect(writes.save).toBe(0);
  });
});
