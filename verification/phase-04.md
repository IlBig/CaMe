# Phase 04 — Handoff Engine

## Expected result

- One serialized state machine for MCP requests and App Server notifications.
- Model and effort validation against the live App Server catalog.
- A scheduled handoff that waits for source-turn completion.
- Atomic settings update and continuation start on the exact source `threadId`.
- Runtime integration with an isolated control socket and independent authentication token.

## Production adversarial review

### Cycle 1

- Prevented request cancellation from moving the engine into a terminal failed state.
- Converted pending-switch mismatches into explicit invariant failures.
- Rejected duplicate catalog matches instead of choosing an arbitrary model.
- Removed fallback reconstruction of the runtime control socket path.

### Cycle 2

- Prevented late notifications from changing a terminal `failed` state back to `idle`.

### Cycle 3

- Allowed a same-profile `noop` after the autonomous chain reaches its limit.

### Cycle 4

- No actionable findings.

## Test evidence

### Adversarial test review cycle 1

- Corrected the catalog fixture so the ambiguity case matched multiple records.
- Added a complete five-handoff chain, limit behavior and new-user-turn reset.

### Adversarial test review cycles 2–3

- No actionable findings across 8 active Handoff test cases.

### Final gate

- `pnpm test:handoff`: 1 file, 8 tests passed.
- `pnpm test:runtime`: 3 files, 14 tests passed.
- `pnpm typecheck`: passed.
- `pnpm test:control-plane`: 3 files, 16 tests passed.
- `pnpm test:app-server`: 4 files, 23 tests passed.
- `pnpm test:foundation`: 2 files, 11 tests passed.
- `pnpm build`: passed.
- Runtime integration verified the control socket mode `0600`, distinct TUI/control tokens and absence of control secrets from the App Server environment.
- Five consecutive handoffs preserved the original `threadId`; a later user turn reset the chain.
- Final phase status: closed with zero actionable review findings.
