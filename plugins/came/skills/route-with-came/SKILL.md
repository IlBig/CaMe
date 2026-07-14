---
name: route-with-came
description: Route Codex model or reasoning effort through CaMe while preserving the current thread. Use for explicit profile requests and for multi-phase work whose complexity changes materially between implementation, debugging, security review, adversarial review, or integration.
---

# Route with CaMe

Explicit user commands are normally applied by the CaMe runtime before this skill is sampled. If an explicit request reaches the agent, call `came_switch_model` immediately with only `model` and `effort`. Do not call `came_session_state` as a preflight, narrate the routing procedure, or create a checkpoint.

For autonomous routing:

1. Switch only when another profile materially benefits the next bounded stage.
2. Prefer one handoff at a phase boundary; avoid equivalent or repeated switches.
3. Call `came_switch_model` once with the exact target `model` and the lowest sufficient `effort`. The server generates all routing context deterministically.
4. Do not call `came_session_state` before switching. Use it only when the user requests diagnostics or a returned error requires state inspection.

Handle the result:

- `scheduled`: stop the current turn. CaMe resumes the exact next unfinished action in the same thread.
- `noop`: continue the current turn; the requested profile is already active.
- `confirmation_required`: show the `requestId` and the profile from the original request to the user. Call `came_confirm_switch` only after that user explicitly approves this exact pending request in the immediately following turn.
- `rejected`: state the returned code and message, then continue with the current profile when the work remains feasible.

After confirmation, handle the returned result with the same rules. Never infer approval, reuse a request identifier, or confirm autonomously.

- Use only the CaMe MCP tools for autonomous routing. Do not inject `/model` into terminal input.
- Do not start or spawn another Codex session to change profile.
- Do not mutate model settings directly after a CaMe handoff is scheduled.
- If the CaMe tools are unavailable, keep the current profile and report that the session must be launched through the `came` runtime; do not use a silent fallback.
