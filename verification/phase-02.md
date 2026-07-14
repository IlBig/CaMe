# Phase 02 — Session Runtime

## Expected result

- One isolated runtime directory and session identifier per invocation.
- An authenticated loopback WebSocket gateway between Codex TUI and App Server Bridge.
- A single TUI client with ordered bidirectional JSON-RPC forwarding.
- Deterministic startup, signal handling, child termination and resource cleanup.
- No dependency on the MCP control plane or later phases.

## Production adversarial review

### Cycle 1

- Removed a circular public-index import from the gateway.
- Separated startup and steady-state WebSocket server errors.
- Prevented stop-during-startup resource leaks.
- Made cleanup continue across independent failures and report an aggregate error.
- Bounded both graceful and forced child-process termination.
- Validated timeouts and platform signal mappings.

### Cycle 2

- Made concurrent gateway close calls await the same operation.
- Prevented a failed App Server startup from launching the TUI.
- Rejected signals unavailable on the current platform instead of producing an invalid exit code.

### Cycle 3

- No actionable findings.

## Test evidence

### Adversarial test review cycle 1

- Detected and corrected the race between natural TUI exit and WebSocket disconnect.
- Replaced assertions that could pass when expected runtime resources were absent.

### Adversarial test review cycle 2

- Made the forced-termination test deterministic with an App Server readiness signal.
- Added coverage for a disconnected WebSocket whose TUI process remains alive.

### Adversarial test review cycle 3

- No actionable findings across 14 active test cases.

### Initial gate failure

- The targeted runtime run passed 13 of 14 tests.
- Per-operation diagnostics localized the failure to App Server notification delivery.
- The `ws` success callback supplied `null`; the gateway incorrectly treated every non-`undefined` value as an error.
- The callback now accepts both `null` and `undefined` as success and still fails on actual errors.
- TypeScript then identified an uninferred `verifyClient` parameter and an `ArrayBuffer` conversion requiring explicit narrowing.
- Both corrections reopened production and test adversarial review; no further findings remained.

### Final gate

- `pnpm test:runtime`: 3 files, 14 tests passed.
- `pnpm typecheck`: passed.
- `pnpm test:app-server`: 4 files, 23 tests passed.
- `pnpm test:foundation`: 2 files, 11 tests passed.
- `pnpm build`: passed.
- `node dist/cli/came.js --unknown`: expected exit code 2 and `Usage: came` output observed.
- Final phase status: closed with zero actionable review findings.
