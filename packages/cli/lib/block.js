// block.js — managed-block writer for AGENTS.md / CLAUDE.md context pointers.
//
// WHY marked blocks: installers must never clobber user content. Everything
// archgen writes lives between START/END markers; re-runs replace the block
// in place, uninstalls strip it, and anything the user wrote outside the
// markers is untouched.

export const START = '<!-- archgen:start (managed block - do not edit between markers) -->';
export const END = '<!-- archgen:end -->';

/**
 * Render the archgen pointer block for a project.
 * @param {string} skillRelPath relative path to the skill dir from project root
 */
export function renderBlock(skillRelPath = '.agents/skills/archgen') {
  return [
    START,
    '# ArchGen - Architecture Generation & Autonomous Task Execution',
    '',
    'This project uses the **archgen** skill, installed at `' + skillRelPath + '/`.',
    '',
    '**Before running any archgen workflow, read its instructions:**',
    'read `' + skillRelPath + '/SKILL.md` first - it defines every mode, gate, and rule.',
    '',
    'Quick triggers:',
    '- "generate architecture for X" -> greenfield GENERATE mode',
    '- "add feature X" -> BROWNFIELD survey-first mode (analyzes this codebase)',
    '- "start work" -> execute pending tasks in `.archgen/*/tasks.yaml` wave-by-wave',
    '- "roll back ..." / "install mcp ..." / "fetch design skill" -> auxiliary modes',
    '',
    'Rules of the road:',
    '- Generated artifacts live ONLY under `.archgen/<slug>/`',
    '- Never hand-edit task statuses - use `scripts/set-status.mjs` (comment-safe)',
    '- Two gates before any execution: verifier approval, then human approval',
    END,
  ].join('\n');
}

/**
 * Insert or replace the managed block inside existing file content.
 * @param {string} existing file contents ('' when creating new)
 * @param {string} block rendered block
 */
export function upsertBlock(existing, block) {
  const trimmed = existing ?? '';
  const startIdx = trimmed.indexOf(START);
  const endIdx = trimmed.indexOf(END);
  if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
    return trimmed.slice(0, startIdx) + block + trimmed.slice(endIdx + END.length);
  }
  if (startIdx !== -1 || endIdx !== -1) {
    throw new Error('found only one archgen marker - fix or remove it manually');
  }
  if (trimmed.trim() === '') return block + '\n';
  return trimmed.replace(/\n*$/, '\n\n') + block + '\n';
}

/**
 * Strip the managed block from file contents.
 * @returns {{content: string, hadBlock: boolean}}
 */
export function stripBlock(existing) {
  const trimmed = existing ?? '';
  const startIdx = trimmed.indexOf(START);
  const endIdx = trimmed.indexOf(END);
  if (startIdx === -1 || endIdx === -1) return { content: trimmed, hadBlock: false };
  let out = trimmed.slice(0, startIdx) + trimmed.slice(endIdx + END.length);
  // Collapse whitespace left behind; drop file if nothing else remains.
  out = out.replace(/^\n+/, '').replace(/\n{3,}/g, '\n\n');
  return { content: out, hadBlock: true };
}
