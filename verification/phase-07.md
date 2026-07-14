# Phase 07 — Diagnostics

## Expected result

- A `came doctor` command with human-readable and JSON output.
- Deterministic checks for Node, platform IPC, Codex capabilities, the CaMe MCP executable and plugin installation.
- Blocking failures separated from preinstallation warnings.
- Bounded command execution without a shell and without exposing command stderr.

## Production adversarial review

### Cycle 1

- Made capability checks independent of option ordering in Codex help output.
- Rejected malformed Node versions instead of accepting a numeric prefix.
- Required both installed and enabled flags before declaring the plugin usable.
- Reported command timeout explicitly instead of as a null exit code.

### Cycle 2

- Removed arbitrary child stderr from diagnostic messages to prevent configuration disclosure.
- Tightened Node semantic-version parsing while retaining support for prerelease/build suffixes.

### Cycle 3

- Rejected plugin inventory objects missing the required `installed` and `available` arrays.

### Cycle 4

- No actionable findings.

## Test evidence

### Adversarial test review cycle 1

- Covered ready, preinstallation warning and fully incompatible environments.
- Covered incomplete Codex capabilities, invalid JSON and incompatible plugin inventory schemas.
- Made the real executable probe independent of the installed Node major version.

### Adversarial test review cycle 2

- Verified human output, JSON output, exit codes and argument rejection without starting diagnostics.
- No remaining actionable findings across 10 targeted cases.

### Final gate

- `pnpm test:diagnostics`: 2 files, 10 tests passed.
- `pnpm test:runtime`: 3 files, 17 tests passed.
- `pnpm test:plugin`: 1 file, 3 tests passed.
- `pnpm test:control-plane`: 3 files, 16 tests passed.
- `pnpm typecheck`: passed.
- `pnpm build`: passed.
- Real `node dist/cli/came.js doctor --json`: six capability checks passed, missing `came-mcp` failed, unregistered plugin warned, exit code 1 as expected before installation.
- Diagnostic output did not include child stderr or environment secrets.
- Final phase status: closed with zero actionable review findings.
