import { DatabaseSync } from "node:sqlite";
import { mkdirSync, lstatSync, chmodSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";

export const digest = (text: string) => createHash("sha256").update(text).digest("hex");
export const stateDirectory = () => process.env.T3_PRIME_STATE_DIR ?? join(homedir(), ".local", "state", "t3-code-mcp-prime");
export type Mail = { request_id: string; thread_id: string; text: string | null; payload_hash: string; status: string; attempts: number; next_attempt: number; purpose: string };
export type Review = { review_id: string; route_id: string; writer_id: string; reviewer_id: string; event_id: string; work_ref: string; request_id: string; feedback_id: string; resolution_id: string; phase: string; payload_hash: string };

/** Local delivery state only. Bodies are removed once the T3 projection confirms receipt. */
export class Mailbox {
  readonly db: DatabaseSync;
  constructor(binding: string, directory = stateDirectory()) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const stat = lstatSync(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || (process.getuid && stat.uid !== process.getuid())) throw new Error("Mailbox directory must be owned by the current user and not a symlink.");
    chmodSync(directory, 0o700);
    const path = join(directory, "mailbox.sqlite");
    try {
      const file = lstatSync(path);
      if (!file.isFile() || file.isSymbolicLink() || (process.getuid && file.uid !== process.getuid())) throw new Error("Unsafe mailbox file.");
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
    this.db = new DatabaseSync(path, { timeout: 2000 });
    chmodSync(path, 0o600);
    this.db.exec(`PRAGMA secure_delete=ON; PRAGMA trusted_schema=OFF;
      CREATE TABLE IF NOT EXISTS binding (id INTEGER PRIMARY KEY CHECK(id=1), value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS outbox (
        request_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, text TEXT,
        payload_hash TEXT NOT NULL, purpose TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'pending',
        attempts INTEGER NOT NULL DEFAULT 0, next_attempt INTEGER NOT NULL DEFAULT 0,
        last_error TEXT, created_at TEXT NOT NULL, confirmed_at TEXT);
      CREATE TABLE IF NOT EXISTS reviews (
        review_id TEXT PRIMARY KEY, route_id TEXT NOT NULL, writer_id TEXT NOT NULL, reviewer_id TEXT NOT NULL,
        event_id TEXT NOT NULL, work_ref TEXT NOT NULL, payload_hash TEXT NOT NULL,
        request_id TEXT NOT NULL, feedback_id TEXT NOT NULL, resolution_id TEXT NOT NULL,
        phase TEXT NOT NULL, created_at TEXT NOT NULL, UNIQUE(route_id,event_id));
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_review ON reviews(route_id) WHERE phase NOT IN ('closed','cancelled');
      CREATE TABLE IF NOT EXISTS pump_lock(id INTEGER PRIMARY KEY CHECK(id=1), owner TEXT, expires INTEGER NOT NULL DEFAULT 0);
      INSERT OR IGNORE INTO pump_lock(id) VALUES(1);`);
    this.db.prepare("INSERT OR IGNORE INTO binding VALUES(1,?)").run(binding);
    if ((this.db.prepare("SELECT value FROM binding WHERE id=1").get() as {value:string}).value !== binding) {
      this.db.close(); throw new Error("Mailbox belongs to a different T3 database/origin. Use its original configuration.");
    }
  }
  close() { this.db.close(); }
  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const r = fn(); this.db.exec("COMMIT"); return r; }
    catch (e) { this.db.exec("ROLLBACK"); throw e; }
  }
  enqueue(requestId: string, threadId: string, text: string, purpose = "message") {
    if (!text.trim() || text.length > 16000 || text !== text.trim()) throw new Error("Queued message must be trimmed and contain 1–16000 characters.");
    const hash = digest(JSON.stringify([threadId, text]));
    const existing = this.mail(requestId);
    if (existing) {
      if (existing.payload_hash !== hash || existing.purpose !== purpose) throw new Error("requestId already belongs to another queued message.");
      return existing;
    }
    this.db.prepare("INSERT INTO outbox(request_id,thread_id,text,payload_hash,purpose,created_at) VALUES(?,?,?,?,?,?)")
      .run(requestId, threadId, text, hash, purpose, new Date().toISOString());
    return this.mail(requestId)!;
  }
  mail(id: string) { return this.db.prepare("SELECT * FROM outbox WHERE request_id=?").get(id) as Mail | undefined; }
  review(id: string) { return this.db.prepare("SELECT * FROM reviews WHERE review_id=?").get(id) as Review | undefined; }
  confirm(id: string) { this.db.prepare("UPDATE outbox SET status='delivered',text=NULL,last_error=NULL,confirmed_at=? WHERE request_id=?").run(new Date().toISOString(),id); }
  defer(id: string, reason: string) {
    const m = this.mail(id)!;
    const delay = Math.min(300_000, 15_000 * 2 ** Math.min(m.attempts, 5));
    this.db.prepare("UPDATE outbox SET next_attempt=?,last_error=? WHERE request_id=?").run(Date.now()+delay,reason,id);
  }
  acquire(owner: string) {
    return this.db.prepare("UPDATE pump_lock SET owner=?,expires=? WHERE id=1 AND expires<?")
      .run(owner,Date.now()+120_000,Date.now()).changes === 1;
  }
  renew(owner: string) { return this.db.prepare("UPDATE pump_lock SET expires=? WHERE id=1 AND owner=?").run(Date.now()+120_000,owner).changes === 1; }
  release(owner: string) { this.db.prepare("UPDATE pump_lock SET owner=NULL,expires=0 WHERE id=1 AND owner=?").run(owner); }
}
