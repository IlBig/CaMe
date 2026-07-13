# Phase 00 — Foundation

## Expected result

- Git repository initialized on `main`.
- Strict ESM TypeScript project for Node 24.
- Exact dependency versions recorded in `pnpm-lock.yaml`.
- Closed runtime schemas for public Foundation contracts.
- Requested phase routing matrix preserved as declarative data.

## Adversarial review

### Cycle 1

- Finding: runtime schemas accepted unknown properties.
- Correction: every object schema is strict.
- Finding: TypeScript could emit output despite compilation errors.
- Correction: `noEmitOnError` is explicit.
- Finding: an active turn could exist without an active thread.
- Correction: `sessionStateSchema` enforces the relationship.

### Cycle 2

- No actionable findings.
- Production dependency audit: no known vulnerabilities.

## Test evidence

### Adversarial test review cycle 1

- Finding: result variants did not prove rejection of foreign fields.
- Correction: added strict-union cases.
- Finding: session counter covered only the upper bound.
- Correction: added lower-bound, fractional and unknown-field cases.

### Adversarial test review cycle 2

- No actionable findings.

### Execution

- Initial run: 11 tests passed and build passed; type-check failed because Node types were not included explicitly.
- Correction: added `node` to TypeScript `types`.
- The correction reopened production and test review before rerunning the gate.
- Reopened adversarial review: no actionable findings.

### Final gate

- `pnpm typecheck`: passed.
- `pnpm test:foundation`: 2 files, 11 tests passed.
- `pnpm build`: passed.
- Final phase status: closed with zero actionable review findings.
