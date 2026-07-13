# Phase 01 — App Server Bridge

## Expected result

- JSONL transport over Codex App Server stdio.
- Collision-free multiplexing of controller, TUI and server request identifiers.
- Experimental initialization and typed wrappers for the required methods.
- Explicit timeout, protocol, remote-request and connection errors.
- No dependency on Session Runtime or later phases.

## Production adversarial review

### Cycles 1–6

- Corrected fragmented UTF-8 handling, residual line limits and stream-close detection.
- Rejected conflicting JSON-RPC discriminators and unsafe numeric identifiers.
- Bounded proxy requests, controller requests and model pagination.
- Made blocked writes reject on close and completed listener cleanup before propagating listener failures.
- Derived outbound types from runtime schemas and made initialization monouso across internal and TUI paths.
- Required the complete initialize/initialized handshake and forced `experimentalApi: true` for TUI sessions.
- Validated both internal and proxied initialization responses.
- Converted timeout and invalid server payloads to fail-closed protocol errors.

### Cycle 7

- No actionable findings.

## Test evidence

### Adversarial test review cycle 1

- Replaced synchronous stream-close assertions with awaited close events.
- Corrected callback-state narrowing in the blocked-write test.
- Added negative handshake ordering and dual notification forwarding cases.
- Added runtime validation coverage for settings and turn lifecycle notifications.

### Adversarial test review cycle 2

- Removed remaining assumptions about synchronous stream delivery.
- Added concrete remote error class verification.

### Adversarial test review cycle 3

- No actionable findings across 23 active test cases.

Initial execution attempted; type-check failed before the test commands ran.

### Initial gate failure

- TypeScript 7 required explicit pagination variable annotations.
- Test peer records required bracket notation under `noPropertyAccessFromIndexSignature`.
- Both corrections reopened production and test adversarial review.
- Reopened adversarial review completed with no actionable findings.

### Final gate

- `pnpm typecheck`: passed.
- `pnpm test:app-server`: 4 files, 23 tests passed.
- `pnpm test:foundation`: 2 files, 11 tests passed.
- `pnpm build`: passed.
- Final phase status: closed with zero actionable review findings.
