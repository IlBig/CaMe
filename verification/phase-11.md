# Phase 11 — Recoverable profile errors

## Expected result

- Invalid profile commands complete locally instead of returning a failed `turn/start`.
- The TUI displays the specific validation or routing problem.
- No invalid command is forwarded to Codex App Server or sampled by a model.
- The same session accepts a valid profile change and normal App Server traffic after an error.
- The public parser contract remains backward compatible.

## Production adversarial review

### Cycle 1

- Reproduced `cambia modello 5.3 codex` as an invalid command because the final token is interpreted as effort.
- Replaced recoverable JSON-RPC errors with the same schema-compatible local turn lifecycle used for successful changes.
- Added deterministic Italian diagnostics for syntax, multiline input, composite input, unavailable models, ambiguous models, unsupported effort and router state.

### Cycle 2

- Kept missing protocol-level `threadId` as a JSON-RPC error because no valid TUI lifecycle can be associated with it.
- Preserved fail-closed behavior: invalid and composite commands are never forwarded to App Server.
- Sanitized unknown router messages by removing control and formatting characters, normalizing whitespace and bounding output length.

### Cycle 3

- The first diff review detected that diagnostic codes had been added to the exported parser result.
- Moved diagnostic codes to an internal detailed parser and restored the public `{ status: "invalid" }` contract.
- Added a regression sequence covering invalid command, valid profile change and normal App Server request on the same WebSocket.
- No actionable findings remained after the second review.

## Test evidence

### Automated gate

- Exact regression input: `cambia modello 5.3 codex`.
- The local completion contains the supported-effort explanation and no JSON-RPC error.
- Composite and multiline commands remain blocked without forwarding.
- A following valid change completes successfully in the same session.
- A following `thread/read` reaches App Server, proving that the receive queue and gateway remain usable.
- Eight affected test files: 61 tests passed.
- Focused gateway test: 20 tests passed.
- `pnpm typecheck`: passed.
- `pnpm build`: passed.
- `git diff --check`: passed.

### Real Codex TUI

- `cambia modello 5.3 codex` displayed the missing-effort explanation without `turn/start failed` and without closing the TUI.
- `cambia modello 5.3 codex spark high` then applied `gpt-5.3-codex-spark/high` in the same session.
- Context usage remained at 0%.
- Recent rollout files were traced to unrelated VS Code sessions in `Downloads`; the CaMe TUI in `Projects/CaMe` created no model turn or token event.
- Real `came doctor --json`: eight checks passed and `ready` was `true`.
- Final phase status: closed with zero actionable review findings.
