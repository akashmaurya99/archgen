# Code standards — contractual, reviewer-enforced

Workers and planners must follow these rules.

**Precedence:** the host repository's toolchain, formatter, linter, and naming conventions come first. These invariants are the floor, never a replacement for the ecosystem's own standard.

**Who enforces what:** the deterministic floor (`archgen_plan{action:'verify'}) proves the **tree layout** — the mirrored test tree, when `architecture.yaml` declares `toolchain.source_root` and `toolchain.test_root`. Everything else here (types, error style, LOC, naming) is the **reviewer's judgement**: a gate agent reads the plan and the diff against this file. Nothing below is machine-checked, and nothing below is machine-enforced.

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

- **Soft limit: < 1000 LOC per file.** Treat 1000 LOC as a review trigger, not a hard cap; the gate agent decides based on cohesion and clarity.
- **Single responsibility:** one public purpose per module. If its summary needs "and", split it.
- Dependencies point inward: shared/common code never imports feature/domain code.

## Layout — source and tests are SEPARATE trees

The test tree is a **sibling** of the source tree, never a child. Both roots come from `architecture.yaml` `toolchain` (never assume `src/`, `tests/` or any other prefix):

```
<source-root>/<module>/...        # production code only
<test-root>/<mirrored-module>/... # mirrored unit tests
<test-root>/../integration/...    # cross-module tests — a different root, if the host has one
```

- **No test tree inside the source tree** (for example, a `tests/` directory is a sibling of `src/`, never `src/tests/`), and no test file beside the code it covers.
- **The mirror:** preserve the path under the source root, replacing the source root with the test root. `src/features/catalog/api/<source file>` with `test_root: tests/unit` → `tests/unit/features/catalog/api/<test file>`. A monorepo package mirrors its own source.
- **`test_root` is the root of the tree that MIRRORS the source tree** — `tests/unit` in the common layout, `tests` when unit tests sit directly under `tests`. The floor mirrors the declared root; it never guesses a level.
- **The FILE NAME is the language's business.** This standard fixes the PLACE, never the name—use the host ecosystem's convention. Record it in `architecture.yaml` `naming_conventions.test_placement`.
- **One exception:** a language whose runner only discovers tests inside the package directory keeps those files beside the code; integration and end-to-end tests still live in the test tree. **This exception needs a waiver** — the floor cannot know it, so write it to `.archgen/<slug>/waivers.yaml` with the reason, and the floor will honour it.
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
- The plan declares both trees; the floor proves the mirrored layout when the roots are declared, and a gate reviewer audits the rest of this file.
- Workers receive this file's path in their contract and are strictly bound by it.
