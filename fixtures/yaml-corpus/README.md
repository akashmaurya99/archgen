# Shared YAML corpus — consumed by BOTH parsers.

`*.yaml` files here are parsed by:

1. `skills/archgen/scripts/lib/yaml.mjs` via `skills/archgen/scripts/test/corpus.test.mjs` (node:test)
2. `extension/src/host/readers/yaml.ts` (faithful TS port) via `extension/test/corpus.test.ts` (vitest)

Both suites assert **parity**: identical `data`, identical `comments`, identical
error behavior against the `*.expected.json` siblings.

## Expected-file contract

```jsonc
{
  "ok": true,
  "data": <parsed value>,
  "comments": [{ "path": ["key"] | ["\u0000seq", 0] | null, "inline": false, "text": "# ..." }]
}
// or, for malformed inputs:
{ "ok": false, "errorMatches": "substring of the thrown YamlError message" }
```

## Notes

- `structure` in `architecture.yaml` is a single-line QUOTED string on purpose:
  block scalars (`|`, `>`) are outside the shared zero-dependency subset and are
  REJECTED by design. The extension's architecture reader treats `structure` as
  optional + warns when absent. (Tension with schemas/architecture-conventions.md
  example noted in execution log — do not "fix" one side unilaterally.)
- Error-case files (`malformed-*.yaml`) must throw on BOTH sides with messages
  matching `errorMatches`.
