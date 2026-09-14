import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

export interface SendLock {
  release(): void;
  pending(threadId: string): { requestId: string; messageHash: string } | undefined;
  reserve(threadId: string, requestId: string, messageHash: string): void;
}

/** Cross-process reservation, with one last request ID/hash per thread.
 * No prompts, tokens, background jobs, or queue worker are stored here. */
export function acquireSendLock(): SendLock | null {
  const dir = process.env.T3_PRIME_STATE_DIR ?? join(homedir(), ".local", "state", "t3-code-mcp-prime");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(dir, "send-lock.sqlite"), { timeout: 0 });
  try {
    db.exec("BEGIN IMMEDIATE; CREATE TABLE IF NOT EXISTS pending_sends(thread_id TEXT PRIMARY KEY, request_id TEXT NOT NULL, message_hash TEXT NOT NULL)");
  }
  catch (error) {
    db.close();
    if ((error as { errcode?: number }).errcode === 5) return null;
    throw error;
  }
  let closed = false;
  return {
    release() { if (!closed) { try { db.exec("ROLLBACK"); } finally { db.close(); closed = true; } } },
    pending(threadId) {
      const row = db.prepare("SELECT request_id AS requestId,message_hash AS messageHash FROM pending_sends WHERE thread_id=?").get(threadId);
      return row as { requestId: string; messageHash: string } | undefined;
    },
    reserve(threadId, requestId, messageHash) {
      db.prepare("INSERT INTO pending_sends VALUES(?,?,?) ON CONFLICT(thread_id) DO UPDATE SET request_id=excluded.request_id,message_hash=excluded.message_hash").run(threadId, requestId, messageHash);
      // Persist before HTTP dispatch: a crash or delayed T3 projection must not
      // let another caller overwrite T3's single pending-start slot.
      db.exec("COMMIT"); db.close(); closed = true;
    },
  };
}
