import { randomUUID } from "node:crypto";
import { constants, copyFileSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { databasePath } from "./config.js";

/** Mirrors T3 Code 0.0.40 limits (PROVIDER_SEND_TURN_MAX_*_BYTES). */
export const MAX_FILE_BYTES = 52_428_800;
export const MAX_IMAGE_BYTES = 10_485_760;
const IMAGE_MIME: Record<string, string> = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp" };
const FILE_MIME: Record<string, string> = {
  md: "text/markdown", txt: "text/plain", log: "text/plain", csv: "text/csv", json: "application/json", jsonl: "application/x-ndjson",
  yaml: "application/yaml", yml: "application/yaml", toml: "application/toml", xml: "application/xml", html: "text/html", pdf: "application/pdf",
  py: "text/x-python", ts: "text/typescript", js: "text/javascript", mjs: "text/javascript", sh: "text/x-shellscript", diff: "text/x-diff", patch: "text/x-diff",
};
export type StagedAttachment = { type: "image" | "file"; id: string; name: string; mimeType: string; sizeBytes: number };

/** T3 stores attachments next to its database; the server claims `pending-*` files on thread.turn.start. */
export function attachmentsDir(): string {
  return process.env.T3_ATTACHMENTS_DIR ?? join(dirname(databasePath()), "attachments");
}

/** Copy local files into T3's pending attachment area. Returns the metadata T3 expects on the message.
 * The same-machine copy replaces the UI's signed upload; T3 renames the file to the thread on send and
 * sweeps unclaimed pending files after 24h. Never reads outside the given paths. */
export function stageAttachments(paths: string[]): StagedAttachment[] {
  if (paths.length === 0) return [];
  const dir = attachmentsDir();
  mkdirSync(dir, { recursive: true });
  return paths.map(p => {
    const real = realpathSync(p);
    const st = statSync(real);
    const name = basename(real).slice(0, 255);
    if (!st.isFile()) throw new Error(`Attachment is not a regular file: ${name}`);
    if (st.size < 1) throw new Error(`Attachment is empty: ${name}`);
    const ext = extname(name).slice(1).toLowerCase();
    const isImage = Object.hasOwn(IMAGE_MIME, ext);
    if (st.size > (isImage ? MAX_IMAGE_BYTES : MAX_FILE_BYTES)) throw new Error(`Attachment exceeds T3 size limit: ${name}`);
    const safeExt = /^[a-z0-9]{1,10}$/.test(ext) ? ext : "bin";
    const id = isImage ? `pending-${randomUUID()}` : `pending-${randomUUID()}-${safeExt}`;
    copyFileSync(real, join(dir, `${id}.${safeExt}`), constants.COPYFILE_EXCL);
    return { type: isImage ? "image" : "file", id, name, mimeType: isImage ? IMAGE_MIME[ext] : (FILE_MIME[ext] ?? "application/octet-stream"), sizeBytes: st.size };
  });
}
