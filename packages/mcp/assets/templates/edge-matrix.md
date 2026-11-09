| Case | Input/state | Expected behavior | Covered by |
| ---- | ------------------------------- | ------------------------------------- | ---------- |
| E1 | empty/null: <no input or zero items> | <defined response, no side effect> | <task-id>#1 |
| E2 | boundary: <min/max/limit value> | <accepted or rejected + status> | <task-id>#1 |
| E3 | concurrent: <same operation twice> | <single effect / idempotent result> | <task-id>#1 |
| E4 | authz denied: <missing/expired credential> | <defined denial, no state mutation> | <task-id>#2 |
| E5 | failure/retry: <dependency fails N times> | <bounded retry then structured error> | <task-id>#2 |
| E6 | i18n: <locale, timezone, or number format> | <expected representation> | <task-id>#3 |
