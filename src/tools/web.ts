import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
  registerReadOnlyTool,
  registerWriteTool,
  isReadOnly,
  isWriteCapabilityEnabled,
  type CostedGraphQL,
} from "../tool-helpers.js";
import {
  cents,
  coordinates,
  decimal,
  digest,
  id,
  paymentInput,
  paymentProposal,
  pinInput,
  pinProposal,
  snapshot,
  type Snapshot,
  type Execution,
  WebError,
} from "../web/contracts.js";
import { webCall } from "../web/client.js";
import { appendAuditLog } from "../utils/auditLog.js";
const ACCOUNT = `query WebAccount { account { id countryCode } }`;
const INVOICE = `query WebInvoice($id:EncodedId!){invoice(id:$id){id updatedAt invoiceNumber subject invoiceStatus jobberWebUri client{id name} amounts{invoiceBalance}}}`;
const PAYMENTS = `query WebPayments($client:EncodedId!,$after:String){paymentRecords(first:20,after:$after,filter:{clientId:$client}){nodes{__typename id amount entryDate details client{id} invoice{id} allocations(first:20){nodes{amount ... on InvoicePaymentRecordAllocation{invoice{id}}} pageInfo{hasNextPage endCursor}} ... on CheckPaymentRecord{reference:checkNumber} ... on ETransferPaymentRecord{reference:confirmationNumber} ... on OtherPaymentRecord{reference:confirmationNumber}} pageInfo{hasNextPage endCursor}}}`;
const PROPERTY = `query WebProperty($id:EncodedId!){property(id:$id){id name street1 street2 city province postalCode country jobberWebUri client{id name} address{coordinates{latitude longitude}}}}`;
const METHODS: Record<string, string> = {
  CashPaymentRecord: "Cash",
  CheckPaymentRecord: "Cheque",
  ETransferPaymentRecord: "E-transfer",
  OtherPaymentRecord: "Other",
};
export async function readWebSnapshot(
  run: CostedGraphQL<number>,
  kind: "payment" | "pin",
  target: string,
): Promise<Snapshot> {
  const { account } = await run(ACCOUNT);
  if (
    !account ||
    account.id !== process.env.JOBBER_WEB_ACCOUNT_ID ||
    account.countryCode !== "CA"
  )
    throw new WebError("account_mismatch");
  if (kind === "pin") {
    const { property: p } = await run(PROPERTY, { id: target });
    if (!p || p.id !== target || !p.client)
      throw new WebError("property_unavailable");
    const address = [
      p.street1,
      p.street2,
      p.city,
      p.province,
      p.postalCode,
      p.country,
    ]
      .map((v) => v ?? "")
      .join("\n");
    return snapshot.parse({
      account_id: account.id,
      country: "CA",
      target_id: p.id,
      client_id: p.client.id,
      client_name: p.client.name,
      title: p.name ?? p.street1,
      url: p.jobberWebUri,
      address,
      coordinates: p.address?.coordinates ?? null,
      version: digest(p),
    });
  }
  const { invoice: i } = await run(INVOICE, { id: target });
  if (!i || i.id !== target || !i.client)
    throw new WebError("invoice_unavailable");
  let cursor: string | undefined;
  const records: any[] = [];
  const seen = new Set<string>();
  for (let page = 0; page < 100; page++) {
    const data = await run(PAYMENTS, { client: i.client.id, after: cursor });
    const connection = data.paymentRecords;
    if (!connection) throw new WebError("payment_scan_incomplete");
    for (const p of connection.nodes) {
      if (p.client?.id !== i.client.id)
        throw new WebError("payment_client_mismatch");
      if (p.allocations?.pageInfo.hasNextPage)
        throw new WebError("payment_allocation_scan_incomplete");
      const allocations = (p.allocations?.nodes ?? []).filter(
        (a: any) => a.invoice?.id === target,
      );
      if (p.invoice?.id !== target && !allocations.length) continue;
      records.push({
        id: p.id,
        amount: decimal(
          cents(allocations.length === 1 ? allocations[0].amount : p.amount),
        ),
        date: new Intl.DateTimeFormat("en-CA", {
          timeZone: "America/Toronto",
          year: "numeric",
          month: "2-digit",
          day: "2-digit",
        }).format(new Date(p.entryDate)),
        method: METHODS[p.__typename] ?? p.__typename,
        details: p.details ?? "",
        reference: p.reference ?? "",
        client_id: p.client.id,
        invoice_id: target,
      });
    }
    if (!connection.pageInfo.hasNextPage) {
      const fresh = await run(INVOICE, { id: target });
      if (digest(fresh.invoice) !== digest(i))
        throw new WebError("invoice_changed_during_scan");
      records.sort((a, b) => a.id.localeCompare(b.id));
      return snapshot.parse({
        account_id: account.id,
        country: "CA",
        target_id: i.id,
        client_id: i.client.id,
        client_name: i.client.name,
        title: `Invoice #${i.invoiceNumber}: ${i.subject}`,
        url: i.jobberWebUri,
        version: i.updatedAt,
        balance: decimal(cents(i.amounts.invoiceBalance)),
        payments: records,
      });
    }
    const next = connection.pageInfo.endCursor;
    if (!next || seen.has(next)) throw new WebError("payment_scan_incomplete");
    seen.add(next);
    cursor = next;
  }
  throw new WebError("payment_scan_budget_exceeded");
}

const text = (value: unknown) => ({
  content: [{ type: "text" as const, text: JSON.stringify(value) }],
});
export function registerWebTools(server: McpServer): void {
  if (process.env.JOBBER_WEB_ENABLED !== "true") return;
  const read = { maxCost: 800, redactAuditErrors: true };
  registerReadOnlyTool(
    server,
    "jobber_web_status",
    {
      description:
        "Check Williams browser readiness; login_required is independent of normal Jobber API health.",
      redactAuditErrors: true,
    },
    async () => text(await webCall("/v1/status", {})),
  );
  registerReadOnlyTool(
    server,
    "preview_invoice_payment",
    {
      ...read,
      description:
        "Prepare one OFFLINE payment already received. Explicit amount/date/method; CAD Williams account only. Shows complete immutable proposal and native method. No charge or receipt; approval is required for record_invoice_payment.",
      inputSchema: paymentInput.shape,
    },
    async (args, run) =>
      text(
        await webCall("/v1/preview-payment", {
          input: args,
          snapshot: await readWebSnapshot(run, "payment", args.invoice_id),
        }),
      ),
  );
  registerReadOnlyTool(
    server,
    "preview_property_map_pin",
    {
      ...read,
      description:
        "Prepare a native property map-pin correction from coordinates OR a shared Google Maps pin. Does not change addresses. Review exact property and coordinates; ambiguous links need coordinates.",
      inputSchema: {
        property_id: id,
        coordinates: coordinates.optional(),
        maps_url: z.string().url().max(4096).optional(),
      },
    },
    async (args, run) => {
      pinInput.parse(args);
      return text(
        await webCall("/v1/preview-pin", {
          input: args,
          snapshot: await readWebSnapshot(run, "pin", args.property_id),
        }),
      );
    },
  );
  registerReadOnlyTool(
    server,
    "get_web_operation",
    {
      ...read,
      description:
        "Read/reconcile an existing browser operation without resubmitting. Preserve operation IDs after timeout. Uncertain payments require review before another write.",
      inputSchema: { operation_id: z.string().uuid() },
    },
    async (args, run) => {
      const { account } = await run(ACCOUNT);
      if (account?.id !== process.env.JOBBER_WEB_ACCOUNT_ID)
        throw new WebError("account_mismatch");
      const saved = await webCall("/v1/operation", args),
        p = saved.execution.proposal;
      if (p.account_id !== process.env.JOBBER_WEB_ACCOUNT_ID)
        throw new WebError("account_mismatch");
      if (["completed", "rejected"].includes(saved.result.outcome))
        return text(saved.result);
      return text(
        await webCall("/v1/verify", {
          ...args,
          snapshot: await readWebSnapshot(
            run,
            p.action === "record_invoice_payment" ? "payment" : "pin",
            p.target_id,
          ),
        }),
      );
    },
  );
  if (isReadOnly()) return;
  for (const [name, schema, capability] of [
    ["record_invoice_payment", paymentProposal, "web_payments"],
    ["update_property_map_pin", pinProposal, "web_properties"],
  ] as const) {
    if (!isWriteCapabilityEnabled(capability)) continue;
    registerWriteTool(
      server,
      name,
      {
        ...read,
        capability,
        description:
          "Execute the complete unchanged preview proposal after dashboard approval. Include all proposal fields and stable operation_id; notifications remain off. Query get_web_operation after uncertainty; never repeat with a new ID automatically.",
        inputSchema: {
          proposal: schema,
          operation_id: z.string().uuid(),
          confirm_write: z.literal(true),
        },
      },
      async (args, run) => {
        const input = args as Execution,
          p = input.proposal;
        const current = await readWebSnapshot(
          run,
          p.action === "record_invoice_payment" ? "payment" : "pin",
          p.target_id,
        );
        let result: any;
        try {
          result = await webCall("/v1/execute", {
            execution: input,
            snapshot: current,
          });
        } catch (e) {
          if (
            e instanceof WebError &&
            e.code === "submission_uncertain_query_operation"
          )
            return text({
              operation_id: args.operation_id,
              outcome: "uncertain",
              reason: e.code,
            });
          throw e;
        }
        if (result.outcome === "uncertain" || result.outcome === "dispatched") {
          try {
            result = await webCall("/v1/verify", {
              operation_id: args.operation_id,
              snapshot: await readWebSnapshot(
                run,
                p.action === "record_invoice_payment" ? "payment" : "pin",
                p.target_id,
              ),
            });
          } catch {
            /* Preserve durable uncertainty; never repeat the submission. */
          }
        }
        await appendAuditLog({
          tool: name,
          args: {
            operation_id: args.operation_id,
            target_id: p.target_id,
            payload_hash: digest(input),
          },
          outcome: result.outcome === "completed" ? "success" : "partial",
        });
        return text(result);
      },
    );
  }
}
