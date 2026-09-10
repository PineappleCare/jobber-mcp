import fs from "fs/promises";
import path from "path";
import os from "os";
import { randomUUID, createHash } from "crypto";
import { loadTokens } from "../auth/tokenStorage.js";
import { requireSessionContext } from "./sessionContext.js";

const STDIO_SESSION_ID = randomUUID();

const AUDIT_DIR = path.join(os.homedir(), ".jobber-mcp");
const AUDIT_FILE = path.join(AUDIT_DIR, "audit.log");
const AUDIT_FILE_ROTATED = path.join(AUDIT_DIR, "audit.log.1");
// Single-generation rotation, not a full logrotate reimplementation - this just stops the file
// from growing forever. Checked before each append, so the file can briefly exceed this by up to
// one entry's worth of bytes.
const AUDIT_ROTATE_MAX_BYTES = 10 * 1024 * 1024;

const REDACTED_KEYS = new Set([
  "access_token", "refresh_token", "client_secret", "password", "token", "encryption_key",
  "secret", "api_key", "authorization", "bearer", "code", "state", "nonce",
]);

// Business/PII-bearing fields that are hashed rather than fully redacted - full redaction would
// make the audit log useless for its purpose (knowing what was searched for), but the raw value
// (e.g. a client's name/email/phone typed into find_client) shouldn't sit in plaintext forever.
const HASHED_KEYS = new Set([
  "search_term",
  // Write inputs can contain client names and internal operational notes. The
  // audit log needs evidence of the action, not a second plaintext copy.
  "body",
  "first_name",
  "last_name",
  "company_name",
]);

function normalizeKey(k: string): string {
  return k.toLowerCase().replace(/[^a-z0-9]/g, "");
}

const REDACTED_KEYS_NORMALIZED = new Set([...REDACTED_KEYS].map(normalizeKey));
const HASHED_KEYS_NORMALIZED = new Set([...HASHED_KEYS].map(normalizeKey));

function hashValue(v: unknown): string {
  return createHash("sha256").update(String(v)).digest("hex").slice(0, 12);
}

function detectMachineIp(): string | undefined {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === "IPv4" && !addr.internal) return addr.address;
    }
  }
}
const MACHINE_IP: string | undefined = detectMachineIp();

export interface AuditEntry {
  timestamp: string;
  session_id: string;
  machine_ip?: string;
  tool: string;
  args: Record<string, unknown>;
  outcome: "success" | "error" | "not_found";
  error_message?: string;
  account_id?: string;
  result_count?: number;
}

export interface AuditLogFilter {
  date_from?: string;
  date_to?: string;
  limit?: number;
  offset?: number;
}

export interface ReadAuditLogResult {
  entries: AuditEntry[];
  total_matched: number;
  truncated: boolean;
  corrupted_lines: number;
}

/** Renames AUDIT_FILE to AUDIT_FILE_ROTATED (overwriting any prior rotation) once it crosses the
 * size threshold, so the next appendFile starts a fresh file. Best-effort - a failure here must
 * not block the append that triggered it. */
async function rotateIfNeeded(): Promise<void> {
  try {
    const stat = await fs.stat(AUDIT_FILE);
    if (stat.size < AUDIT_ROTATE_MAX_BYTES) return;
    await fs.rename(AUDIT_FILE, AUDIT_FILE_ROTATED);
  } catch (err: any) {
    if (err.code !== "ENOENT") console.error(`[audit] WARNING: log rotation check failed: ${err.message}`);
  }
}

function redactValue(v: unknown): unknown {
  if (Array.isArray(v)) {
    return v.map((item) =>
      item !== null && typeof item === "object" ? redactValue(item) : item
    );
  }
  if (v !== null && typeof v === "object") {
    return redactArgs(v as Record<string, unknown>);
  }
  return v;
}

function redactArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(args)) {
    if (HASHED_KEYS_NORMALIZED.has(normalizeKey(k))) {
      out[`${k}_hash`] = hashValue(v);
    } else if (REDACTED_KEYS_NORMALIZED.has(normalizeKey(k))) {
      out[k] = "[REDACTED]";
    } else {
      out[k] = redactValue(v);
    }
  }
  return out;
}

export async function appendAuditLog(
  entry: Omit<AuditEntry, "timestamp" | "session_id" | "machine_ip" | "account_id"> & { account_id?: string; result_count?: number }
): Promise<void> {
  try {
    await fs.mkdir(AUDIT_DIR, { recursive: true, mode: 0o700 });
    await fs.chmod(AUDIT_DIR, 0o700).catch(() => {});

    const ctx = requireSessionContext();
    // `""` is http.ts's initialize-request placeholder sessionId, never a real one - `||` (not
    // `??`) treats it as absent so it doesn't get persisted as a bogus session_id.
    const session_id = ctx?.sessionId || STDIO_SESSION_ID;

    let account_id = entry.account_id;
    if (!account_id) {
      if (ctx) {
        account_id = ctx.getTokens()?.account_id;
      } else {
        try { account_id = (await loadTokens())?.account_id; } catch { /* non-fatal */ }
      }
    }

    const full: AuditEntry = {
      timestamp: new Date().toISOString(),
      session_id,
      ...(MACHINE_IP !== undefined && { machine_ip: MACHINE_IP }),
      tool: entry.tool,
      args: redactArgs(entry.args),
      outcome: entry.outcome,
      ...(entry.error_message && { error_message: entry.error_message }),
      ...(account_id && { account_id }),
      ...(entry.result_count !== undefined && { result_count: entry.result_count }),
    };

    await rotateIfNeeded();
    await fs.appendFile(AUDIT_FILE, JSON.stringify(full) + "\n", "utf8");
    await fs.chmod(AUDIT_FILE, 0o600).catch(() => {});
  } catch (err: any) {
    console.error(`[audit] WARNING: Failed to write audit log: ${err.message}`);
  }
}

export async function readAuditLog(filter: AuditLogFilter = {}): Promise<ReadAuditLogResult> {
  const limit = Math.min(filter.limit ?? 500, 1000);
  const offset = filter.offset ?? 0;

  let raw: string;
  try {
    raw = await fs.readFile(AUDIT_FILE, "utf8");
  } catch (err: any) {
    if (err.code === "ENOENT") return { entries: [], total_matched: 0, truncated: false, corrupted_lines: 0 };
    throw err;
  }

  const matched: AuditEntry[] = [];
  let corrupted_lines = 0;
  for (const line of raw.split("\n")) {
    if (!line) continue;
    let entry: Partial<AuditEntry>;
    try {
      entry = JSON.parse(line);
    } catch {
      corrupted_lines++;
      continue;
    }
    if (filter.date_from && (!entry.timestamp || entry.timestamp.slice(0, 10) < filter.date_from)) continue;
    if (filter.date_to && (!entry.timestamp || entry.timestamp.slice(0, 10) > filter.date_to)) continue;
    matched.push(entry as AuditEntry);
  }

  const total_matched = matched.length;
  const page = matched.slice(offset, offset + limit);
  return {
    entries: page,
    total_matched,
    truncated: offset + page.length < total_matched,
    corrupted_lines,
  };
}
