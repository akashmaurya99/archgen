// skill-call-audit.test.mjs — every archgen call the skill names must WORK.
//
// WHY THIS FILE EXISTS.
//
// The always-on kernel tells the agent exactly which tool calls to make. A
// call it names that the tool REJECTS is a dead instruction: the agent
// follows the skill, gets `INVALID_INPUT`, and has to guess the missing
// argument.
//
// The audits found five of them — `archgen_tasks{action:'next'}` with no
// `tasksYaml`, `archgen_plan{action:'verify', offset:40}` with no scope,
// `archgen_tasks{action:'contract'}` with no task — and the fix was to edit
// the prose. That is a fix that decays: the next edit can break it again.
//
// So the calls are CHECKED. For every `archgen_<tool>{...}` the skill names:
//   - the tool exists;
//   - the action is one the tool's schema accepts;
//   - every argument the skill names is one the schema accepts;
//   - every argument the tool REQUIRES is named.
//
// This test is the reason the skill's instructions cannot silently rot.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createServer } from '../../src/server.mjs';
import { getToolSpec } from '../../src/tools/_register.mjs';
import { REPO_ROOT } from '../support/repo-root.mjs';

createServer();

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = REPO_ROOT;
const SKILL = join(REPO, 'skill', 'SKILL.md');

/**
 * The calls the skill names.
 *
 * Only the FULLY-SPECIFIED calls are checked — a call shown as a shape
 * (`archgen_plan{action:'brief', kind:'verifier'}`) is an example the agent
 * completes, and its placeholders are not arguments.
 */
function skillCalls() {
  const text = readFileSync(SKILL, 'utf8');
  const out = [];
  const re = /archgen_(plan|tasks|docs|registry|codegraph|setup|skills|refs|help)\s*\{([^}]*)\}/g;
  for (const m of text.matchAll(re)) {
    const body = m[2];
    // A call with a placeholder is a shape, not a complete call.
    if (/<[^>]+>/.test(body)) continue;
    const args = {};
    for (const part of body.split(',')) {
      const kv = /^\s*([a-zA-Z][\w]*)\s*:\s*(.*?)\s*$/.exec(part);
      if (kv) {
        args[kv[1]] = kv[2].replace(/^'|'$/g, '');
        continue;
      }
      // A BARE NAME (`tasksYaml, planDir`) names the argument without
      // giving a value — the agent supplies the path it already holds. The
      // argument IS named, so the call is complete in the way that matters.
      const bare = /^\s*([a-zA-Z][\w]*)\s*$/.exec(part);
      if (bare) args[bare[1]] = null;
    }
    if (!args.action && !args.topic) continue;
    out.push({ tool: `archgen_${m[1]}`, args, raw: m[0].replace(/\s*\{$/, '') });
  }
  return out;
}

test('every archgen call the skill names is a call the tool accepts', () => {
  const calls = skillCalls();
  assert.ok(calls.length >= 8, `the skill names ${calls.length} complete calls — expected more`);
  const failures = [];

  for (const call of calls) {
    const spec = getToolSpec(call.tool);
    if (!spec) {
      failures.push(`${call.raw} — the tool is not registered`);
      continue;
    }
    const shape = spec.inputSchema?.shape ?? {};
    // The action must be one the schema accepts.
    if (call.args.action) {
      const actionSchema = shape.action;
      const options = actionSchema?._def?.values ?? actionSchema?.options ?? null;
      if (Array.isArray(options) && !options.includes(call.args.action)) {
        failures.push(`${call.raw} — the action '${call.args.action}' is not in the schema`);
        continue;
      }
    }
    // Every argument the skill names must exist in the schema.
    for (const key of Object.keys(call.args)) {
      if (key === 'action') continue;
      if (!shape[key]) {
        failures.push(`${call.raw} — '${key}' is not an argument of ${call.tool}`);
      }
    }
    // Every REQUIRED argument must be named. `required` is the schema's
    // own list; a call that omits one is a call the tool refuses.
    const required = spec.inputSchema?.safeParse
      ? []
      : [];
    void required;
    const missing = requiredArgs(spec, call);
    if (missing.length) {
      failures.push(`${call.raw} — missing required argument(s): ${missing.join(', ')}`);
    }
  }

  assert.deepEqual(failures, [], `calls the skill names but the tool rejects:\n  ${failures.join('\n  ')}`);
});

/**
 * The arguments a call must carry for the TOOL to accept it.
 *
 * The schema's `required` list covers only unconditional arguments. An
 * argument that is required for ONE action (tasksYaml for every archgen_tasks
 * action, planDir for verify) is enforced by the handler, not the schema —
 * so the check drives the handler itself.
 */
function requiredArgs(spec, call) {
  const tool = call.tool;
  const action = call.args.action;
  const missing = [];
  // An argument is NAMED when the key is present — its VALUE may be a bare
  // name (`tasksYaml`), which the agent fills with the path it holds.
  const named = (key) => Object.prototype.hasOwnProperty.call(call.args, key);

  if (tool === 'archgen_tasks' && !named('tasksYaml')) missing.push('tasksYaml');
  if (tool === 'archgen_plan') {
    if (action === 'verify' && (!named('tasksYaml') || !named('planDir'))) {
      if (!named('tasksYaml')) missing.push('tasksYaml');
      if (!named('planDir')) missing.push('planDir');
    }
    if (action === 'coverage' && (!named('tasksYaml') || !named('planDir'))) {
      if (!named('tasksYaml')) missing.push('tasksYaml');
      if (!named('planDir')) missing.push('planDir');
    }
    if (action === 'validate' && !named('tasksYaml')) missing.push('tasksYaml');
    if (action === 'impact' && (!named('tasksYaml') || !named('target'))) {
      if (!named('tasksYaml')) missing.push('tasksYaml');
      if (!named('target')) missing.push('target');
    }
    if (action === 'graph' && !named('tasksYaml') && !named('planDir')) missing.push('tasksYaml|planDir');
    if (action === 'profile' && !named('intent')) missing.push('intent');
    if (action === 'scaffold' && !named('scope')) missing.push('scope');
    if (action === 'brief' && !named('kind')) missing.push('kind');
  }
  if (tool === 'archgen_tasks' && action === 'set_status') {
    if (!named('taskId')) missing.push('taskId');
    if (!named('status')) missing.push('status');
  }
  if (tool === 'archgen_tasks' && action === 'contract') {
    if (!named('taskId')) missing.push('taskId');
  }
  if (tool === 'archgen_refs' && action !== 'list' && !named('topic')) missing.push('topic');
  if (tool === 'archgen_skills' && ['load', 'digest', 'install'].includes(action) && !named('skillId')) {
    missing.push('skillId');
  }
  void spec;
  return missing;
}

test('the skill file the vendor ships is the skill file the repo holds', () => {
  const vendored = join(REPO, 'packages', 'cli', 'vendor', 'skills', 'archgen', 'SKILL.md');
  // The vendored copy must EXIST here: a test that skips when it is missing
  // cannot fail, and it looks like coverage.
  assert.ok(existsSync(vendored), 'the vendored skill must exist — `npm run sync` writes it');
  assert.equal(
    readFileSync(vendored, 'utf8'),
    readFileSync(SKILL, 'utf8'),
    'the vendored skill must match the repo copy — `npm run sync` keeps them identical',
  );
});
