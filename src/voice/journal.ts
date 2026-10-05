import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";

export function fingerprint(value: unknown): string {
  const stable = (v: unknown): unknown => Array.isArray(v) ? v.map(stable) : v && typeof v === "object"
    ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => a.localeCompare(b)).map(([k, x]) => [k, stable(x)])) : v;
  return createHash("sha256").update(JSON.stringify(stable(value))).digest("hex");
}
export type VoiceResult = Record<string, any>;
export class VoiceJournal {
  private db: DatabaseSync;
  constructor(file: string) {
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS voice_operations(id TEXT PRIMARY KEY,call_id TEXT NOT NULL,payload_hash TEXT NOT NULL,result TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS voice_steps(operation_id TEXT NOT NULL,name TEXT NOT NULL,state TEXT NOT NULL,record TEXT,PRIMARY KEY(operation_id,name));`);
  }
  counts(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const row of this.db.prepare("SELECT json_extract(result,'$.outcome') AS outcome,count(*) AS count FROM voice_operations GROUP BY outcome").all() as any[]) result[row.outcome]=row.count;
    return result;
  }
  close(): void { this.db.close(); }
  start(id: string, call: string, payload: unknown): VoiceResult {
    const hash = fingerprint(payload);
    const old = this.db.prepare("SELECT * FROM voice_operations WHERE id=?").get(id) as any;
    if (old) {
      if (old.call_id !== call || old.payload_hash !== hash) throw new Error("Operation ID collision");
      return JSON.parse(old.result);
    }
    const result = { operation_id: id, outcome: "pending", records: {} };
    this.db.prepare("INSERT INTO voice_operations VALUES(?,?,?,?,?)").run(id, call, hash, JSON.stringify(result), JSON.stringify(payload));
    return result;
  }
  get(id: string, call: string): VoiceResult {
    const row = this.db.prepare("SELECT result FROM voice_operations WHERE id=? AND call_id=?").get(id, call) as any;
    if (!row) throw new Error("Operation not found for this call");
    return JSON.parse(row.result);
  }
  input(id: string, call: string): unknown {
    const row = this.db.prepare("SELECT payload FROM voice_operations WHERE id=? AND call_id=?").get(id, call) as any;
    if (!row) throw new Error("Operation not found for this call");
    return JSON.parse(row.payload);
  }
  save(id: string, result: VoiceResult): void {
    this.db.prepare("UPDATE voice_operations SET result=? WHERE id=?").run(JSON.stringify(result), id);
  }
  step(id: string, name: string): { state: string; record: VoiceResult | null } | undefined {
    const row = this.db.prepare("SELECT state,record FROM voice_steps WHERE operation_id=? AND name=?").get(id, name) as any;
    return row ? { state: row.state, record: row.record ? JSON.parse(row.record) : null } : undefined;
  }
  dispatched(id: string, name: string): void {
    this.db.prepare("INSERT INTO voice_steps VALUES(?,?,'dispatched',NULL)").run(id, name);
  }
  returned(id: string, name: string, record: VoiceResult): void {
    this.db.prepare("UPDATE voice_steps SET state='returned',record=? WHERE operation_id=? AND name=?").run(JSON.stringify(record), id, name);
  }
  verified(id: string, name: string, record: VoiceResult): void {
    this.db.prepare("UPDATE voice_steps SET state='verified',record=? WHERE operation_id=? AND name=?").run(JSON.stringify(record), id, name);
  }
}
