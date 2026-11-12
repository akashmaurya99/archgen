# The YAML corpus — archgen's frozen artifact-format contract.

`*.yaml` files here are parsed by the CANONICAL parser
(`packages/mcp/src/core/fs/yaml.mjs`) and asserted against their committed
`*.expected.json` siblings by `packages/mcp/test/core/yaml-corpus.test.mjs`
(node:test).

There is exactly ONE implementation of this format. That is the point: a
`tasks.yaml` and an `architecture.yaml` are read by the verifier, the wave
resolver, the registry updater and the status mutator, and every one of them
is individually correct — which is exactly why a parser that drifted would
drift all of them, silently. The corpus is what makes that drift loud.

The corpus used to have a second consumer: a hand-written TypeScript port the
VS Code extension carried. Two implementations of one format is precisely the
kind of drift this repo cannot afford, so the port was removed and the corpus
was left with its one canonical owner.

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

Never adjust an expectation to make a test pass. A changed expectation means
the FORMAT changed — which is a decision, not a cleanup — and every consumer
of that format has to move with it.

## Notes

- `structure` in `architecture.yaml` is a single-line QUOTED string on purpose:
  block scalars (`|`, `>`) are outside archgen's zero-dependency YAML subset
  and are REJECTED by design. (Tension with
  schemas/architecture-conventions.md noted in the execution log — do not
  "fix" one side unilaterally.)
- Error-case files (`malformed-*.yaml`) must throw with messages matching
  `errorMatches`.
- `crlf.yaml` is the Windows-authoring case: pure `\r\n` line endings. The
  parser normalizes `\r` at tokenize time — without that, a CRLF `tasks.yaml`
  fails to parse (or corrupts values) and every tool that reads it fails with
  it.
