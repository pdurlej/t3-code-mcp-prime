# T3 Code MCP Prime

**Give your agents context beyond their own thread.**

Search your local T3 conversations, ask the agent working in another thread,
and close the review loop — without carrying the context between them yourself.

> “Find our migration discussion. Ask that agent to challenge this approach.
> Bring back its answer.”

| Find | Read | Ask | Collect | Run |
| --- | --- | --- | --- | --- |
| Search across threads | Pull only the context you need | Follow up with another agent, with attachments | Get the reply to your exact request | Spawn, interrupt and archive threads |

> [!NOTE]
> **T3 Code is shipping its own MCP.** The
> [v0.0.46 nightly (Orchestrator V2)](https://github.com/pingdotgg/t3code/releases/tag/v0.0.46-nightly.20261003.2610)
> adds a native T3 Code MCP that lets agents create, launch, message, wait on,
> read, search and interrupt threads — most of what this project does. Once that
> lands in a stable release, prefer the native MCP; this repository will most
> likely be superseded. V2 also changes how history is stored, so the direct
> SQLite reads here may stop working on 0.0.46+.
>
> Nice to know we were ahead of T3 Code in improving their product.

Works through **MCP or the CLI**, with **Codex, Claude Code and Cursor**.

## Get started

macOS · Node.js 24+ · pnpm · Python 3.11+ · T3 Code running locally

```sh
git clone https://github.com/pdurlej/t3-code-mcp-prime.git
cd t3-code-mcp-prime
pnpm install --frozen-lockfile --ignore-scripts
pnpm build
python3 scripts/register-local.py
```

Reload your MCP connection. Your agent can now search and read T3 threads.
To enable follow-ups, run `python3 scripts/setup-token.py`.

### Try a search

```sh
node dist/cli.js search_messages '{"query":"migration","groupByThread":true}'
```

One result per matching thread, with a snippet and a message ID to explore.
Search uses literal words; follow-ups go to existing idle threads.

## Go deeper

- **[Setup & uninstall](docs/setup.md)** — credentials, client registration and local configuration.
- **[Tool reference](docs/reference.md)** — retrieval, scripting, reply states and retry behaviour.
- **[Peer review loop](docs/review-loop.md)** — durable messages, action-triggered reviews and returned decisions.
- **[Why Prime?](docs/provenance.md)** — inspiration, upstream history and licensing.

Tested with **T3 Code 0.0.40**; Alpha schemas may change. Durable delivery is opt-in. No semantic memory or mid-turn steering.

---

Fork of [ThomasCrund/t3code-mcp](https://github.com/ThomasCrund/t3code-mcp),
inspired by [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent).
Upstream provides no LICENSE; this fork adds no license grant.
