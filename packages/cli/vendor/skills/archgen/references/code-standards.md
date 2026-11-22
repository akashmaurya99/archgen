# Code standards — contractual, reviewer-enforced

Workers and planners must follow these rules.

**Precedence:** the host repository's toolchain, formatter, linter, and naming conventions come first. These invariants are the floor, never a replacement for the ecosystem's own standard.

**Who enforces what:** the deterministic floor proves declared mirrored-tree ownership when roots require it. Types, error style, LOC, and naming are reviewed against the plan before execution and the diff at wave closeout; they are not silently claimed as floor checks.

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

## Layout — host convention first, mirrored trees as fallback

Follow an established host test layout, including colocated tests when that is the ecosystem or repository convention. When no host convention exists, use a sibling test tree whose roots come from `architecture.yaml` `toolchain` (never assume `src/`, `tests/` or any other prefix):

```
<source-root>/<module>/...        # production code only
<test-root>/<mirrored-module>/... # mirrored unit tests
<test-root>/../integration/...    # cross-module tests — a different root, if the host has one
```

- **Mirrored fallback:** without a host convention, no test tree lives inside the source tree. Established host-native colocation is valid and needs no waiver.
- **The mirror:** preserve the path under the source root, replacing the source root with the test root. `src/features/catalog/api/<source file>` with `test_root: tests/unit` → `tests/unit/features/catalog/api/<test file>`. A monorepo package mirrors its own source.
- **`test_root` is the root of the tree that MIRRORS the source tree** — `tests/unit` in the common layout, `tests` when unit tests sit directly under `tests`. The floor mirrors the declared root; it never guesses a level.
- **The FILE NAME is the language's business.** This standard fixes the PLACE, never the name—use the host ecosystem's convention. Record it in `architecture.yaml` `naming_conventions.test_placement`.
- **Declared mirror enforcement:** when the plan explicitly declares `source_root` and `test_root`, the floor requires coverage of that mirrored tree. Do not declare those roots merely to override a valid host-native colocated layout.
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
- **Necessary, not decorative:** explain intent and constraints, never the mechanics the code already shows. Keep comments short, current, and in the codebase's own voice.
- **No task bookkeeping:** never mention task IDs, ticket IDs, or workflow/agent bookkeeping in a comment — the code carries no assignment trail.
- **Zero noise:** no restating code, no commented-out code, no inline changelogs.

## Verification

- Every `tasks.yaml` acceptance list includes ≥1 objectively verifiable check (exit code or observable output).
- Declared roots activate mirrored-layout checks; wave closeout reviews the actual diff against this file and the host convention.
- Workers receive this file's path in their contract and are strictly bound by it.
