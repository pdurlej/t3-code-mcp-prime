import { readFileSync, existsSync, lstatSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ServerRuntime } from "./model.js";

const RUNTIME_PATH = join(homedir(), ".t3", "userdata", "server-runtime.json");

export function databasePath(): string {
  return process.env.T3_DATABASE ?? join(homedir(), ".t3", "userdata", "state.sqlite");
}

export function localOrigin(origin: string): string {
  const url = new URL(origin);
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
      || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new ConfigError("T3 origin must be a plain loopback HTTP origin.");
  }
  return url.origin;
}

export class ConfigError extends Error {}

export function discoverOrigin(): string {
  if (process.env.T3_ORIGIN) return localOrigin(process.env.T3_ORIGIN);
  if (!existsSync(RUNTIME_PATH)) {
    throw new ConfigError(
      `T3 Code doesn't appear to be running: ${RUNTIME_PATH} not found. ` +
        `Start the T3 Code desktop app or run \`npx t3@latest\`, or set T3_ORIGIN.`,
    );
  }
  try {
    const runtime = JSON.parse(readFileSync(RUNTIME_PATH, "utf8")) as ServerRuntime;
    if (!runtime.origin) throw new Error("no origin field");
    return localOrigin(runtime.origin);
  } catch (e) {
    throw new ConfigError(`Could not read T3 server runtime file (${RUNTIME_PATH}): ${e}`);
  }
}

export function loadToken(): string {
  if (process.env.T3_TOKEN) return process.env.T3_TOKEN;
  const path = process.env.T3_TOKEN_FILE ?? join(homedir(), ".config", "t3-code-mcp-prime", "token");
  if (!existsSync(path)) throw new ConfigError("No T3 token file. See README local setup; read-only tools need no token.");
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
    throw new ConfigError("T3 token must be an owner-controlled regular file with mode 0600.");
  }
  const token = readFileSync(path, "utf8").trim();
  if (!token || /\s/.test(token)) throw new ConfigError("Invalid T3 token file.");
  return token;
}
