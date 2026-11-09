# Code standards — contractual, verifier-enforced

Workers and planners must follow these rules. The verifier rejects plans or outputs that violate them.

**Precedence:** the host repository's toolchain, formatter, linter, and naming conventions come first. These invariants are the floor, never a replacement for the ecosystem's own standard.

## Types & boundaries

- Use the ecosystem's strongest available checker (compiler, type hints, static analysis) in its strictest practical mode; wire it into a task's verification.
- **No production escape hatches:** no untyped casts, `any`-equivalents, or blanket suppressions without a comment naming the constraint and an owning task. Test-only escape hatches are allowed.
- **Model absence explicitly:** validate external input (env, API payloads, files, messages) at the boundary with a schema or parser; inside, use the language's non-optional/result type rather than sentinel values.
- Prefer explicit result/error unions over boolean-flag parameters and exceptions-as-control-flow.

## Errors

- No silent failures: never swallow, ignore, or merely log an error that leaves state inconsistent.
- No panic/unwrap/assert on untrusted input; return a structured error with a stable code and context.
- Preserve the cause chain; translate errors at boundaries instead of leaking internals.

## Files & modules

- **Hard ceiling: < 1000 LOC per file.** Split when a file acquires a second responsibility.
- **Single responsibility:** one public purpose per module. If its summary needs "and", split it.
- Dependencies point inward: shared/common code never imports feature/domain code.

## Layout — source and tests are SEPARATE trees

The test tree is a **sibling** of the source tree, never a child. Roots come from `architecture.yaml` `toolchain` (never assume `src/`):

```
<source-root>/<module>/...            # production code only
<test-root>/unit/<mirrored-module>/... # mirrored unit tests
<test-root>/integration/...            # cross-module tests
<test-root>/e2e/...                    # end-to-end journeys
```

- **No test tree inside the source tree** (for example, `tests/unit/…` is a sibling of `src/`, never `src/tests/`), and no test file beside the code it covers.
- **The mirror:** preserve the path under the source root, replacing the source root with the test root: `src/features/catalog/api/<source file>` → `tests/unit/features/catalog/api/<test file>`. A monorepo package mirrors its own source.
- **The FILE NAME is the language's business.** This standard fixes the PLACE, never the name—use the host ecosystem's convention. Record it in `architecture.yaml` `naming_conventions.test_placement`.
- **One exception:** a language whose runner only discovers tests inside the package directory keeps those files beside the code; integration and end-to-end tests still live in the test tree.
- **Ownership follows the tree:** a task owning source owns the mirrored test path, or a dedicated task owns the tests—some task must.

Why: one directory holding both production and test code grows a second, undeclared structure and makes "where does this go?" a per-file judgment call.

## Naming

- Follow the host language's canonical convention for files, symbols, and tests; record it and apply it consistently.
- **Descriptive over terse:** `rate-limiter` over `rl`, `parse-config` over `utils2`.
- **BANNED names:** `utils`, `misc`, `helpers`, `temp*`, `final*`, `copy*`, and numbered duplicates (`auth2`). If the ecosystem mandates a utility namespace, keep each module single-purpose.
- No abbreviation invented in-plan that the codebase does not already use.

## Comments

- **Document WHY:** trade-offs, non-obvious constraints, and ADR references at decision points.
- **Public APIs:** purpose, parameters, failure modes.
- **Zero noise:** no restating code, no commented-out code, no inline changelogs.

## Verification

- Every `tasks.yaml` acceptance list includes ≥1 objectively verifiable check (exit code or observable output).
- The plan declares both trees; the verifier audits this file and returns `ISSUES` on violations.
- Workers receive this file's path in their contract and are strictly bound by it.
