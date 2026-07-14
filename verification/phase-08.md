# Phase 08 — Integrated verification

## Expected result

- An integrated MCP-to-App-Server test that crosses the authenticated Unix-socket control plane.
- Same-thread model and effort handoff with deterministic continuation and redacted audit evidence.
- Fault injection for invalid control-plane authentication.
- A real Codex TUI smoke test with the installed CaMe plugin and package executables.
- Full targeted regression coverage across all completed components.

## Production adversarial review

### Cycle 1

- Added an integrated stack test using the real MCP server, authenticated IPC client/server, handoff engine, governance controller, App Server bridge and JSONL audit log.
- Verified that the handoff updates and resumes the original `threadId` instead of creating a second Codex session.
- Verified that audit output contains lifecycle events but not the raw reason or continuation text.

### Cycle 2

- Injected an invalid control token and verified rejection before handoff or audit execution.
- Confirmed that the control socket and audit log retain owner-only permissions.
- No remaining race, cleanup or double-close findings in the integrated harness.

### Cycle 3

- The first real TUI run exposed unsupported shell-style interpolation in plugin MCP environment values.
- Replaced literal interpolation with Codex `env_vars` forwarding for the session ID, control socket and control token.
- Reinstalled the cache-busted plugin and verified the installed cache contents.

### Cycle 4

- The second real TUI run proved that the App Server, not the remote TUI process, launches plugin MCP servers.
- Moved the MCP socket and token into the shared App Server/TUI environment while keeping the TUI authentication token out of the App Server environment.
- Separated the 10-second App Server request timeout from the 60-second real TUI startup timeout.

### Cycle 5

- Re-read the complete production and integration diff for trust-boundary leaks, thread divergence, cleanup races and test-only assumptions.
- No actionable findings remained.

## Test evidence

### Adversarial test review cycle 1

- Covered authenticated scheduling, model discovery, settings update, same-thread continuation and final state observation.
- Covered invalid authentication with zero audit side effects.
- Covered runtime forwarding of the exact control socket and token to the App Server environment.

### Adversarial test review cycle 2

- Verified plugin use of `env_vars` and cachebuster version shape.
- Verified that the longer TUI startup timeout does not change the bounded App Server request timeout.
- No remaining actionable test gaps for the integrated phase.

### Final gate

- `pnpm test:integration`: 1 file, 2 tests passed.
- `pnpm test:plugin`: 1 file, 3 tests passed.
- `pnpm test:runtime`: 3 files, 17 tests passed.
- `pnpm test:foundation`: 2 files, 11 tests passed.
- `pnpm test:app-server`: 4 files, 23 tests passed.
- `pnpm test:control-plane`: 3 files, 16 tests passed.
- `pnpm test:handoff`: 1 file, 10 tests passed.
- `pnpm test:governance`: 2 files, 8 tests passed.
- `pnpm test:diagnostics`: 2 files, 10 tests passed.
- Total: 19 files and 100 targeted tests passed.
- `pnpm typecheck`: passed.
- `pnpm build`: passed.
- Official plugin validator: passed.
- Official skill validator: passed.
- Real `came doctor --json`: eight checks passed and `ready` was `true`.
- Real Codex TUI: `came-control` registered three tools; unrelated UniFi MCP startup failures did not affect CaMe.
- Real agent tool call: `came_session_state` returned the active same-thread session with profile `gpt-5.6-sol` / `high` and router state `idle`.
- Clean TUI shutdown returned exit code 0 and removed the ephemeral runtime.
- Final phase status: closed with zero actionable review findings.
