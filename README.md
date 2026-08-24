# archgen

An installable skill that turns product intent (greenfield interview) or an existing codebase survey (brownfield) into a durable architecture contract, a dependency-ordered task graph, and quality standards — stored in a single hidden `.archgen/<slug>/` folder inside your project, executed wave-by-wave with independent verification before any code is written.

## Layout

| Path | Purpose |
| --- | --- |
| `skills/archgen/` | The portable skill: `SKILL.md`, `references/`, `scripts/` (zero-dependency Node >= 18), `assets/` |
| `schemas/` | Contracts: task-file JSON schema + architecture conventions |
| `fixtures/` | Deterministic end-to-end demos (greenfield + brownfield) |
| `docs/` | Project documentation |
| `install.sh` | Multi-harness installer |

## Status

Scaffold in progress — see `.omo/plans/` for the execution plan.
