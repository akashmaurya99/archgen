| Case | Input/state | Expected behavior | Covered by |
| ---- | ------------------------------- | ------------------------------------- | ---------- |
| E1 | empty/null: <no input or zero items> | <defined response, no side effect> | <task-id>#1 |
| E2 | boundary values: <min/max/limit value> | <accepted or rejected + status> | <task-id>#1 |
| E3 | authz denied: <missing/expired credential> | <defined denial, no state mutation> | <task-id>#2 |
| E4 | concurrent/conflicting write: <same operation twice> | <single effect / idempotent result> | <task-id>#2 |
| E5 | failure/retry path: <dependency fails N times> | <bounded retry then structured error> | <task-id>#2 |
| E6 | i18n/formatting edge: <locale, timezone, or number format> | <expected representation> | <task-id>#3 |

Covered by = `<task-id>#<acceptance index>` (1-based). The rows above are the
server's own coverage classes — name them after these for the reader. The
floor does NOT check which classes a plan covers: it checks that every row's
`Covered by` citation resolves and that the cited acceptance actually claims
the row ("(covers E4)").
