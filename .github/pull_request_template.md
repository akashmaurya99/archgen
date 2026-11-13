## What changed?

<!-- Summary of the change and why. Link related issues. -->

## Which gates ran?

- [ ] `npm test` (internal QA + MCP + CLI + teaching + structure)
- [ ] `npm --prefix packages/cli run sync:check` (after any `skill/` or `archgen.config.json` edit)
- [ ] `npm run test:budget` (after touching a tool description, an argument, or the skill)

## Checklist

- [ ] Tests green locally (CI runs the same set)
- [ ] Conventional Commit message (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`)
- [ ] One concern per PR; no unrelated changes
