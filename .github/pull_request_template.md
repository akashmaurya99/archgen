## What changed?

<!-- Summary of the change and why. Link related issues. -->

## Which gates ran?

- [ ] `node --test skill/scripts/test/*.test.mjs`
- [ ] `cd packages/cli && npm test`
- [ ] `cd packages/extension && npm run typecheck && npm run compile && npm test`

## Checklist

- [ ] Tests green locally (CI runs the same set)
- [ ] Conventional Commit message (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`)
- [ ] Extension changes do not mutate repository files (read-only window over `.archgen/`)
- [ ] One concern per PR; no unrelated changes
