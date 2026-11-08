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
  shared/            # Cross-feature utilities ONLY; MUST NOT import features/
  config/            # Typed env parsing + constants
tests/
  unit/              # Unit tests — mirror the source path
    features/<name>/
  integration/       # Feature-level tests across module boundaries
  e2e/               # User journeys, end to end
```

- `features/*` may import `shared/`; `shared/` imports NOTHING from `features/`.

## Source and tests are SEPARATE trees

The test tree is a **sibling** of the source tree, never a child.

- **No test tree inside the source tree:** no `tests/` directory under `src/`, and no test file beside the code it covers.
- **The mirror:** the path under the source root is preserved; the source root is replaced by the test root. `src/features/catalog/api/routes.ts` → `tests/unit/features/catalog/api/<test file>`. A monorepo package mirrors its own source: `packages/foo/src/**` → `packages/foo/tests/unit/**`.
- **The FILE NAME is the language's business.** This standard fixes the PLACE, never the name—use the naming convention the language's ecosystem and the host repository already use. The plan's `architecture.yaml` records it in `naming_conventions.test_placement`.
- **One exception:** a language whose test runner discovers tests only inside the package directory keeps those files beside the code they cover. Everything the runner can discover elsewhere—integration and end-to-end tests—still lives in the test tree.
- **Ownership follows the tree:** a task that owns `src/features/x/**` also owns `tests/unit/features/x/**`. A worker may not write outside `file_ownership`, so the mirrored path must be in it. A plan that gives the tests to a dedicated task is valid too—as long as some task owns them.

Why: one directory holding both `foo.ts` and its test grows a second, undeclared structure. The test files become half the listing, imports blur, and "where does this go?" becomes a per-file judgement call that different agents answer differently.

## File naming

| Language | Source files | Components / Classes |
|---|---|---|
| TypeScript | `kebab-case.ts` | `PascalCase.tsx` components, `PascalCase` classes |
| Python | `snake_case.py` | `PascalCase` classes, `snake_case` functions |
| Rust | `snake_case.rs` | `PascalCase` types/traits |
| Go | `snake_case.go` | `PascalCase` exported, `camelCase` internal |

- **Descriptive over terse:** Use `rate-limiter.ts` (not `rl.ts`) and `parse-config.ts` (not `utils2.ts`).
- **BANNED names:** `utils.*`, `misc.*`, `helpers.*`, `temp*`, `final*`, `copy*`, or numbered duplicates (`auth2.ts`). Split by specific responsibility.

## Comments

- **Document WHY:** Explain trade-offs, non-obvious constraints, and ADR references (`see ADR D3`) at decision points.
- **Public APIs:** Document purpose, parameters, and failure modes.
- **Zero noise:** No restating code (`// increment i`), no commented-out code, no inline changelogs.

## Enforcement hooks

- Every `tasks.yaml` acceptance list MUST include $\ge 1$ objectively verifiable check (exit code or observable output).
- The verifier runs `archgen_plan{action:'verify'}` and audits plans against this file; violations trigger `ISSUES`.
- The plan must declare both trees: `architecture.yaml`'s `structure:` lists the source tree AND the test tree, and every task that owns source owns the mirrored test path.
- Workers receive this file path in their prompt contract and are strictly bound by it.
