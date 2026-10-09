import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { sh, quote } from './eval-lib.mjs';

const CONTRACT = `
---
Working contract for this run:
- You are in a checkout of {repo} at {base}. Implement the ticket above in place.
- Run the lint, typecheck and test commands you consider necessary; fix what you break.
- Do not push, open PRs, merge, deploy, or write to Linear. Do not create new git branches.
- When the work is complete, stop. Do not summarise the codebase.
- Treat this checkout as the only source of truth. Ignore any memory, notes, or branches that describe later work on this ticket; implement it here.`;

const REVIEW = `You are reviewing a pull request. Use the code-review skill.

The diff under review is everything after {base}: run \`git diff {base} HEAD\` to see it.

Ticket the PR claims to implement:

{ticket}

Write your complete review to a file named review-output.md in the repository root. Put each finding on
its own line, prefixed with exactly one of BLOCKER, MAJOR, MINOR, or NIT, then the file path, then the
reason. If you find nothing blocking, the file must contain the line "NO BLOCKERS". Do not modify any
other file. Do not push or write to Linear. Treat this checkout as the only source of truth; ignore any
memory, notes, or branches describing later work on this ticket.`;

export function buildPrompt(c) {
  if (c.kind === 'skill') return c.prompt;
  const ticket = readFileSync(join(c.dir, c.prompt_file), 'utf8');
  // Function replacers: ticket text can contain $-patterns (e.g. "$110") that
  // String.replace would otherwise interpret as replacement-pattern escapes.
  if (c.kind === 'review') return REVIEW.replace(/\{base\}/g, () => c.base).replace('{ticket}', () => ticket);
  return ticket + CONTRACT.replace('{repo}', () => c.repo).replace('{base}', () => c.base);
}

/** Copy skills/<name> into <cwd>/.claude/skills so `claude -p` discovers the version under test. */
export function installSkill(c, cwd, root) {
  if (!c.skill) return () => {};
  const dst = join(cwd, '.claude', 'skills', c.skill);
  const hadSkillsDir = existsSync(join(cwd, '.claude', 'skills'));
  cpSync(join(root, 'skills', c.skill), dst, { recursive: true });
  return () => { if (hadSkillsDir) rmSync(dst, { recursive: true, force: true }); else rmSync(join(cwd, '.claude', 'skills'), { recursive: true, force: true }); };
}

// Same strings go into settings.json's deny list and the claude argv's --disallowed-tools.
export const denyList = (c) => [
  ...c.deny.map((d) => `Bash(${d}*)`),
  'Bash(git push*)', 'Bash(gh pr *)', 'Bash(gh release *)', 'Bash(gh *)',
  'Bash(npx eas*)', 'Bash(npx sam*)', 'Bash(aws *)', 'WebFetch', 'WebSearch',
];

/** Merge deny rules into <cwd>/.claude/settings.json (the app repo may track one). Restore afterwards. */
export function writeDenySettings(c, cwd) {
  const dir = join(cwd, '.claude');
  const file = join(dir, 'settings.json');
  const before = existsSync(file) ? readFileSync(file, 'utf8') : null;
  const s = before ? JSON.parse(before) : {};
  s.permissions = s.permissions || {};
  s.permissions.deny = [...(s.permissions.deny || []), ...denyList(c)];
  // the app repo's tracked settings.json enables plugins (agent-kit among them), any of which
  // could shadow the copied skill under test (or leak into a noskill baseline). Disable all
  // of them for the run, keeping agent-kit@agent-context explicitly false even if absent.
  s.enabledPlugins = { ...(s.enabledPlugins || {}), 'agent-kit@agent-context': false };
  for (const k of Object.keys(s.enabledPlugins)) s.enabledPlugins[k] = false;
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(s, null, 2));
  return () => { if (before === null) rmSync(file, { force: true }); else writeFileSync(file, before); };
}

export async function runAgent(c, cwd, { root, trialDir, budgetUsd, timeoutMs }) {
  const prompt = buildPrompt(c); // read-only: fail before any mutation happens
  const promptFile = join(cwd, '.eval-prompt.md');
  const bin = process.env.EVAL_CLAUDE_BIN || 'claude';
  const args = [
    '--print', '--output-format', 'json', '--model', c.model,
    '--permission-mode', 'bypassPermissions', '--max-budget-usd', String(budgetUsd),
    '--setting-sources', 'project', '--strict-mcp-config', '--max-turns', '60',
  ];
  for (const t of denyList(c)) args.push('--disallowed-tools', quote(t));

  let restoreSkill = () => {};
  let restoreDeny = () => {};
  const t0 = Date.now();
  let r;
  try {
    restoreSkill = installSkill(c, cwd, root);
    restoreDeny = writeDenySettings(c, cwd);
    writeFileSync(promptFile, prompt);
    r = await sh(`${bin} ${args.join(' ')} < ${quote(promptFile)}`, { cwd, timeoutMs });
  } finally {
    // Each cleanup independent: an EPERM/EBUSY on one (e.g. Windows rmSync right after a
    // timeout taskkill) must not skip the others. Tracked-file restore (restoreDeny) first.
    try { rmSync(promptFile, { force: true }); } catch { /* best effort */ }
    try { restoreDeny(); } catch { /* best effort */ }
    try { restoreSkill(); } catch { /* best effort */ }
  }
  mkdirSync(trialDir, { recursive: true });
  writeFileSync(join(trialDir, 'transcript.json'), r.stdout || '');
  if (r.stderr) writeFileSync(join(trialDir, 'stderr.txt'), r.stderr);
  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* keep null; meta records exit */ }
  const meta = {
    model_requested: c.model,
    model_reported: parsed?.modelUsage ? Object.keys(parsed.modelUsage) : [],
    usd: parsed?.total_cost_usd ?? null,
    turns: parsed?.num_turns ?? null,
    duration_ms: parsed?.duration_ms ?? (Date.now() - t0),
    exit: r.code, timedOut: r.timedOut,
    is_error: parsed?.is_error ?? (r.code !== 0),
    stop_reason: parsed?.stop_reason ?? null,
  };
  writeFileSync(join(trialDir, 'meta.json'), JSON.stringify(meta, null, 2));
  return { meta, parsed, resultText: parsed?.result ?? r.stdout };
}
