export type PhaseRoutingProfile = Readonly<{
  phase: number;
  component: string;
  model: string;
  effort: string;
  reason: string;
}>;

export const PHASE_ROUTING_MATRIX = [
  {
    phase: 0,
    component: "Foundation",
    model: "gpt-5.6-sol",
    effort: "medium",
    reason: "Contratti e struttura richiedono precisione, con complessità contenuta.",
  },
  {
    phase: 1,
    component: "App Server Bridge",
    model: "gpt-5.6-sol",
    effort: "high",
    reason: "Parsing JSON-RPC, multiplexing, timeout e risposte fuori ordine.",
  },
  {
    phase: 2,
    component: "Session Runtime",
    model: "gpt-5.6-sol",
    effort: "high",
    reason: "Process lifecycle, WebSocket, cleanup e race condition.",
  },
  {
    phase: 3,
    component: "MCP Control Plane",
    model: "gpt-5.6-sol",
    effort: "xhigh",
    reason: "IPC autenticato, concorrenza, replay e validazione di sicurezza.",
  },
  {
    phase: 4,
    component: "Handoff Engine",
    model: "gpt-5.6-sol",
    effort: "max",
    reason: "Macchina a stati distribuita, eventi asincroni e identità del thread.",
  },
  {
    phase: 5,
    component: "Governance e audit",
    model: "gpt-5.6-sol",
    effort: "max",
    reason: "Conferme monouso, reset delle catene, privacy e invarianti di audit.",
  },
  {
    phase: 6,
    component: "Codex Plugin",
    model: "gpt-5.6-terra",
    effort: "high",
    reason: "Manifest, skill e marketplace sono prevalentemente dichiarativi.",
  },
  {
    phase: 7,
    component: "Diagnostics",
    model: "gpt-5.6-terra",
    effort: "high",
    reason: "Verifiche deterministiche con attenzione a falsi positivi e compatibilità.",
  },
  {
    phase: 8,
    component: "Verifica integrata",
    model: "gpt-5.6-sol",
    effort: "max",
    reason: "Integrazione, fault injection, revisione finale e smoke test reale.",
  },
] as const satisfies readonly PhaseRoutingProfile[];
