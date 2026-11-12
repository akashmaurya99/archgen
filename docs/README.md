# docs/ — how archgen works, and how to ship it

Four documents, each about one thing: how the system is built, how it gates a
build, how to hand it to an agent, and how to cut a release. They describe the
repository that **ships** archgen — the guidance an agent executes lives in
[`../skill/SKILL.md`](../skill/SKILL.md) and the protocol documents it loads
are served by the MCP server, not from here.

| Doc | What it answers |
|---|---|
| [`architecture.md`](architecture.md) | How archgen works internally — the tools, the gate flow, the containment model, wave execution, and the repository's own shape. |
| [`ci.md`](ci.md) | The deterministic floor as a **build gate** — `archgen-mcp exec … --fail-on verdict:ISSUES`. |
| [`agent-setup-prompt.md`](agent-setup-prompt.md) | A copy-paste prompt that installs archgen in any supported agent and reports the real next wave. |
| [`releasing.md`](releasing.md) | Cutting a release — one canonical version, two tags, one publish order. |

Nothing here ships. The published packages are `archgen-mcp` (the server) and
`archgen-skill` (the installer); these documents are for the people who
maintain them, and for the agents that read the repository.

Start with [`architecture.md`](architecture.md) — it is the one the rest of the
folder assumes.
