// yaml-subset.mjs — the YAML subset, stated once and machine-checked.
//
// WHY IT EXISTS. The subset was documented in ONE line of a reference the
// skill never asked the agent to load — and that line omitted the
// restriction that broke every run: a plain value containing ": ". The agent
// learned the rules by failing, one fatal error at a time.
//
// The rules live here, each with an example. A test runs every example
// through the REAL parser and asserts it behaves as documented, so the
// documentation cannot drift from the behaviour again.
//
// The reference states the same rules in prose; a test asserts that every
// rule here is named there.

/**
 * @typedef {object} SubsetRule
 * @property {string} id the rule's name — the reference must mention it
 * @property {string} rule what the subset does
 * @property {string} yaml the example
 * @property {{data: unknown}} | {{error: RegExp}} expect what the parser does
 */

/**
 * The rules of the subset.
 * @type {SubsetRule[]}
 */
export const YAML_SUBSET = [
  {
    id: 'nested-mappings',
    rule: 'Mappings nest by two-space indentation.',
    yaml: 'plan:\n  name: demo\n',
    expect: { data: { plan: { name: 'demo' } } },
  },
  {
    id: 'block-sequence',
    rule: 'A block sequence item starts with "- ".',
    yaml: 'items:\n  - one\n  - two\n',
    expect: { data: { items: ['one', 'two'] } },
  },
  {
    id: 'block-sequence-of-mappings',
    rule: 'A block sequence item may be a mapping: "- key: value".',
    yaml: 'items:\n  - id: A\n    title: x\n',
    expect: { data: { items: [{ id: 'A', title: 'x' }] } },
  },
  {
    id: 'flow-sequence',
    rule: 'A flow sequence is single-line: "[a, b]".',
    yaml: 'items: [a, b]\n',
    expect: { data: { items: ['a', 'b'] } },
  },
  {
    id: 'flow-mapping',
    rule: 'A flow mapping is single-line and flat: "{k: v, k2: v2}".',
    yaml: 'item: {id: A, title: x}\n',
    expect: { data: { item: { id: 'A', title: 'x' } } },
  },
  {
    id: 'quoted-scalars',
    rule: 'Single and double quotes are both supported, and both keep their text exactly.',
    yaml: 'a: \'x y\'\nb: "z"\n',
    expect: { data: { a: 'x y', b: 'z' } },
  },
  {
    id: 'comments',
    rule: 'A "#" starts a comment — full-line or after a value.',
    yaml: '# lead\na: 1 # trail\n',
    expect: { data: { a: 1 } },
  },
  {
    id: 'plain-value-with-colon',
    rule: 'A plain value MAY contain ": " — "title: Refactor: the auth module" is one scalar.',
    yaml: 'title: Refactor: the auth module\n',
    expect: { data: { title: 'Refactor: the auth module' } },
  },
  {
    id: 'quoted-item-with-colon',
    rule: 'A quoted sequence item is a SCALAR, never a mapping — quote a criterion that contains ": ".',
    yaml: 'acceptance:\n  - "Test: returns 200"\n',
    expect: { data: { acceptance: ['Test: returns 200'] } },
  },
  {
    id: 'unquoted-item-with-colon',
    rule: 'An UNQUOTED "key: value" sequence item is a mapping — so quote a criterion that contains ": ".',
    yaml: 'acceptance:\n  - Test: returns 200\n',
    expect: { data: { acceptance: [{ Test: 'returns 200' }] } },
  },
  {
    id: 'block-scalars-banned',
    rule: 'Block scalars ("|", ">") are not supported — write one line.',
    yaml: 'note: |\n  two lines\n',
    expect: { error: /block scalars are not supported/ },
  },
  {
    id: 'anchors-banned',
    rule: 'Anchors and tags ("&", "*", "!") are not supported.',
    yaml: 'note: &anchor value\n',
    expect: { error: /anchors\/tags are not supported/ },
  },
  {
    id: 'duplicate-keys-banned',
    rule: 'A duplicate key is refused, never silently last-wins.',
    yaml: 'a: 1\na: 2\n',
    expect: { error: /duplicate key 'a'/ },
  },
  {
    id: 'tabs-banned',
    rule: 'Tabs may not indent — spaces only.',
    yaml: 'good: 1\n\tbad: 2\n',
    expect: { error: /tab characters are not allowed/ },
  },
  {
    id: 'nested-flow-mapping-banned',
    rule: 'A flow mapping inside a flow mapping is not supported.',
    yaml: 'item: {a: {b: 1}}\n',
    expect: { error: /nested flow mappings are not supported/ },
  },
  {
    id: 'nested-sequence-banned',
    rule: 'A nested sequence item ("- - x") is not supported.',
    yaml: 'items:\n  - - one\n',
    expect: { error: /nested sequence items are not supported/ },
  },
  {
    id: 'scalar-root-banned',
    rule: 'The document must be a mapping — a plan is never a bare scalar.',
    yaml: '42\n',
    expect: { error: /expected 'key:' mapping entry/ },
  },
];
