[← README](../README.md) · [Tool reference](reference.md)

# Local setup

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
session. Source, test artifacts, and conversation history stay available. The public fork is [pdurlej/t3-code-mcp-prime](https://github.com/pdurlej/t3-code-mcp-prime).

