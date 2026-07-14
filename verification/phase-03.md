# Phase 03 — MCP Control Plane

## Expected result

- A local authenticated Unix-socket boundary between the CaMe runtime and its MCP process.
- Strict session binding, request validation, replay rejection and bounded resource use.
- Serialized handler execution with timeout and cancellation propagation.
- Three MCP tools for switching, confirmation and state inspection.
- No dependency on the handoff state machine or later phases.

## Production adversarial review

### Cycle 1

- Prevented an unstarted server from deleting an unowned socket path.
- Made concurrent start and close operations deterministic.
- Aborted active requests when clients disconnect or the server closes.
- Validated socket path, session identifier, token and resource limits.

### Cycle 2

- Counted complete messages, including trailing bytes, against transport limits.
- Pre-serialized client requests so serialization failures remain explicit and local.
- Preserved startup errors through cleanup instead of absorbing them.

### Cycle 3

- Required absolute server socket paths.
- Normalized asynchronous startup semantics and nullable close callbacks.

### Cycle 4

- No actionable findings.

## Test evidence

### Adversarial test review cycle 1

- Added connection-capacity and client-cancellation coverage.
- Made MCP teardown unconditional after partial handshake failures.

### Adversarial test review cycle 2

- Made incomplete raw responses fail with a bounded diagnostic timeout.

### Adversarial test review cycle 3

- No actionable findings across 16 active test cases.

### Initial gate failure

- The targeted run passed 14 of 16 tests.
- Over-capacity sockets were not tracked through shutdown and read timers survived socket close.
- The installed MCP SDK attempted to normalize a discriminated-union output schema as an object and failed internally.
- All accepted sockets are now tracked, read timers are cancelled on close, and capacity cleanup is bounded.
- MCP output uses an object schema compatible with SDK 1.29 and delegates variant validation to the original strict discriminated union.
- Both isolated failures passed after correction and adversarial review was reopened with no further findings.

### Final gate

- `pnpm test:control-plane`: 3 files, 16 tests passed.
- `pnpm typecheck`: passed.
- `pnpm test:runtime`: 3 files, 14 tests passed.
- `pnpm test:app-server`: 4 files, 23 tests passed.
- `pnpm test:foundation`: 2 files, 11 tests passed.
- `pnpm build`: passed.
- `node dist/cli/came-mcp.js --unknown`: expected exit code 2 and usage output observed.
- Missing session environment smoke test: expected exit code 1 and explicit configuration error observed.
- Final phase status: closed with zero actionable review findings.
