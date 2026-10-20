import { DatabaseSync } from "node:sqlite";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  randomUUID,
} from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import path from "node:path";
import {
  digest,
  type Execution,
  type Proposal,
  type Result,
  WebError,
} from "./contracts.js";
export class WebJournal {
  private db: DatabaseSync;
  constructor(
    file: string,
    private key: Buffer,
  ) {
    if (key.length !== 32)
      throw new Error("Web encryption key must be 32 bytes");
    mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(file);
    chmodSync(file, 0o600);
    this.db
      .exec(`PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS web_meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS web_proposals(id TEXT PRIMARY KEY,expires INTEGER NOT NULL,data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS web_operations(id TEXT PRIMARY KEY,hash TEXT NOT NULL,target TEXT NOT NULL,proposal TEXT NOT NULL UNIQUE,data TEXT NOT NULL,result TEXT NOT NULL);`);
  }
  seal(value: unknown): string {
    const iv = randomBytes(12),
      c = createCipheriv("aes-256-gcm", this.key, iv);
    const body = Buffer.concat([c.update(JSON.stringify(value)), c.final()]);
    return Buffer.concat([iv, c.getAuthTag(), body]).toString("base64");
  }
  open<T>(value: string): T {
    const b = Buffer.from(value, "base64"),
      c = createDecipheriv("aes-256-gcm", this.key, b.subarray(0, 12));
    c.setAuthTag(b.subarray(12, 28));
    return JSON.parse(
      Buffer.concat([c.update(b.subarray(28)), c.final()]).toString(),
    );
  }
  meta<T>(key: string): T | undefined {
    const row = this.db
      .prepare("SELECT value FROM web_meta WHERE key=?")
      .get(key) as any;
    return row ? this.open<T>(row.value) : undefined;
  }
  setMeta(key: string, value: unknown): void {
    this.db
      .prepare(
        "INSERT INTO web_meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
      )
      .run(key, this.seal(value));
  }
  epoch(): string {
    return this.meta<string>("epoch") || this.rotateEpoch();
  }
  rotateEpoch(): string {
    const value = randomUUID();
    this.setMeta("epoch", value);
    return value;
  }
  putProposal(p: Proposal, baseline: unknown): void {
    this.db
      .prepare(
        "DELETE FROM web_proposals WHERE expires < ? AND NOT EXISTS (SELECT 1 FROM web_operations WHERE proposal=web_proposals.id)",
      )
      .run(Date.now());
    this.db
      .prepare("INSERT INTO web_proposals VALUES(?,?,?)")
      .run(p.proposal_id, p.expires_at, this.seal({ proposal: p, baseline }));
  }
  getProposal(id: string): { proposal: Proposal; baseline: any } {
    const row = this.db
      .prepare("SELECT data FROM web_proposals WHERE id=?")
      .get(id) as any;
    if (!row) throw new WebError("proposal_missing");
    return this.open(row.data);
  }
  operation(id: string): { execution: Execution; result: Result } | undefined {
    const row = this.db
      .prepare("SELECT data,result FROM web_operations WHERE id=?")
      .get(id) as any;
    return row
      ? { execution: this.open(row.data), result: this.open(row.result) }
      : undefined;
  }
  begin(input: Execution): Result {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const hash = digest(input),
        p = input.proposal,
        target = digest([p.account_id, p.action, p.target_id]);
      const old = this.db
        .prepare("SELECT hash,result FROM web_operations WHERE id=?")
        .get(input.operation_id) as any;
      if (old) {
        if (old.hash !== hash) throw new WebError("operation_payload_changed");
        throw new WebError("operation_already_dispatched");
      }
      if (
        this.db
          .prepare("SELECT id FROM web_operations WHERE proposal=?")
          .get(p.proposal_id)
      )
        throw new WebError("proposal_already_used");
      const others = this.db
        .prepare("SELECT result FROM web_operations WHERE target=?")
        .all(target) as any[];
      if (
        others.some((r) =>
          ["dispatched", "uncertain"].includes(
            this.open<Result>(r.result).outcome,
          ),
        )
      )
        throw new WebError("target_has_unresolved_operation");
      const result: Result = {
        operation_id: input.operation_id,
        outcome: "dispatched",
      };
      this.db
        .prepare("INSERT INTO web_operations VALUES(?,?,?,?,?,?)")
        .run(
          input.operation_id,
          hash,
          target,
          p.proposal_id,
          this.seal(input),
          this.seal(result),
        );
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  save(result: Result): void {
    this.db
      .prepare("UPDATE web_operations SET result=? WHERE id=?")
      .run(this.seal(result), result.operation_id);
  }
  close(): void {
    this.db.close();
  }
}
