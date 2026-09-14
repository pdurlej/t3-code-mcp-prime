# T3 Code MCP Prime

**Give your agents context beyond their own thread.**

Search your local T3 conversations, ask the agent working in another thread,
and collect the reply — without carrying the context between them yourself.

> “Find our migration discussion. Ask that agent to challenge this approach.
> Bring back its answer.”

| Find | Read | Ask | Collect |
| --- | --- | --- | --- |
| Search across threads | Pull only the context you need | Follow up with another agent | Get the reply to your exact request |

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
- **[Tool reference](docs/reference.md)** — seven tools, scripting, reply states and retry behaviour.
- **[Why Prime?](docs/provenance.md)** — inspiration, upstream history and licensing.

Tested with **T3 Code 0.0.40**; Alpha schemas may change. No semantic memory,
durable queue or mid-turn steering.

---

Fork of [ThomasCrund/t3code-mcp](https://github.com/ThomasCrund/t3code-mcp),
inspired by [Prime Agent](https://github.com/PrimeIntellect-ai/prime-agent).
Upstream provides no LICENSE; this fork adds no license grant.
