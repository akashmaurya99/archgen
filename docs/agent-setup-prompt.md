# Agent setup prompt

Paste this into any supported agent to have it install archgen.

```text
Install ArchGen — the architecture-generation and task-execution system for
coding agents — in this repository.

1. In the repository root, run:

       npx archgen-skill init

   If `npx` is unavailable:

       npm install -g archgen-skill
       archgen-skill init

   It installs the skill, wires the archgen MCP server into every detected
   harness, and ensures CodeGraph. It needs network access and may take a
   minute.

2. Call `archgen_setup { action: 'doctor' }` and report what it says.

3. If the archgen MCP tools are not in your tool list, the server is not
   connected: tell me to reload the harness and stop.

4. If the tools are present, check for an existing plan under `.archgen/`.
   If one exists, call
   `archgen_tasks { action: 'next', tasksYaml: '<abs path>/tasks.yaml' }`
   and report the next wave. If none exists, say so and stop.

Report the real result of each step — the output or the exact error. Do not
claim anything worked unless it did.
```
