# CaMe

CaMe enables autonomous, governed model and reasoning-effort switching within the same Codex session.

## Requirements

- macOS or Linux
- Node.js 24 or later
- Codex CLI with `--remote` support
- pnpm or corepack

## Installation

From the repository directory, run one command:

```sh
./install.sh
```

The installer builds CaMe, creates a production runtime independent of the source checkout, installs the `came` and `came-mcp` commands, registers the Codex plugin, and verifies the configuration. Subsequent installations update CaMe idempotently.

Then start Codex through CaMe:

```sh
came
```

Within the session, you can explicitly request a profile, for example:

```text
change model to gpt-5.5 with effort xhigh
```

The agent can also use the CaMe MCP tool to switch profiles autonomously between different phases of work.

## Diagnostics

```sh
came doctor
```
