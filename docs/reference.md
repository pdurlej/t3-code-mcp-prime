[← README](../README.md) · [Setup](setup.md)

# Tool reference

The MCP tools and JSON CLI use the same names and arguments:

| Tool | Purpose |
| --- | --- |
| `t3_status` | T3 liveness/version and read-only database availability |
| `list_threads` | Find titles/projects/branches, filter exact status, page with `offset` |
| `search_messages` | Search actual message text; all words, case-insensitive, optional project/thread/role scope |
| `get_thread` | Recent messages, a page before `beforeMessageId`, or a window around `centerMessageId` |
| `get_message` | Read a chosen message by `offset` and `maxChars`, without losing its ID |
| `send_message` | Send an instruction to an existing idle thread, preserving its permission/model modes; optional `attachments` (local file paths) |
| `wait_for_turn` | Wait for the exact `requestId`, not the latest unrelated response |
| `spawn_thread` | Create a thread in the template thread's project with its model/modes/branch, then start the first turn (with optional attachments) |
| `interrupt_thread` | Interrupt the active turn of a thread; the thread and session stay |
| `archive_thread` | Archive or unarchive an idle thread |

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

[`examples/context.py`](../examples/context.py) shows the Prime-inspired pattern with Python's standard library:
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


## Attachments, spawning, interrupting, archiving

```sh
t3-mcp-prime send_message '{"threadId":"...","message":"Read the brief.","attachments":["/abs/path/brief.md"]}'
t3-mcp-prime spawn_thread '{"templateThreadId":"...","title":"Pilot FJ-527","message":"Start with BRIEF.md","attachments":["/abs/path/BRIEF.md"]}'
t3-mcp-prime interrupt_thread '{"threadId":"...","reason":"wrong task"}'
t3-mcp-prime archive_thread '{"threadId":"...","archived":true}'
```

Attachments are local file paths (max 5; images ≤10 MB, other files ≤50 MB, T3 0.0.40 limits).
They are copied into T3's pending attachment area next to its database and claimed by the
server on `thread.turn.start`, exactly like UI uploads; unclaimed files are swept by T3 after 24h.
The agent receives them as `[Attached file ... is saved at: ...]`, the same as UI attachments.

`spawn_thread` never invents permissions: it copies `modelSelection`, `runtimeMode`,
`interactionMode` and `branch` from `templateThreadId` and creates the thread in that project
(`thread.create` then `thread.turn.start`). Worktree threads are UI-only. Pass your own
`threadId`/`requestId` UUIDs to make a retry idempotent.

`interrupt_thread` only acts on a running turn and returns `interrupted:false` otherwise.
It is not a message: send a follow-up afterwards. `archive_thread` refuses while a turn runs.

## Durable delivery and action-driven reviews

Six additional tools — `queue_message`, `delivery_status`, `deliver_pending`, `request_review`, `resolve_review`, `cancel_review` — are described in the [peer review guide](review-loop.md). `list_threads` and `get_thread` also include model selection, project path, worktree path, branch, and runtime/interaction modes.
