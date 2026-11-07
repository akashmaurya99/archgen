| Case | Input/state | Expected behavior | Covered by |
| ---- | ------------------------------- | ------------------------------------- | ---------- |
| E1 | empty/null: cart with 0 items | 200, total 0, no gateway call | PAY-2#1 |
| E2 | boundary: qty = max allowed 999 | accepted; 1000 rejected with 422 | PAY-2#1 |
| E3 | concurrent: same order paid 2x | idempotency key -> single charge | PAY-2#1 |
| E4 | authz denied: expired session | 401 error_shape, no state mutation | PAY-2#2 |
| E5 | failure/retry: gateway 5xx x3 | exponential backoff then PaymentFailed| PAY-2#2 |
| E6 | i18n: locale de-DE, zero-dec ¥ | EUR comma decimal; JPY integer math | PAY-2#4 |
