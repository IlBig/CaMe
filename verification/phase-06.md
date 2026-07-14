# Phase 06 — Codex Plugin

## Expected result

- A valid Codex plugin manifest exposing the CaMe skill and MCP server.
- A stdio MCP entry that invokes the package `came-mcp` executable inside the CaMe runtime environment.
- An autonomous routing skill that preserves the current thread and forbids terminal `/model` injection or secondary Codex sessions.
- A repo-local marketplace entry with explicit installation and authentication policies.

## Production adversarial review

### Cycle 1

- Replaced all generated placeholders with project-specific metadata.
- Bound the MCP command to the executable already declared by the package.
- Matched every skill action and result branch to the implemented MCP contracts.

### Cycle 2

- Found that a governed confirmation could not survive until the user's next turn.
- Corrected the Handoff and Governance state machines so the exact confirmation remains valid only for the immediate same-thread response turn.
- Added invalidation when that turn ends without consuming the request.

### Cycle 3

- Corrected the skill to treat `routerState` as authoritative instead of referring to a nonexistent pending-confirmation field.
- Required an active turn and idle router before scheduling a new handoff.

### Cycle 4

- No actionable findings.

## Test evidence

### Adversarial test review cycle 1

- Verified plugin-to-package MCP executable linkage rather than only parsing each manifest independently.
- Verified the exact marketplace policy and source descriptor.
- Verified tool names, same-thread constraints, confirmation timing and forbidden fallback behavior in the skill.

### Adversarial test review cycle 2

- Added behavioral coverage for approval in the immediate next turn and invalidation when that turn completes without approval.
- No remaining actionable findings.

### Final gate

- Official plugin validator: passed.
- Official skill validator: passed.
- Isolated `CODEX_HOME` marketplace registration: passed.
- Isolated `came@personal` installation through `codex plugin add`: passed.
- `pnpm test:plugin`: 1 file, 3 tests passed.
- `pnpm test:governance`: 2 files, 8 tests passed.
- `pnpm test:handoff`: 1 file, 10 tests passed.
- `pnpm test:control-plane`: 3 files, 16 tests passed.
- `pnpm test:runtime`: 3 files, 14 tests passed.
- `pnpm typecheck`: passed.
- `pnpm build`: passed.
- Final phase status: closed with zero actionable review findings.
