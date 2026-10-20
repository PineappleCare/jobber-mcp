import { beforeEach, describe, it, expect, vi } from "vitest";
const { read, write, audit, call } = vi.hoisted(() => ({
  read: vi.fn(),
  write: vi.fn(),
  audit: vi.fn(),
  call: vi.fn(),
}));
vi.mock("../../jobber/client.js", () => ({
  jobberGraphQL: read,
  jobberGraphQLWrite: write,
}));
vi.mock("../../utils/auditLog.js", () => ({ appendAuditLog: audit }));
vi.mock("../../web/client.js", () => ({ webCall: call }));
import { registerWebTools, readWebSnapshot } from "../web.js";
const account = { id: "account", countryCode: "CA" };
const invoice = {
  id: "invoice",
  updatedAt: "v1",
  invoiceNumber: 1,
  subject: "Fixture",
  jobberWebUri: "https://secure.getjobber.com/invoices/1",
  client: { id: "client", name: "Fixture client" },
  amounts: { invoiceBalance: 100 },
};
const page = (nodes: any[], more = false, cursor: string | null = null) => ({
  nodes,
  pageInfo: { hasNextPage: more, endCursor: cursor },
});
const payment = (n: number) => ({
  id: `pay${n}`,
  __typename: "ETransferPaymentRecord",
  adjustmentType: "PAYMENT",
  amount: 10,
  entryDate: "2026-10-20T12:00:00Z",
  details: "private payment memo",
  reference: "external-ref",
  client: { id: "client" },
  invoice: { id: "invoice" },
  allocations: page([{ amount: 10, invoice: { id: "invoice" } }]),
});
function setup() {
  const configs: any = {},
    handlers: any = {};
  registerWebTools({
    registerTool(name: string, cfg: any, handler: any) {
      configs[name] = cfg;
      handlers[name] = async (args: any = {}) => {
        const parsed = await cfg.inputSchema?.["~standard"].validate(args);
        return parsed?.issues
          ? { isError: true }
          : handler(parsed?.value ?? args);
      };
    },
  } as any);
  return { configs, handlers };
}
beforeEach(() => {
  vi.stubEnv("JOBBER_WEB_ENABLED", "true");
  vi.stubEnv("JOBBER_WEB_ACCOUNT_ID", "account");
  vi.stubEnv("JOBBER_READ_ONLY", "false");
  vi.stubEnv(
    "JOBBER_WRITE_CAPABILITIES",
    "records,scheduling,communications,web_payments,web_properties",
  );
  read.mockReset();
  write.mockReset();
  call.mockReset();
  audit.mockReset().mockResolvedValue(undefined);
});
describe("MCP browser business tool boundary", () => {
  it("hides all browser tools unless explicitly enabled and separately gates each mutation", () => {
    vi.stubEnv("JOBBER_WEB_ENABLED", "false");
    expect(Object.keys(setup().configs)).toHaveLength(0);
    vi.stubEnv("JOBBER_WEB_ENABLED", "true");
    vi.stubEnv("JOBBER_READ_ONLY", "true");
    const r = setup();
    expect(Object.keys(r.configs)).toHaveLength(4);
    expect(
      Object.values(r.configs).every((v: any) => v.annotations.readOnlyHint),
    ).toBe(true);
    vi.stubEnv("JOBBER_READ_ONLY", "false");
    vi.stubEnv("JOBBER_WRITE_CAPABILITIES", "web_properties");
    const w = setup();
    expect(w.configs.record_invoice_payment).toBeUndefined();
    expect(w.configs.update_property_map_pin.annotations.readOnlyHint).toBe(
      false,
    );
  });
  it("reads every payment page including duplicates beyond the first page and validates invoice again", async () => {
    read
      .mockResolvedValueOnce({ account })
      .mockResolvedValueOnce({ invoice })
      .mockResolvedValueOnce({
        paymentRecords: page([payment(1)], true, "next"),
      })
      .mockResolvedValueOnce({ paymentRecords: page([payment(2)]) })
      .mockResolvedValueOnce({ invoice });
    const r = await readWebSnapshot((q, v) => read(q, v), "payment", "invoice");
    expect(r.payments).toHaveLength(2);
    expect(r.payments![1].reference).toBe("external-ref");
    expect(write).not.toHaveBeenCalled();
  });
  it("rejects foreign accounts, wrong targets, incomplete scans and concurrent changes", async () => {
    read.mockResolvedValueOnce({ account: { ...account, id: "foreign" } });
    await expect(
      readWebSnapshot((q, v) => read(q, v), "payment", "invoice"),
    ).rejects.toThrow("account_mismatch");
    read
      .mockResolvedValueOnce({ account })
      .mockResolvedValueOnce({ invoice: { ...invoice, id: "other" } });
    await expect(
      readWebSnapshot((q, v) => read(q, v), "payment", "invoice"),
    ).rejects.toThrow("invoice_unavailable");
    read
      .mockResolvedValueOnce({ account })
      .mockResolvedValueOnce({ invoice })
      .mockResolvedValueOnce({ paymentRecords: page([], true, null) });
    await expect(
      readWebSnapshot((q, v) => read(q, v), "payment", "invoice"),
    ).rejects.toThrow("scan_incomplete");
    read
      .mockResolvedValueOnce({ account })
      .mockResolvedValueOnce({ invoice })
      .mockResolvedValueOnce({ paymentRecords: page([]) })
      .mockResolvedValueOnce({ invoice: { ...invoice, updatedAt: "v2" } });
    await expect(
      readWebSnapshot((q, v) => read(q, v), "payment", "invoice"),
    ).rejects.toThrow("invoice_changed");
  });
  it.each([
    "INVOICE",
    "REFUND",
    "CORRECTION",
    "INITIAL_BALANCE",
    "FAILED_ACH_PAYMENT",
    "BAD_DEBT",
    "VOIDED",
  ])(
    "does not treat %s as a received payment while scanning every page",
    async (adjustmentType) => {
      read
        .mockResolvedValueOnce({ account })
        .mockResolvedValueOnce({ invoice })
        .mockResolvedValueOnce({
          paymentRecords: page(
            [
              {
                ...payment(1),
                adjustmentType,
                __typename:
                  adjustmentType === "REFUND"
                    ? "RefundPaymentRecord"
                    : "OtherPaymentRecord",
              },
            ],
            true,
            "next",
          ),
        })
        .mockResolvedValueOnce({
          paymentRecords: page([
            payment(2),
            { ...payment(3), adjustmentType: "DEPOSIT" },
          ]),
        })
        .mockResolvedValueOnce({ invoice });
      const result = await readWebSnapshot(
        (q, v) => read(q, v),
        "payment",
        "invoice",
      );
      expect(result.payments?.map((p) => p.id)).toEqual(["pay2", "pay3"]);
      expect(read).toHaveBeenCalledTimes(5);
      expect(write).not.toHaveBeenCalled();
    },
  );
  it("fails closed for an unrecognized adjustment classification", async () => {
    read
      .mockResolvedValueOnce({ account })
      .mockResolvedValueOnce({ invoice })
      .mockResolvedValueOnce({
        paymentRecords: page([{ ...payment(1), adjustmentType: "NEW_KIND" }]),
      });
    await expect(
      readWebSnapshot((q, v) => read(q, v), "payment", "invoice"),
    ).rejects.toThrow("unsupported_payment_adjustment_type");
    expect(write).not.toHaveBeenCalled();
  });
  it("returns browser login errors as completed tool failures without performing API mutations", async () => {
    call.mockRejectedValue(new Error("login_required"));
    const r = await setup().handlers.jobber_web_status();
    expect(r.isError).toBe(true);
    expect(write).not.toHaveBeenCalled();
  });
  it("rechecks OAuth account before returning a completed operation", async () => {
    read.mockResolvedValueOnce({ account: { ...account, id: "foreign" } });
    await setup().handlers.get_web_operation({
      operation_id: "10000000-0000-4000-8000-000000000000",
    });
    expect(call).not.toHaveBeenCalled();
  });
});
