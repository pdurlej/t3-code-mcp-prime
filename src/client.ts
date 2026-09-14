import { discoverOrigin, loadToken, ConfigError, localOrigin } from "./config.js";
import type { ShellSnapshot, ThreadDetailSnapshot } from "./model.js";

export class T3Error extends Error {}

export interface EnvironmentInfo {
  environmentId: string;
  label: string;
  serverVersion: string;
  platform?: Record<string, unknown>;
}

export interface DispatchResult {
  sequence: number;
}

export class T3Client {
  constructor(
    readonly origin: string,
    private readonly token: string,
  ) { localOrigin(origin); }

  private async req<T>(path: string, init?: RequestInit): Promise<T> {
    let res: Response;
    try {
      res = await fetch(`${this.origin}${path}`, {
        ...init,
        redirect: "error",
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(init?.body ? { "content-type": "application/json" } : {}),
          ...init?.headers,
        },
        signal: init?.signal ?? AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new T3Error(
        `Could not reach the T3 Code server at ${this.origin} (${(e as Error).message}). ` +
          `Is T3 Code running? Start the desktop app or \`npx t3@latest\`.`,
      );
    }
    if (res.status === 401 || res.status === 403) {
      throw new T3Error(
        `T3 Code rejected the auth token (${res.status}). Check the local token file and scopes.`,
      );
    }
    if (!res.ok) {
      throw new T3Error(`T3 API request failed: HTTP ${res.status}. No response body logged.`);
    }
    return (await res.json()) as T;
  }

  /** Unauthenticated liveness + identity probe. */
  async probe(): Promise<EnvironmentInfo> {
    let res: Response;
    try {
      res = await fetch(`${this.origin}/.well-known/t3/environment`, {
        redirect: "error",
        signal: AbortSignal.timeout(3_000),
      });
    } catch (e) {
      throw new T3Error(
        `T3 Code server at ${this.origin} is not responding (${(e as Error).message}). ` +
          `Start the desktop app or \`npx t3@latest\`.`,
      );
    }
    if (!res.ok) throw new T3Error(`T3 probe failed: HTTP ${res.status}`);
    return (await res.json()) as EnvironmentInfo;
  }

  shell(): Promise<ShellSnapshot> {
    return this.req<ShellSnapshot>("/api/orchestration/shell");
  }

  thread(
    threadId: string,
    opts: { turnLimit?: number; beforeCursor?: string } = {},
  ): Promise<ThreadDetailSnapshot> {
    const params = new URLSearchParams();
    if (opts.turnLimit !== undefined) params.set("turnLimit", String(opts.turnLimit));
    if (opts.beforeCursor) params.set("beforeCursor", opts.beforeCursor);
    const qs = params.size ? `?${params}` : "";
    return this.req<ThreadDetailSnapshot>(
      `/api/orchestration/threads/${encodeURIComponent(threadId)}${qs}`,
    );
  }

  dispatch(command: Record<string, unknown>): Promise<DispatchResult> {
    return this.req<DispatchResult>("/api/orchestration/dispatch", {
      method: "POST",
      body: JSON.stringify(command),
    });
  }
}

/** Build a client from env/discovery. Throws ConfigError/T3Error with actionable messages. */
export function makeClient(): T3Client {
  return new T3Client(discoverOrigin(), loadToken());
}

export { ConfigError };
