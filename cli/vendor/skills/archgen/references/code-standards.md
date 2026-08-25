# Code standards — contractual, verifier-enforced

Workers and planners follow these. The verifier rejects tasks whose plan or
output violates them. Every rule exists because its absence produced real
production incidents somewhere.

## Typing (TypeScript projects)

- NO ANY: `any` is BANNED — including implicit anys and `as any` casts. Enable `"strict": true` plus
  `noImplicitAny`, `strictNullChecks`, `noUncheckedIndexedAccess`.
- No unhandled `undefined`/null: validate at boundaries (env parsing, API
  input) with a schema; inside the codebase use non-optional types + explicit
  result objects for fallible operations.
- Prefer discriminated unions over boolean-flag parameters.
- Generated Python/Rust/Go equivalents: type hints mandatory / no `unwrap()` on
  fallibles / handle errors explicitly — same discipline per language.

## File & module limits

- HARD CEILING: files < 1000 LOC. Split well before — when a file gains a
  second responsibility, that IS the split signal.
- One public purpose per module. If the docstring needs "and", split.

## Folder structure (planned in architecture.yaml BEFORE coding)

```
src/
  features/<name>/        # feature-first: everything a feature owns
    api/                  #   inbound contracts (routes/handlers)
    internal/             #   private implementation
    tests/                #   colocated tests mirror structure
  shared/                 # cross-feature ONLY; may not import features/
  config/                 # typed env + constants
```

- Feature modules may import `shared/`; `shared/` imports NOTHING from features.
- Tests live beside code (mirrored path), never a distant `/tests` desert.

## File naming

Per-language conventions (professional, descriptive, consistent):

| Language | Source files | Components/classes | Tests |
|---|---|---|---|
| TypeScript | `kebab-case.ts` | `PascalCase.tsx` components, `PascalCase` classes | `<subject>.test.ts` colocated |
| Python | `snake_case.py` modules | `PascalCase` classes, `snake_case` functions | `test_<subject>.py` mirrored |
| Rust | `snake_case.rs` modules | `PascalCase` types/traits | `#[cfg(test)] mod tests` inline or `tests/` |
| Go | `snake_case.go` packages | `PascalCase` exported / `camelCase` internal | `<subject>_test.go` same dir |

- Descriptive > clever: `rate-limiter.ts` not `rl.ts`; `parse-config.ts` not
  `utils2.ts`.
- BANNED names: `utils.ts`, `misc.ts`, `helpers.ts`, `temp*`, `final*`,
  `copy*`, numbered duplicates (`auth2.ts`) — split by responsibility instead.

## Comments

- WHY at decision points: tradeoffs taken, non-obvious constraints, links to
  decisions ("see ADR D3"). 
- Public APIs get doc comments: purpose, params, failure modes.
- NO noise: no `// increment i`, no commented-out code, no change-log comments
  (git remembers).

## Enforcement hooks

- tasks.yaml acceptance criteria MUST include at least one objectively
  checkable statement (command exit, observable output).
- The verifier runs verify-plan.mjs AND reads plans against this file;
  violations = ISSUES, not warnings.
- Workers receive this reference in their prompt contract; "I didn't know" is
  not available to them.
