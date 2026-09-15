import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { databasePath } from "./config.js";

type Row = Record<string, any>;
export type ThreadState = "working" | "starting" | "needs-approval" | "needs-input" | "plan-ready" | "completed" | "interrupted" | "error" | "idle";

export function stateOf(t: Row): ThreadState {
  if (t.pending_approval_count > 0) return "needs-approval";
  if (t.pending_user_input_count > 0) return "needs-input";
  if (t.session_status === "error" || t.turn_state === "error") return "error";
  if (t.session_status === "starting") return "starting";
  if (t.turn_state === "running" || t.session_status === "running") return "working";
  if (t.has_actionable_proposed_plan) return "plan-ready";
  if (t.turn_state === "interrupted") return "interrupted";
  if (t.turn_state === "completed") return "completed";
  return "idle";
}

const threadSelect = `SELECT t.*, p.title AS project_title, p.workspace_root AS project_path,
  s.status AS session_status, s.provider_name, s.updated_at AS session_updated_at,
  u.state AS turn_state, u.completed_at
  FROM projection_threads t
  JOIN projection_projects p USING(project_id)
  LEFT JOIN projection_thread_sessions s USING(thread_id)
  LEFT JOIN projection_turns u ON u.thread_id=t.thread_id AND u.turn_id=t.latest_turn_id`;

function parseModel(value: unknown): unknown {
  if (typeof value !== "string") return null;
  try { return JSON.parse(value); } catch { return null; }
}

export function threadRow(t: Row) {
  return { threadId: t.thread_id, title: String(t.title).slice(0, 300), projectId: t.project_id,
    project: String(t.project_title).slice(0, 300), provider: t.provider_name ?? null,
    state: stateOf(t), sessionStatus: t.session_status ?? null, turnId: t.latest_turn_id,
    turnState: t.turn_state ?? null, archived: Boolean(t.archived_at),
    updatedAt: t.updated_at, sessionUpdatedAt: t.session_updated_at ?? null,
    modelSelection: parseModel(t.model_selection_json), branch: t.branch ?? null,
    worktreePath: t.worktree_path ?? null, projectPath: t.project_path ?? null,
    runtimeMode: t.runtime_mode ?? null, interactionMode: t.interaction_mode ?? null };
}

export function messageRow(m: Row, maxChars = 800, offset = 0) {
  const text = String(m.text);
  const end = Math.min(text.length, offset + maxChars);
  return { messageId: m.message_id, threadId: m.thread_id, turnId: m.turn_id,
    role: m.role, createdAt: m.created_at, streaming: Boolean(m.is_streaming),
    text: text.slice(offset, end), offset, totalChars: text.length,
    nextOffset: end < text.length ? end : null };
}

/** The T3 database is always opened read-only. No index or migration touches it. */
export class ThreadStore {
  readonly db: DatabaseSync;
  constructor(path = databasePath()) {
    this.db = new DatabaseSync(path, { readOnly: true, timeout: 2000 });
    this.db.exec("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;");
    this.db.function("prime_contains", { deterministic: true }, (value, query) => {
      const text = String(value ?? "").toLowerCase();
      return String(query).toLowerCase().split(/\s+/).filter(Boolean).every(w => text.includes(w)) ? 1 : 0;
    });
  }
  close() { this.db.close(); }
  one(sql: string, ...args: SQLInputValue[]): Row | undefined { return this.db.prepare(sql).get(...args); }
  all(sql: string, ...args: SQLInputValue[]): Row[] { return this.db.prepare(sql).all(...args); }
  thread(id: string): Row {
    const t = this.one(`${threadSelect} WHERE t.thread_id=? AND t.deleted_at IS NULL`, id);
    if (!t) throw new Error("Thread not found.");
    return t;
  }
  message(threadId: string, messageId: string): Row {
    this.thread(threadId);
    const m = this.one("SELECT * FROM projection_thread_messages WHERE thread_id=? AND message_id=?", threadId, messageId);
    if (!m) throw new Error("Message not found in this thread.");
    return m;
  }
  list(args: { query?: string; projectId?: string; state?: string; includeArchived?: boolean; limit: number; offset: number }) {
    const where = ["t.deleted_at IS NULL", "p.deleted_at IS NULL"];
    const values: SQLInputValue[] = [];
    if (!args.includeArchived) where.push("t.archived_at IS NULL");
    if (args.projectId) { where.push("t.project_id=?"); values.push(args.projectId); }
    if (args.query) { where.push("prime_contains(t.title || ' ' || p.title || ' ' || coalesce(t.branch,''),?)"); values.push(args.query); }
    // State filtering uses the same function as the detail and wait surfaces.
    const rows = this.all(`${threadSelect} WHERE ${where.join(" AND ")} ORDER BY t.updated_at DESC,t.thread_id DESC`, ...values)
      .filter(t => !args.state || stateOf(t) === args.state);
    const page = rows.slice(args.offset, args.offset + args.limit).map(threadRow);
    return { threads: page, nextOffset: args.offset + page.length < rows.length ? args.offset + page.length : null };
  }
  search(args: { groupByThread?: boolean; query: string; projectId?: string; threadId?: string; role?: string; includeArchived?: boolean; limit: number; offset: number; snippetChars: number }) {
    const where = ["t.deleted_at IS NULL", "p.deleted_at IS NULL", "prime_contains(m.text,?)"];
    const values: SQLInputValue[] = [args.query];
    if (!args.includeArchived) where.push("t.archived_at IS NULL");
    if (args.projectId) { where.push("t.project_id=?"); values.push(args.projectId); }
    if (args.threadId) { where.push("m.thread_id=?"); values.push(args.threadId); }
    if (args.role) { where.push("m.role=?"); values.push(args.role); }
    const selection = `SELECT m.*,t.title,t.project_id FROM projection_thread_messages m
      JOIN projection_threads t USING(thread_id) JOIN projection_projects p USING(project_id)
      WHERE ${where.join(" AND ")}`;
    const sql = args.groupByThread
      ? `WITH matching AS (${selection}), ranked AS (
          SELECT matching.*, count(*) OVER (PARTITION BY thread_id) AS hit_count,
            row_number() OVER (PARTITION BY thread_id ORDER BY created_at DESC,message_id DESC) AS position
          FROM matching)
        SELECT * FROM ranked WHERE position=1 ORDER BY created_at DESC,message_id DESC LIMIT ? OFFSET ?`
      : `${selection} ORDER BY m.created_at DESC,m.message_id DESC LIMIT ? OFFSET ?`;
    const rows = this.all(sql, ...values, args.limit + 1, args.offset);
    const matches = rows.slice(0, args.limit).map(m => {
      const at = String(m.text).toLowerCase().indexOf(args.query.toLowerCase().split(/\s+/)[0]);
      const offset = Math.max(0, at - Math.floor(args.snippetChars / 3));
      return { ...messageRow(m, args.snippetChars, offset), title: String(m.title).slice(0, 200), projectId: m.project_id,
        ...(args.groupByThread ? { hitCount: m.hit_count, state: stateOf(this.thread(m.thread_id)) } : {}) };
    });
    return { matches, nextOffset: rows.length > args.limit ? args.offset + args.limit : null,
      searchMode: "all words, literal case-insensitive; live read-only scan, no embeddings" };
  }
  read(args: { threadId: string; centerMessageId?: string; beforeMessageId?: string; limit: number; maxMessageChars: number }) {
    const t = this.thread(args.threadId);
    let messages: Row[];
    let hasMoreBefore = false, hasMoreAfter = false;
    const earlier = `(created_at < ? OR (created_at = ? AND message_id < ?))`;
    const later = `(created_at > ? OR (created_at = ? AND message_id > ?))`;
    if (args.centerMessageId) {
      const center = this.message(args.threadId, args.centerMessageId);
      const half = Math.floor((args.limit - 1) / 2);
      const left = this.all(`SELECT * FROM projection_thread_messages WHERE thread_id=? AND ${earlier} ORDER BY created_at DESC,message_id DESC LIMIT ?`, args.threadId, center.created_at, center.created_at, center.message_id, half + 1);
      const rightCount = args.limit - 1 - Math.min(half, left.length);
      const right = this.all(`SELECT * FROM projection_thread_messages WHERE thread_id=? AND ${later} ORDER BY created_at,message_id LIMIT ?`, args.threadId, center.created_at, center.created_at, center.message_id, rightCount + 1);
      hasMoreBefore = left.length > half; hasMoreAfter = right.length > rightCount;
      messages = [...left.slice(0, half).reverse(), center, ...right.slice(0, rightCount)];
    } else {
      const cursor = args.beforeMessageId ? this.message(args.threadId, args.beforeMessageId) : null;
      const rows = this.all(`SELECT * FROM projection_thread_messages WHERE thread_id=? ${cursor ? `AND ${earlier}` : ""} ORDER BY created_at DESC,message_id DESC LIMIT ?`, args.threadId,
        ...(cursor ? [cursor.created_at, cursor.created_at, cursor.message_id] : []), args.limit + 1);
      hasMoreBefore = rows.length > args.limit;
      messages = rows.slice(0, args.limit).reverse();
    }
    return { thread: threadRow(t), messages: messages.map(m => messageRow(m, args.maxMessageChars)),
      beforeMessageId: hasMoreBefore ? messages[0]?.message_id ?? null : null, hasMoreAfter };
  }
  request(threadId: string, messageId: string) {
    const m = this.one("SELECT * FROM projection_thread_messages WHERE message_id=?", messageId);
    if (!m) return undefined;
    if (m.thread_id !== threadId) throw new Error("Request belongs to a different thread.");
    if (m.role !== "user") throw new Error("requestId must identify a user message.");
    return this.one("SELECT * FROM projection_turns WHERE thread_id=? AND pending_message_id=? ORDER BY row_id DESC LIMIT 1", threadId, messageId);
  }
  replies(threadId: string, turnId: string) {
    return this.all("SELECT * FROM projection_thread_messages WHERE thread_id=? AND turn_id=? AND role='assistant' ORDER BY created_at,message_id", threadId, turnId);
  }
}
