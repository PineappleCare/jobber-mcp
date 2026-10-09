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
      CREATE TABLE IF NOT EXISTS voice_steps(operation_id TEXT NOT NULL,name TEXT NOT NULL,state TEXT NOT NULL,record TEXT,PRIMARY KEY(operation_id,name));
 CREATE TABLE IF NOT EXISTS voice_checkpoints(key TEXT PRIMARY KEY,value TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS voice_operation_meta(id TEXT PRIMARY KEY,attempts INTEGER NOT NULL DEFAULT 0,last_attempt INTEGER NOT NULL DEFAULT 0,lease_until INTEGER NOT NULL DEFAULT 0);
 CREATE TABLE IF NOT EXISTS voice_reservations(key TEXT PRIMARY KEY,operation_id TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS voice_directory_records(account TEXT NOT NULL,generation TEXT NOT NULL,kind TEXT NOT NULL,id TEXT NOT NULL,client TEXT NOT NULL,data TEXT NOT NULL,PRIMARY KEY(account,generation,kind,id));
 CREATE TABLE IF NOT EXISTS voice_directory(account TEXT PRIMARY KEY,generation TEXT NOT NULL,completed INTEGER NOT NULL,failed INTEGER);
 CREATE TABLE IF NOT EXISTS voice_directory_phones(account TEXT NOT NULL,generation TEXT NOT NULL,phone TEXT NOT NULL,client TEXT NOT NULL,PRIMARY KEY(account,generation,phone,client));`);
  }
  counts(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const row of this.db.prepare("SELECT json_extract(result,'$.outcome') AS outcome,count(*) AS count FROM voice_operations GROUP BY outcome").all() as any[]) result[row.outcome]=row.count;
    return result;
  }
  pending(): {id:string;call:string}[] {
    return this.db.prepare("SELECT o.id,o.call_id AS call FROM voice_operations o LEFT JOIN voice_operation_meta m ON m.id=o.id WHERE json_extract(o.result,'$.outcome') IN ('pending','uncertain') AND COALESCE(json_extract(o.result,'$.retry_at'),0)<=? AND COALESCE(m.lease_until,0)<=? ORDER BY COALESCE(m.last_attempt,0),COALESCE(json_extract(o.result,'$.retry_at'),0),o.rowid LIMIT 10").all(Date.now(),Date.now()) as any;
  }
  claim(id:string): boolean {
    this.db.prepare("INSERT OR IGNORE INTO voice_operation_meta(id) VALUES(?)").run(id);
    return !!this.db.prepare("UPDATE voice_operation_meta SET attempts=attempts+1,last_attempt=?,lease_until=? WHERE id=? AND lease_until<=?").run(Date.now(),Date.now()+120000,id,Date.now()).changes;
  }
  renew(id:string):void {this.db.prepare("UPDATE voice_operation_meta SET lease_until=? WHERE id=?").run(Date.now()+120000,id);}
  release(id:string):void {this.db.prepare("UPDATE voice_operation_meta SET lease_until=0 WHERE id=?").run(id);}
  retryAt(id:string):number {
    const row=this.db.prepare("SELECT attempts FROM voice_operation_meta WHERE id=?").get(id) as any;
    return Date.now()+Math.min(300000,15000*2**Math.min(5,Math.max(0,(row?.attempts || 1)-1)));
  }
  safeToReconfirm(id:string):boolean {
    return !(this.db.prepare("SELECT 1 FROM voice_steps WHERE operation_id=? AND state!='rejected' LIMIT 1").get(id));
  }
  reserve(keys:string[],id:string):boolean {
    this.db.exec("BEGIN IMMEDIATE");try {
      for(const key of keys) {
        const old=this.db.prepare("SELECT operation_id FROM voice_reservations WHERE key=?").get(key) as any;
        if(old && old.operation_id!==id){this.db.exec("ROLLBACK");return false;}
        this.db.prepare("INSERT OR IGNORE INTO voice_reservations VALUES(?,?)").run(key,id);
      }
      this.db.exec("COMMIT");return true;
    }catch(e){this.db.exec("ROLLBACK");throw e;}
  }
  releaseReservations(id:string):void {this.db.prepare("DELETE FROM voice_reservations WHERE operation_id=?").run(id);}
  checkpoint(key:string): any { const row=this.db.prepare("SELECT value FROM voice_checkpoints WHERE key=?").get(key) as any; return row ? JSON.parse(row.value):undefined; }
  setCheckpoint(key:string,value:unknown):void { this.db.prepare("INSERT INTO voice_checkpoints VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key,JSON.stringify(value)); }
  deleteCheckpoint(key:string):void {this.db.prepare("DELETE FROM voice_checkpoints WHERE key=?").run(key);}
  directoryStatus(account:string):Record<string,unknown> { const row=this.db.prepare("SELECT completed,failed FROM voice_directory WHERE account=?").get(account) as any; const failure=this.checkpoint(`directory-failure:${account}`),progress=this.checkpoint(`directory:${account}`); return {complete:!!row,completed_at:row?.completed ?? null,last_failure_at:row?.failed ?? failure?.at ?? null,last_failure_stage:failure?.stage ?? null,last_failure_reason:failure?.reason_code ?? null,refresh_in_progress:!!progress,refresh_clients:progress?.clients?.length ?? 0,refresh_contacts_completed:progress?.clientOffset ?? 0}; }
  directoryCandidates(account:string,phone:string):string[]|undefined {
    const row=this.db.prepare("SELECT generation FROM voice_directory WHERE account=?").get(account) as any;
    if(!row)return undefined;
    return (this.db.prepare("SELECT client FROM voice_directory_phones WHERE account=? AND generation=? AND phone=?").all(account,row.generation,phone) as any[]).map(r=>r.client);
  }
  addDirectoryRecord(account:string,generation:string,kind:string,id:string,client:string,data:unknown):void {
    this.db.prepare("INSERT INTO voice_directory_records VALUES(?,?,?,?,?,?) ON CONFLICT(account,generation,kind,id) DO UPDATE SET data=excluded.data").run(account,generation,kind,id,client,JSON.stringify(data));
  }
  directoryRecords(account:string):any[]|undefined {
    const row=this.db.prepare("SELECT generation FROM voice_directory WHERE account=?").get(account) as any;
    if(!row || this.checkpoint(`directory-metadata:${account}`)?.generation!==row.generation)return undefined;
    return (this.db.prepare("SELECT kind,client,data FROM voice_directory_records WHERE account=? AND generation=?").all(account,row.generation) as any[]).map(r=>({...r,data:JSON.parse(r.data)}));
  }
  addDirectoryPhone(account:string,generation:string,phone:string,client:string):void {this.db.prepare("INSERT OR IGNORE INTO voice_directory_phones VALUES(?,?,?,?)").run(account,generation,phone,client);}
  publishDirectory(account:string,generation:string):void {
 this.deleteCheckpoint(`directory-failure:${account}`);
    this.db.exec("BEGIN IMMEDIATE");try {
      this.db.prepare("INSERT INTO voice_directory VALUES(?,?,?,NULL) ON CONFLICT(account) DO UPDATE SET generation=excluded.generation,completed=excluded.completed,failed=NULL").run(account,generation,Date.now());
      this.db.prepare("DELETE FROM voice_directory_phones WHERE account=? AND generation!=?").run(account,generation);
      this.db.prepare("DELETE FROM voice_directory_records WHERE account=? AND generation!=?").run(account,generation);
      this.db.exec("COMMIT");
    } catch(e){this.db.exec("ROLLBACK");throw e;}
  }
  directoryFailure(account:string,details:{stage:string,reason_code:string}):void {this.setCheckpoint(`directory-failure:${account}`,{at:Date.now(),...details});this.db.prepare("UPDATE voice_directory SET failed=? WHERE account=?").run(Date.now(),account);}
  close(): void { this.db.close(); }
  hasOperation(id: string): boolean {return !!this.db.prepare("SELECT 1 FROM voice_operations WHERE id=?").get(id);}
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
  operationCall(id:string):string {const row=this.db.prepare("SELECT call_id FROM voice_operations WHERE id=?").get(id) as any;if(!row)throw new Error("Operation not found");return row.call_id;}
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
  notDispatched(id:string,name:string):void {this.db.prepare("DELETE FROM voice_steps WHERE operation_id=? AND name=? AND state='dispatched' AND record IS NULL").run(id,name);}
  clearScan(id:string):void {this.db.prepare("DELETE FROM voice_checkpoints WHERE key LIKE ?").run(`scan:${id}:%`);}
  returned(id: string, name: string, record: VoiceResult): void {
    this.db.prepare("UPDATE voice_steps SET state='returned',record=? WHERE operation_id=? AND name=?").run(JSON.stringify(record), id, name);
  }
  rejected(id: string, name: string, errors: unknown[]): void {
    this.db.prepare("UPDATE voice_steps SET state='rejected',record=? WHERE operation_id=? AND name=?").run(JSON.stringify({ validation_errors: errors }), id, name);
  }
  verified(id: string, name: string, record: VoiceResult): void {
    this.db.prepare("UPDATE voice_steps SET state='verified',record=? WHERE operation_id=? AND name=?").run(JSON.stringify(record), id, name);
  }
}
