# Code standards — contractual, verifier-enforced

Workers and planners must follow these rules. The verifier rejects plans or outputs that violate them.

## Typing (TypeScript projects)

- **NO `any`:** Explicit `any`, implicit `any`, and `as any` casts are BANNED. Enforce `"strict": true`, `noImplicitAny`, `strictNullChecks`, and `noUncheckedIndexedAccess`.
- **No unhandled `undefined`/`null`:** Validate external boundaries (env vars, API payloads) with schemas; internally use non-optional types and explicit result unions for fallible operations.
- **Discriminated unions:** Prefer discriminated unions over boolean-flag parameters.
- **Other languages:** Mandatory type hints in Python; no `.unwrap()` on fallible types in Rust; explicit error handling in Go.

## File & module limits

- **Hard ceiling:** Files MUST stay `< 1000 LOC`. Split immediately when a file acquires a second responsibility.
- **Single responsibility:** One public purpose per module. If its summary requires `"and"`, split it.

## Folder structure (planned in architecture.yaml BEFORE coding)

```
src/
  features/<name>/   # Feature-first: everything a feature owns
    api/             # Inbound contracts (routes/handlers)
    internal/        # Private implementation
    tests/           # Colocated tests mirroring structure
  shared/            # Cross-feature utilities ONLY; MUST NOT import features/
  config/            # Typed env parsing + constants
```

- `features/*` may import `shared/`; `shared/` imports NOTHING from `features/`.
- Colocate tests beside the code they test—never in a disconnected root `/tests` directory.

## File naming

| Language | Source files | Components / Classes | Tests |
|---|---|---|---|
| TypeScript | `kebab-case.ts` | `PascalCase.tsx` components, `PascalCase` classes | `<subject>.test.ts` (colocated) |
| Python | `snake_case.py` | `PascalCase` classes, `snake_case` functions | `test_<subject>.py` (mirrored) |
| Rust | `snake_case.rs` | `PascalCase` types/traits | `#[cfg(test)] mod tests` or `tests/` |
| Go | `snake_case.go` | `PascalCase` exported, `camelCase` internal | `<subject>_test.go` (same dir) |

- **Descriptive over terse:** Use `rate-limiter.ts` (not `rl.ts`) and `parse-config.ts` (not `utils2.ts`).
- **BANNED names:** `utils.*`, `misc.*`, `helpers.*`, `temp*`, `final*`, `copy*`, or numbered duplicates (`auth2.ts`). Split by specific responsibility.

## Comments

- **Document WHY:** Explain trade-offs, non-obvious constraints, and ADR references (`see ADR D3`) at decision points.
- **Public APIs:** Document purpose, parameters, and failure modes.
- **Zero noise:** No restating code (`// increment i`), no commented-out code, no inline changelogs.

## Enforcement hooks

- Every `tasks.yaml` acceptance list MUST include $\ge 1$ objectively verifiable check (exit code or observable output).
- The verifier runs `archgen_plan{action:'verify'}` and audits plans against this file; violations trigger `ISSUES`.
- Workers receive this file path in their prompt contract and are strictly bound by it.
