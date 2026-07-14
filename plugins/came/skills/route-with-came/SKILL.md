---
name: route-with-came
description: Autonomously choose and schedule a better Codex model or reasoning effort through CaMe while preserving the current thread. Use for multi-phase implementation, architecture, debugging, security review, adversarial review, or other work whose complexity changes materially between stages. Also use when the user asks Codex to select or change model or effort without starting a separate Codex process.
---

# Route with CaMe

Route only when another available model or effort provides a material benefit for the next bounded stage. Keep the current profile when the expected benefit does not justify a handoff.

## Evaluate a handoff

1. Call `came_session_state` before deciding. Treat its result as authoritative for the current profile, switch count, active turn, and router state.
2. Identify the next bounded stage and the capability it needs: routine deterministic work, deep reasoning, security analysis, adversarial review, or broad integration.
3. Compare that need with the current model and effort. Do not switch merely because a different profile exists.
4. Avoid repeated switches between equivalent profiles. Prefer one handoff at a phase boundary over frequent task-level churn.

Schedule a new handoff only while `routerState` is `idle` and both `activeThreadId` and `activeTurnId` are present. If `routerState` is `awaiting_confirmation`, handle the existing request instead of creating another one.

## Schedule a handoff

Call `came_switch_model` with:

- `model`: the exact available target model identifier.
- `effort`: the lowest effort sufficient for the next stage.
- `reason`: one concise, technical explanation of the expected benefit.
- `continuation`: a self-contained checkpoint containing the objective, verified state, relevant files or constraints, and the exact next action.

Keep the continuation concise and exclude secrets, authentication tokens, private logs, and unrelated conversation content.

## Handle the result

- `scheduled`: stop the current turn cleanly. CaMe resumes the continuation in the same Codex thread after applying the target profile.
- `noop`: continue the current turn; the requested profile is already active.
- `confirmation_required`: show the `requestId` and the profile from the original request to the user. Call `came_confirm_switch` only after that user explicitly approves this exact pending request in the immediately following turn.
- `rejected`: state the returned code and message, then continue with the current profile when the work remains feasible.

After confirmation, handle the returned result with the same rules. Never infer approval, reuse a request identifier, or confirm autonomously.

## Preserve execution semantics

- Use only the CaMe MCP tools for routing. Do not inject `/model` into terminal input.
- Do not start or spawn another Codex session to change profile.
- Do not mutate model settings directly after a CaMe handoff is scheduled.
- If the CaMe tools are unavailable, keep the current profile and report that the session must be launched through the `came` runtime; do not use a silent fallback.
- Keep all implementation, review, and verification work in the original thread.
