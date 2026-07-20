# CaMe

CaMe abilita il cambio autonomo e governato di modello e reasoning effort nella stessa sessione Codex.

## Requisiti

- macOS o Linux
- Node.js 24 o superiore
- Codex CLI con supporto `--remote`
- pnpm oppure corepack

## Installazione

Dalla directory del repository esegui un solo comando:

```sh
./install.sh
```

L'installer compila CaMe, crea un runtime production indipendente dalla checkout, installa i comandi `came` e `came-mcp`, registra il plugin Codex e verifica la configurazione. Installazioni successive aggiornano CaMe in modo idempotente.

Avvia quindi Codex attraverso CaMe:

```sh
came
```

All'interno della sessione puoi richiedere esplicitamente un profilo, per esempio:

```text
cambia modello in gpt-5.5 con effort xhigh
```

L'agente può inoltre usare il tool MCP di CaMe per cambiare autonomamente profilo tra fasi di lavoro differenti.

## Diagnostica

```sh
came doctor
```
