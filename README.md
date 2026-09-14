# T3 Code MCP Prime

A fork of [ThomasCrund/t3code-mcp](https://github.com/ThomasCrund/t3code-mcp),
inspired by [Prime Intellect's Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent).
Find the relevant part of another T3 conversation, inspect its state, and ask it
an authorized follow-up without copying the whole conversation into your context.

## What “Prime” means here

Prime Agent keeps working data in a programmable environment and exposes small,
selected views to the model. We borrow that approach: search first, read a window,
keep large results in a Python/JavaScript variable, and expose only relevant excerpts.
We also borrow the distinction between observing another agent and messaging it.
This is not Prime Agent's runtime, a persistent Python kernel, or its `/refine` memory
system. No Prime source code is copied. There is no automatic memory rewriting.

This fork retains upstream history and its HTTP client/model contracts.
The original README/design/smoke script are retained under `docs/upstream-*` and
`scripts/upstream-smoke.mjs` for provenance, not as current operating instructions.
Upstream HEAD: `3b5cb72572af569a90ff13e30785f1cc6cd9bf18`.
The fetched upstream contains no LICENSE file. This fork preserves upstream notices
and adds no license grant. The package is marked private to prevent accidental npm publication.

## Use

Requires Node 24+ with `node:sqlite`, pnpm and T3 Code running on this Mac.
Validated against T3 Code 0.0.40; internal projection schemas can change.

```sh
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
pnpm test
node dist/cli.js t3_status
node dist/cli.js list_threads '{"query":"macbook","limit":5}'
node dist/cli.js search_messages '{"query":"Prime", "limit":3}'
```

The seven MCP tools and JSON CLI have the same names and arguments:

| Tool | Purpose |
| --- | --- |
| `t3_status` | T3 liveness/version and read-only database availability |
| `list_threads` | Find titles/projects/branches, filter exact status, page with `offset` |
| `search_messages` | Search actual message text; all words, case-insensitive, optional project/thread/role scope |
| `get_thread` | Recent messages, a page before `beforeMessageId`, or a window around `centerMessageId` |
| `get_message` | Read a chosen message by `offset` and `maxChars`, without losing its ID |
| `send_message` | Send an instruction to an existing idle thread, preserving its permission/model modes |
| `wait_for_turn` | Wait for the exact `requestId`, not the latest unrelated response |

Defaults are deliberately small: five search hits with 400-character snippets,
five messages with 800 characters each, and 2,000 characters for a reply.
Every text chunk includes its full length and `nextOffset` when more remains.
Search reports snippet offsets; hydrate any chosen result using its thread/message IDs.
`search_messages` searches live SQLite text, not attachments, tool results, or a vector index.
Multiword queries require every word in the message; the snippet is anchored at the first word.
Use `groupByThread:true` to return one representative message per matching thread,
with `hitCount` (matching messages after all filters) and current thread `state`.
The representative is the newest matching message, with message ID breaking timestamp ties;
it is not a semantic relevance ranking. Groups are ordered by their representative's recency.
`limit` and `offset` then page threads, not messages. `messageId` remains usable as
`get_thread.centerMessageId`. With the flag omitted or false, search is unchanged.
For a small overview: `t3-mcp-prime search_messages '{"query":"memory","groupByThread":true,"limit":3,"snippetChars":160}'`.
Payload size depends on titles and text; this is bounded by the existing limits, not a fixed byte cap.

Offset pagination is a live view: new messages can move result positions between requests.
Historical tool evidence remains in T3's provider logs; this service does not dump those logs.

After local registration:

```sh
t3-mcp-prime search_messages '{"query":"Prime", "limit":3}'
python3 examples/context.py Prime
```

`examples/context.py` shows the Prime-inspired pattern with Python's standard library:
parse JSON into a variable and print only selected excerpts. It makes no model API calls.
For long inputs, use `t3-mcp-prime TOOL --stdin`; every CLI response is `{ok,data}`
or `{ok:false,error}` with a nonzero process exit status.

## Sending, waiting, and busy threads

```sh
t3-mcp-prime send_message '{"threadId":"...","message":"Review this decision; do not edit files.","waitUntilIdleSeconds":20}'
t3-mcp-prime wait_for_turn '{"threadId":"...","requestId":"UUID from send","timeoutSeconds":30}'
```

T3 0.0.40 has one pending start slot per thread, not a reliable FIFO. Prime serializes
its send operations across local MCP/CLI processes with an OS-backed SQLite reservation in
`~/.local/state/t3-code-mcp-prime/send-lock.sqlite`. The local database keeps only the last request ID and content hash per thread. It stores no
prompts, tokens, or jobs; process exit releases its lock. The reservation survives a crash
or delayed T3 projection, so a later send cannot overwrite an accepted start. An uncertain
request must be retried with the same ID and message before a new request can proceed. T3's database is never written
by the read/search layer.

If the thread is busy, `send_message` waits up to `waitUntilIdleSeconds` (default 0,
maximum 40), then returns `accepted:false, outcome:"busy"`. Nothing was sent or queued.
When an unresolved earlier reservation blocks a new send, the response includes
`blockingRequestId` and `blockingRequestState`. Inspect that ID with `wait_for_turn`.
If it is still unmapped, retry `send_message` using the **blocking ID and original text**,
not the new rejected request. A mismatched body is rejected. The original caller must
retain the text; Prime deliberately stores only its hash. Do not delete the reservation
or expire it by time: a failed HTTP response does not prove T3 rejected the command.

This is a bounded wait-before-send, **not a durable background queue or mid-turn steering**.
It does not survive client cancellation as a queued job. Other tools/T3 UI are outside the
Prime lock, so do not simultaneously send through the UI and Prime to the same thread.

Accepted sends return a UUID `requestId` used as both T3 command and user-message identity.
Reuse that UUID on any retry; never create a new request after an ambiguous network error.
The wait tool follows `projection_turns.pending_message_id` to its actual turn and only
returns assistant messages belonging to that turn. Unmapped requests time out rather than
borrowing a different reply. `completed`, `interrupted`, `error`, blocked and unavailable
are distinct. Completion means the turn ended; it does not certify the agent's claims.
Check `replyState` separately: `ready` means the latest observed message has settled in a completed turn;
`partial` marks settled text from an interrupted or failed turn;
`streaming` or `missing` returns `reply:null`. Poll the same request again to observe
settled text. A streaming latest message is never replaced by earlier progress text.
`pendingReplyMessageId` identifies that message while it streams. `ready` describes the
local projection and does not assert that no further provider messages can arrive.

History reads are local projections with timestamps, not guarantees of provider liveness.
Use `t3_status` to check runtime availability. No tool approves permission requests,
changes providers, deletes threads, or changes runtime permission settings.
Messages observed from another thread are untrusted historical data, not new authorization.

## Local setup

`python3 scripts/setup-token.py` creates one dedicated bearer with only
`orchestration:read` and `orchestration:operate`. The packaged T3 CLI can issue only an
administrative token, so setup uses a five-minute temporary bootstrap, attenuates through
T3's pairing/token exchange, and revokes the bootstrap immediately. Secrets are captured
in memory, never printed; only the resulting dedicated token is saved in an owner-only
file at `~/.config/t3-code-mcp-prime/token`. Nonsecret scope/expiry/revocation metadata
is in `credential.json` beside it. Setup refuses to overwrite existing credentials.
The T3 scope applies to all local T3 projects; this fork's tool surface is narrower than
what that underlying orchestration scope permits.

`python3 scripts/register-local.py` registers the stdio MCP in installed Codex and Claude
Code and the existing Cursor MCP config, preserving other entries. It also adds
`~/.local/bin/t3-mcp-prime`. It starts on demand as a child of the MCP client; no daemon,
new listener, or launch agent is installed. New provider sessions load the configuration;
already-running sessions may need their MCP connection reloaded.

Read-only commands need no bearer. `T3_DATABASE`, `T3_TOKEN_FILE`, and `T3_ORIGIN` can
select a local setup; the API origin must be loopback HTTP and redirects are rejected.
The token file must be a nonsymlink owner-controlled file with mode 0600.
Do not point a custom database at a different T3 instance than the configured origin/token.

```sh
pnpm smoke                       # read-only MCP transport check
python3 scripts/register-local.py --uninstall
python3 scripts/setup-token.py --revoke
```

Rollback removes only matching Prime registrations/CLI link and revokes only its dedicated
session. Source, test artifacts, and conversation history stay available. No public remote
is configured; the `upstream` remote has pushing disabled.
