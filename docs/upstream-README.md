# t3code-mcp

MCP server for a running [T3 Code](https://t3.codes) instance. See which agent threads exist and what they need, read their history, send them messages, approve their permission requests — from Claude Code, Claude Desktop, or (the end goal) a voice-controlled model like Hermes while away from a screen.

See `SPEC.md` for the design and `PLAN.md` for the phased build.

## Setup

```bash
pnpm install && pnpm build
```

1. Make sure T3 Code is running (desktop app or `npx t3@latest`).
2. Mint a bearer token for the local T3 server and put it in `.env` (or export it):

```bash
npx t3@latest auth session issue --token-only --label t3code-mcp --ttl 365d
echo "T3_TOKEN=<the token>" > .env
```

3. Sanity check against the live server (read-only):

```bash
pnpm smoke
```

## Connect from Claude Code

```bash
claude mcp add --scope user t3code -- node /Users/thomascrundwell/Documents/projects/t3code-mcp/dist/index.js
```

(Token is picked up from `.env` in this directory; alternatively pass `--env T3_TOKEN=...`.)

## Tools

**Visibility** — `t3_status`, `list_projects`, `list_threads` (filter by project / attention state), `get_thread`, `search_threads`

**Messaging & control** — `send_message`, `create_thread`, `wait_for_turn` (send-and-wait round trip), `interrupt_thread`, `stop_thread`, `archive_thread`, `unarchive_thread`, `set_thread_title`

**Hands-free interaction** — `pending_actions` (cross-thread "what needs me?" inbox), `respond_to_approval`, `respond_to_user_input`

**Voice layer** — `thread_digest` and `workspace_digest` (TTS-friendly `spoken` summaries), `wait_for_change` (long-poll until anything needs attention)

Every thread carries a single `attention` state: `needs-approval | needs-input | plan-ready | working | error | done | idle`.

## Remote / voice clients (HTTP mode)

For a remote voice agent (e.g. Hermes over Tailscale), run the streamable-HTTP transport with its own bearer token:

```bash
MCP_HTTP_TOKEN=<secret> node dist/index.js --http --port 3774 --host 0.0.0.0
```

Clients connect to `http://<machine>:3774/` with `Authorization: Bearer <secret>`. Binds to 127.0.0.1 unless `--host` is given; T3 Code itself stays localhost-only.

## Testing

- `pnpm smoke` — read-only pass over every query tool against the live server.
- `node scripts/smoke.mjs --mutate <projectId>` — additionally runs the full write loop (create disposable thread → agent replies → follow-up message → rename → stop → archive). Use a scratch project; "t3code-mcp scratch" (`/tmp/t3code-mcp-scratch`) exists for this.

## Notes / limitations

- Uses T3's HTTP JSON API only (`/api/orchestration/*`). Live push, git-worktree bootstrap, and turn diffs are WebSocket-RPC-only in T3, so: updates are polled, and `create_thread` runs threads directly in the project workspace (start worktree threads from the T3 UI).
- Image attachments not yet supported on `send_message`.
- Revoke access anytime: `npx t3@latest auth session list` / `... revoke`.
