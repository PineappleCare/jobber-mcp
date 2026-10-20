import { z } from "zod";
import { createHash } from "node:crypto";
export const id = z.string().min(1).max(256);
export const money = z
  .string()
  .regex(/^(0|[1-9]\d{0,10})\.\d{2}$/, "Use a decimal amount with two places");
export function cents(value: string | number): bigint {
  const text = typeof value === "number" ? String(value) : value;
  if (!/^-?\d+(\.\d{1,2})?$/.test(text))
    throw new Error("Unsupported monetary precision");
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = text.replace(/^-/, "").split(".");
  const result = BigInt(whole) * 100n + BigInt(fraction.padEnd(2, "0"));
  return negative ? -result : result;
}
export function decimal(value: bigint): string {
  return `${value < 0n ? "-" : ""}${(value < 0n ? -value : value) / 100n}.${String((value < 0n ? -value : value) % 100n).padStart(2, "0")}`;
}
export function digest(value: unknown): string {
  const stable = (v: any): any =>
    Array.isArray(v)
      ? v.map(stable)
      : v && typeof v === "object"
        ? Object.fromEntries(
            Object.keys(v)
              .sort()
              .map((k) => [k, stable(v[k])]),
          )
        : v;
  return createHash("sha256")
    .update(JSON.stringify(stable(value)))
    .digest("hex");
}
export const coordinates = z
  .object({
    latitude: z.number().finite().min(-90).max(90),
    longitude: z.number().finite().min(-180).max(180),
  })
  .strict();
export const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((s) => {
    const d = new Date(`${s}T12:00:00Z`);
    return !isNaN(+d) && d.toISOString().startsWith(s);
  }, "Use a real YYYY-MM-DD date");
export const paymentInput = z
  .object({
    invoice_id: id,
    amount: money.refine((s) => cents(s) > 0n, "Amount must be positive"),
    transaction_date: date,
    method: z.enum(["cash", "cheque", "e_transfer", "bank_transfer", "other"]),
    reference: z.string().max(200).default(""),
    details: z.string().max(2000).default(""),
  })
  .strict();
export const pinInput = z
  .object({
    property_id: id,
    coordinates: coordinates.optional(),
    maps_url: z.string().url().max(4096).optional(),
  })
  .strict()
  .refine(
    (v) => Boolean(v.coordinates) !== Boolean(v.maps_url),
    "Supply coordinates or a Google Maps link, exclusively",
  );
export const paymentRecord = z
  .object({
    id,
    amount: z.string(),
    date: z.string(),
    method: z.string(),
    details: z.string(),
    reference: z.string(),
    client_id: id,
    invoice_id: id.nullable(),
  })
  .strict();
export const snapshot = z
  .object({
    account_id: id,
    country: z.literal("CA"),
    target_id: id,
    client_id: id,
    client_name: z.string(),
    title: z.string(),
    url: z.string().url(),
    version: z.string(),
    balance: money.optional(),
    payments: z.array(paymentRecord).max(5000).optional(),
    address: z.string().optional(),
    coordinates: coordinates.nullable().optional(),
  })
  .strict();
const common = {
  proposal_id: z.string().uuid(),
  auth_epoch: id,
  expires_at: z.number().int(),
  account_id: id,
  target_id: id,
  client_id: id,
  client_name: z.string(),
  title: z.string(),
  target_url: z.string().url(),
  expected_version: z.string(),
  expected_snapshot: z.string(),
};
export const paymentProposal = z
  .object({
    ...common,
    action: z.literal("record_invoice_payment"),
    amount: money,
    currency: z.literal("CAD"),
    transaction_date: date,
    method: paymentInput.shape.method,
    native_method: z.enum(["Cash", "Cheque", "E-transfer", "Other"]),
    reference: z.string().max(200),
    details: z.string().max(2000),
    balance_before: money,
    balance_after: money,
    send_receipt: z.literal(false),
  })
  .strict();
export const pinProposal = z
  .object({
    ...common,
    action: z.literal("update_property_map_pin"),
    address: z.string(),
    before: coordinates.nullable(),
    coordinates,
    map_url: z.string().url(),
    source_url: z.string().url().nullable(),
  })
  .strict();
export const proposal = z.discriminatedUnion("action", [
  paymentProposal,
  pinProposal,
]);
export const execution = z
  .object({
    operation_id: z.string().uuid(),
    proposal,
    confirm_write: z.literal(true),
  })
  .strict();
export type Snapshot = z.infer<typeof snapshot>;
export type Proposal = z.infer<typeof proposal>;
export type Execution = z.infer<typeof execution>;
export type Result = {
  operation_id: string;
  outcome: "dispatched" | "uncertain" | "completed" | "rejected";
  record_id?: string;
  reason?: string;
};
export class WebError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = "JobberWebError";
  }
}
export function distance(
  a: z.infer<typeof coordinates>,
  b: z.infer<typeof coordinates>,
): number {
  const rad = Math.PI / 180,
    dlat = (b.latitude - a.latitude) * rad,
    dlon = (b.longitude - a.longitude) * rad;
  return (
    6371000 *
    2 *
    Math.asin(
      Math.min(
        1,
        Math.sqrt(
          Math.sin(dlat / 2) ** 2 +
            Math.cos(a.latitude * rad) *
              Math.cos(b.latitude * rad) *
              Math.sin(dlon / 2) ** 2,
        ),
      ),
    )
  );
}
export function targetUrl(
  raw: string,
  kind: "invoice" | "property",
  target: string,
  client?: string,
): URL {
  const u = new URL(raw);
  const re =
    kind === "invoice"
      ? /^\/invoices\/(\d+)$/
      : /^\/clients\/(\d+)\/properties\/(\d+)$/;
  const m = u.pathname.match(re);
  if (
    u.origin !== "https://secure.getjobber.com" ||
    !m ||
    u.search ||
    u.hash ||
    u.username ||
    u.password
  )
    throw new WebError("invalid_target");
  // Encoded IDs must agree with native URI IDs; never navigate a caller-selected target.
  const native = (v: string) =>
    /^\d+$/.test(v)
      ? v
      : (v.startsWith("gid://")
          ? v
          : Buffer.from(v, "base64").toString("utf8")
        ).match(/(?:^|[:/])(\d+)$/)?.[1];
  if (
    m.at(-1) !== native(target) ||
    (kind === "property" && m[1] !== native(client!))
  )
    throw new WebError("invalid_target");
  return u;
}
