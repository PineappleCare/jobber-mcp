import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
} from "playwright";
import { WebJournal } from "./storage.js";
import {
  type Proposal,
  type Snapshot,
  WebError,
  targetUrl,
} from "./contracts.js";
export interface BrowserPort {
  identity(): Promise<string>;
  prepare(
    snapshot: Snapshot,
    proposal?: Proposal,
  ): Promise<{ native_methods?: string[] }>;
  submit(proposal: Proposal, dispatch: () => void): Promise<string | undefined>;
  beginLogin(): Promise<void>;
  endLogin(): Promise<void>;
}
export const nativeId = (value: string): string => {
  const decoded = value.startsWith("gid://")
    ? value
    : Buffer.from(value, "base64").toString("utf8");
  const found = /^\d+$/.test(value)
    ? value
    : decoded.match(/(?:^|[:/])(\d+)$/)?.[1];
  if (!found) throw new WebError("invalid_native_identity");
  return found;
};
export class JobberBrowser implements BrowserPort {
  private browser?: Browser;
  private context?: BrowserContext;
  private page?: Page;
  constructor(
    private journal: WebJournal,
    private expectedAccount: string,
  ) {}
  private async current(): Promise<Page> {
    if (!this.browser?.isConnected()) {
      this.browser = await chromium.launch({
        headless: false,
        chromiumSandbox: true,
        args: ["--disable-dev-shm-usage"],
      });
      this.context = await this.browser.newContext({
        storageState: this.journal.meta<any>("auth"),
        viewport: { width: 1440, height: 1000 },
        locale: "en-CA",
        timezoneId: "America/Toronto",
        serviceWorkers: "block",
      });
      this.context.setDefaultTimeout(15000);
      this.page = await this.context.newPage();
    }
    return this.page!;
  }
  async identity(): Promise<string> {
    await this.current();
    // Legacy settings HTML includes the active account ID. OAuth identity alone cannot attest the browser session.
    const response = await this.context!.request.get(
      "https://secure.getjobber.com/accounts/edit",
      { maxRedirects: 0, timeout: 15000 },
    ).catch(() => {
      throw new WebError("website_unavailable");
    });
    if (
      response.status() === 302 ||
      response.status() === 401 ||
      response.status() === 403
    )
      throw new WebError("login_required");
    if (!response.ok()) throw new WebError("website_unavailable");
    const html = await response.text();
    const ids = [
      ...new Set(
        [...html.matchAll(/(?:["']?account_id["']?)\s*:\s*["']?(\d+)/g)].map(
          (m) => m[1],
        ),
      ),
    ];
    if (ids.length !== 1) throw new WebError("website_identity_unavailable");
    if (ids[0] !== nativeId(this.expectedAccount))
      throw new WebError("browser_account_mismatch");
    this.journal.setMeta(
      "auth",
      await this.context!.storageState({ indexedDB: true }),
    );
    return this.expectedAccount;
  }
  private async navigate(url: string): Promise<Page> {
    const page = await this.current();
    await page.goto(url, { waitUntil: "domcontentloaded" });
    if (
      new URL(page.url()).origin !== "https://secure.getjobber.com" ||
      /login|authentication/.test(new URL(page.url()).pathname)
    )
      throw new WebError("login_required");
    return page;
  }
  async prepare(
    s: Snapshot,
    p?: Proposal,
  ): Promise<{ native_methods?: string[] }> {
    await this.identity();
    if (s.balance !== undefined) {
      targetUrl(s.url, "invoice", s.target_id);
      const page = await this.navigate(s.url);
      await page
        .getByRole("button", { name: "Collect Payment", exact: true })
        .click();
      await page.waitForURL((u) => u.pathname === "/payments/new");
      const u = new URL(page.url());
      if (
        u.searchParams.get("invoiceId") !== nativeId(s.target_id) ||
        u.searchParams.get("clientId") !== nativeId(s.client_id)
      )
        throw new WebError("website_target_mismatch");
      const combo = page.getByRole("combobox", {
        name: "Payment method",
        exact: true,
      });
      await combo.click();
      const choices = page.getByRole("listbox");
      await choices.waitFor();
      const native_methods: string[] = [];
      for (const name of ["Cash", "Cheque", "E-transfer", "Other"])
        if ((await choices.getByText(name, { exact: true }).count()) === 1)
          native_methods.push(name);
      await page.keyboard.press("Escape");
      if (p?.action === "record_invoice_payment") {
        await combo.click();
        await page
          .getByRole("listbox")
          .getByText(p.native_method, { exact: true })
          .click();
        // Never touch saved-card inputs or a Charge button.
        const formattedDate = new Intl.DateTimeFormat("en-CA", {
          month: "short",
          day: "numeric",
          year: "numeric",
          timeZone: "UTC",
        }).format(new Date(p.transaction_date + "T12:00:00Z"));
        const transactionDate = page.getByRole("textbox", {
          name: "Transaction Date",
          exact: true,
        });
        await transactionDate.fill(formattedDate);
        await transactionDate.blur();
        if ((await transactionDate.inputValue()) !== formattedDate)
          throw new WebError("website_transaction_date_changed");
        const reference = page.getByRole("textbox", {
          name: p.native_method === "Cheque" ? "Cheque #" : "Reference #",
          exact: true,
        });
        if (p.reference || (await reference.count()))
          await reference.fill(p.reference);
        if (p.reference && (await reference.inputValue()) !== p.reference)
          throw new WebError("website_reference_changed");
        await page
          .getByRole("textbox", { name: "Details", exact: true })
          .fill(p.details);
        const numeric = await page
          .locator("input")
          .evaluateAll((es) =>
            es
              .filter(
                (e): e is HTMLInputElement =>
                  e instanceof HTMLInputElement &&
                  !e.disabled &&
                  /^\$[\d,]+\.\d{2}$/.test(e.value),
              )
              .map((e) => e.id),
          );
        if (numeric.length !== 1 || !numeric[0])
          throw new WebError("website_payment_amount_changed");
        const amount = page.locator(`[id=${JSON.stringify(numeric[0])}]`);
        await amount.fill(p.amount);
        await amount.blur();
        await page.getByText("1 selected", { exact: true }).waitFor();
        const selected = await page
          .locator(
            "input[type=checkbox]:checked,[role=checkbox][aria-checked=true]",
          )
          .count();
        if (selected !== 1)
          throw new WebError("website_invoice_selection_changed");
        const selectedInvoice = await page
          .locator(
            "input[type=checkbox]:checked,[role=checkbox][aria-checked=true]",
          )
          .evaluate((el) => {
            let node: Element | null = el;
            while (node) {
              const links = [...node.querySelectorAll('a[href*="/invoices/"]')];
              if (links.length === 1) return links[0].getAttribute("href");
              if (links.length > 1) break;
              node = node.parentElement;
            }
            return null;
          });
        if (
          !selectedInvoice ||
          new URL(selectedInvoice, "https://secure.getjobber.com").pathname !==
            `/invoices/${nativeId(s.target_id)}`
        )
          throw new WebError("website_invoice_selection_changed");
        if (!(await combo.innerText()).includes(p.native_method))
          throw new WebError("website_payment_method_changed");
        const actual = (await amount.inputValue()).replace(/[$,\s]/g, "");
        if (actual !== p.amount)
          throw new WebError("website_payment_amount_changed");
        if (await page.getByRole("button", { name: /^Charge/ }).count())
          throw new WebError("website_payment_form_unsafe");
        await page.getByRole("button", { name: "Save", exact: true }).waitFor();
      }
      return { native_methods };
    }
    const u = targetUrl(s.url, "property", s.target_id, s.client_id);
    const page = await this.navigate(
      `${u.origin}/properties/${nativeId(s.target_id)}/manually_geocode`,
    );
    const cancel = page.getByRole("link", { name: "Cancel", exact: true });
    if (
      new URL((await cancel.getAttribute("href"))!, u.origin).pathname !==
      u.pathname
    )
      throw new WebError("website_target_mismatch");
    if (p?.action === "update_property_map_pin") {
      await page
        .getByRole("textbox", { name: "Latitude", exact: true })
        .fill(String(p.coordinates.latitude));
      await page
        .getByRole("textbox", { name: "Longitude", exact: true })
        .fill(String(p.coordinates.longitude));
      if (
        Number(
          await page
            .getByRole("textbox", { name: "Latitude", exact: true })
            .inputValue(),
        ) !== p.coordinates.latitude ||
        Number(
          await page
            .getByRole("textbox", { name: "Longitude", exact: true })
            .inputValue(),
        ) !== p.coordinates.longitude
      )
        throw new WebError("website_pin_form_changed");
      await page.getByRole("button", { name: "Save", exact: true }).waitFor();
    }
    return {};
  }
  async submit(p: Proposal, dispatch: () => void): Promise<string | undefined> {
    await this.identity(); // Independent fresh account check immediately before Save.
    const page = await this.current();
    // Fail if the form has disappeared. The journal is persisted before the only submit click.
    const save = page.getByRole("button", { name: "Save", exact: true });
    if ((await save.count()) !== 1 || !(await save.isEnabled()))
      throw new WebError("website_save_unavailable");
    dispatch();
    await save.click({ timeout: 10000 });
    if (p.action === "record_invoice_payment") {
      await page.waitForURL((u) => /^\/payments\/\d+$/.test(u.pathname), {
        timeout: 15000,
      });
      return page.url().match(/\/payments\/(\d+)$/)?.[1];
    }
    await page.waitForURL(
      (u) => u.pathname === new URL(p.target_url).pathname,
      { timeout: 15000 },
    );
    return undefined;
  }
  async beginLogin(): Promise<void> {
    const page = await this.current();
    await page.goto("https://secure.getjobber.com/home");
  }
  async endLogin(): Promise<void> {
    await this.identity();
    this.journal.setMeta(
      "auth",
      await this.context!.storageState({ indexedDB: true }),
    );
  }
  async close(): Promise<void> {
    await this.browser?.close();
  }
}
