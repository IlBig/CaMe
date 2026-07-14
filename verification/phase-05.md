# Phase 05 — Governance and Audit

## Expected result

- At most five autonomous switches per handoff chain.
- A bounded, monotonic-TTL confirmation after the autonomous threshold.
- One-time confirmation consumption bound to session, thread, exact pending request and canonical target profile.
- Confirmation invalidation on expiry, stale context or completion of the immediate response turn without consumption.
- Synchronous durable JSONL audit records without prompts, continuations or authentication secrets.

## Production adversarial review

### Cycle 1

- Bound confirmations to the canonical target profile as well as the original request.
- Rejected governance state from another session.
- Required a private audit parent directory and complete queued writes.
- Awaited terminal audit recording before reporting engine failure.

### Cycle 2

- Made audit file initialization clean up a newly opened file on permission failure.
- Corrected the autonomous path to use an explicit unconfirmed target.

### Cycle 3

- Replaced wall-clock confirmation expiry with a monotonic clock.
- Restricted audit decisions to a closed enum.

### Cycle 4

- Wrapped public audit open and close failures in explicit typed errors.

### Cycle 5

- No actionable findings.

### Post-phase integration correction

- The Codex plugin workflow exposed that user approval necessarily arrives in the next turn.
- Preserved a pending confirmation for exactly that immediate same-thread response turn.
- Invalidated it when the response turn completed without consumption and retained monotonic TTL and one-time semantics.
- Revalidated Governance, Handoff, Control Plane, Runtime, type-check and build after the correction.

## Test evidence

### Adversarial test review cycle 1

- Added integrated confirmation consumption, same-thread continuation and stable autonomous-count coverage.
- Added fail-closed behavior when the required schedule audit record cannot be persisted.
- Corrected privacy assertions to distinguish field names from private values.

### Adversarial test review cycle 2

- Made audit file cleanup unconditional after assertion failures.
- Added protection against replacing an existing confirmation with a conflicting request.

### Adversarial test review cycle 3

- No actionable findings across 8 Governance/Audit and 9 Handoff test cases.

### Final gate

- `pnpm test:governance`: 2 files, 8 tests passed.
- `pnpm test:handoff`: 1 file, 9 tests passed.
- `pnpm test:runtime`: 3 files, 14 tests passed.
- `pnpm typecheck`: passed.
- `pnpm test:control-plane`: 3 files, 16 tests passed.
- `pnpm test:app-server`: 4 files, 23 tests passed.
- `pnpm test:foundation`: 2 files, 11 tests passed.
- `pnpm build`: passed.
- Runtime audit file mode `0600` and runtime directory mode `0700` were verified.
- Audit schemas reject arbitrary fields; private reason and continuation values were absent from recorded events.
- Final phase status: closed with zero actionable review findings.
