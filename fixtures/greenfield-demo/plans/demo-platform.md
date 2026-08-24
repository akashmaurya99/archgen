# Demo Platform — generation plan (LARGE)

Intent: stand up a two-feature service (notes API plus admin web console)
with a shared kernel, a docs track, and an end-to-end verification gate.

Wave plan (resolved by next-tasks.mjs):

1. SCAFFOLD — project skeleton plus typed config loading
2. SHARED and DOCS — shared kernel helpers; user guide and decision records
3. API and WEB — feature modules in parallel under disjoint file_ownership
4. VERIFY — cross-feature smoke suite over both features

Risks: config drift between features, mitigated by the typed config owned by
SCAFFOLD; shared-kernel scope creep, mitigated by the no-feature-imports rule.

Every task id above carries objective acceptance criteria in tasks.yaml.
