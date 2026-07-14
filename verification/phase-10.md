# Phase 10 — Deterministic routing hardening

## Expected result

- Explicit profile commands never require model sampling for their acknowledgement.
- Multiline or composite commands fail closed before App Server forwarding.
- The authenticated gateway, handoff engine, governance layer and App Server bridge are covered by one integrated test.
- Every failure after switch scheduling retains the originating `switchId` and canonical target profile.

## Production adversarial review

### Cycle 1

- Reproduced the multiline parser bypass caused by a non-dotall remainder match.
- Measured the previous explicit path through a real TUI and confirmed that its fixed acknowledgement still created a complete model turn with reasoning and token usage.
- Identified missing end-to-end coverage across the gateway and handoff engine.
- Identified that `handoff_failed` could not be correlated with the scheduled switch.

### Cycle 2

- Read the Codex 0.144.3 App Server contract and exact generated schemas.
- Verified that `thread/settings/update` applies settings without creating a transcript item or sampling a model.
- Replaced the rewritten App Server turn with a local, schema-compatible TUI lifecycle containing one fixed validated acknowledgement.
- Preserved the original `threadId` and kept the synthetic lifecycle outside the handoff engine and App Server transcript.

### Cycle 3

- Changed explicit parsing to prefix recognition followed by bounded deterministic token parsing.
- Rejected embedded LF, CR, Unicode line separator and Unicode paragraph separator characters.
- Added gateway-level proof that multiline payloads return a JSON-RPC error and are never forwarded.

### Cycle 4

- Added failure context to the serialized handoff state.
- Propagated the same `switchId` and canonical target profile into `handoff_failed` for explicit and autonomous paths.
- Cleared the context only after the complete settings or continuation audit chain succeeds.

### Cycle 5

- Added a real gateway-to-engine-to-governance-to-bridge test with an authenticated WebSocket client and a protocol-level App Server peer.
- Proved request ordering, settings propagation, local completion, idle engine state and absence of a hidden App Server `turn/start`.
- Re-read the complete production and test diff for protocol ordering, stale failure context, unsafe profile text, race conditions and fail-open behavior.
- No actionable findings remained.

## Test evidence

### Deterministic behavior

- Four embedded line-separator classes fail closed in parser and gateway tests.
- Applied and no-op profile commands complete locally without forwarding their `turn/start`.
- A subsequent normal request is accepted, proving that the gateway receive queue is released.
- Explicit and autonomous failures retain the scheduled switch correlation fields.
- The integrated route emits only the real settings notification and the five local completion messages.

### Final gate

- Eight directly affected test files: 60 tests passed.
- Focused handoff regression: 17 tests passed.
- `pnpm typecheck`: passed.
- `pnpm build`: passed.
- `git diff --check`: passed.
- Real `came doctor --json`: eight checks passed and `ready` was `true`.

### Real Codex TUI

- An initial observation came from a TUI process started at 16:35, before the corrected bundle was built at 17:12; file timestamps exposed the stale process and that observation was invalidated.
- A fresh process loaded the corrected bundle and applied `cambia modello in 5.5 xhigh` with the fixed local acknowledgement and footer update.
- The same process applied `cambia modello in 5.6 sol ultra`, reusing the session catalog and updating the footer to `gpt-5.6-sol ultra`.
- Context usage remained at 0% through both changes.
- No new App Server rollout was created, proving that neither command produced a model turn, token count, tool call or context compaction.
- The unrelated `unifi-access` and `unifi-protect` startup warnings did not affect CaMe; all CaMe diagnostics passed.
- Final phase status: closed with zero actionable review findings.
