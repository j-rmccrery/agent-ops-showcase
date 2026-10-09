import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { sh, quote, parseGatesFile, readJson, HERE } from './eval-lib.mjs';
import { denyList } from './eval-agent.mjs';

const GATE_CHECK = join(HERE, 'gate-check.mjs');
const GRADER_MD = join(HERE, 'eval-grader.md');

/** Copy each hidden tree into cwd. Called only after the agent process has exited. */
export function sealHidden(c, cwd) {
  for (const h of c.hidden) cpSync(join(c.dir, h), cwd, { recursive: true });
}

export async function gradeProgrammatic(c, cwd) {
  const gatesFile = join(c.dir, 'GATES.md');
  if (!existsSync(gatesFile)) return { gates: [], allMet: true, output: '(no GATES.md: judge-only case)' };
  sealHidden(c, cwd);
  cpSync(gatesFile, join(cwd, 'GATES.md'));
  const r = await sh(`node ${quote(GATE_CHECK)} GATES.md --timeout 900`, { cwd, timeoutMs: 60 * 60 * 1000 });
  const gates = parseGatesFile(readFileSync(join(cwd, 'GATES.md'), 'utf8'));
  return { gates, allMet: r.code === 0 && gates.every((g) => g.met), output: r.stdout + r.stderr };
}

/** All file paths under dir, relative to dir, forward-slashed. */
function walkFiles(dir, base = dir, out = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(full, base, out);
    else out.push(relative(base, full).split(sep).join('/'));
  }
  return out;
}

// sealHidden copies each hidden/ tree's *contents* straight into cwd (after the agent has
// already exited), so those files land at the same relative paths git would see them at.
// Exclude them by path so the judge never mistakes hidden-test scaffolding for agent work.
function hiddenPathspecs(c) {
  if (!c.dir) return [];
  return (c.hidden ?? []).flatMap((h) => {
    const hdir = join(c.dir, h);
    return existsSync(hdir) ? walkFiles(hdir).map((f) => quote(`:!${f}`)) : [];
  });
}

export async function captureOutputs(c, cwd, trialDir, resultText) {
  const out = join(trialDir, 'outputs');
  mkdirSync(out, { recursive: true });
  writeFileSync(join(out, 'result.md'), resultText ?? '');
  if (c.base) {
    const excludes = [quote(':!GATES.md'), ...hiddenPathspecs(c)].join(' ');
    await sh(`git add -A -- . ${excludes}`, { cwd });
    const d = await sh(`git diff --cached ${c.base}`, { cwd });
    writeFileSync(join(out, 'diff.patch'), d.stdout);
    writeFileSync(join(out, 'diff-files.txt'), (await sh(`git diff --cached --name-only ${c.base}`, { cwd })).stdout);
  }
  if (existsSync(join(cwd, 'review-output.md'))) cpSync(join(cwd, 'review-output.md'), join(out, 'review-output.md'));
  if (existsSync(join(cwd, 'GATES.md'))) cpSync(join(cwd, 'GATES.md'), join(trialDir, 'gates.md'));
}

export async function gradeJudge(c, trialDir, { budgetUsd, timeoutMs }) {
  const gradingPath = join(trialDir, 'grading.json');
  rmSync(gradingPath, { force: true }); // trialDir is reused across runs; never let a stale verdict pass as fresh
  const prompt = [
    readFileSync(GRADER_MD, 'utf8'),
    '', '---', '', 'Parameters for this grading run:', '',
    'expectations:', ...c.judge.map((j) => `- ${j}`), '',
    `transcript_path: ${join(trialDir, 'transcript.json')}`,
    `outputs_dir: ${join(trialDir, 'outputs')}`, '',
    `Write grading.json to ${gradingPath}`, '',
  ].join('\n');
  const promptFile = join(trialDir, 'judge-prompt.md');
  writeFileSync(promptFile, prompt);
  const bin = process.env.EVAL_CLAUDE_BIN || 'claude';
  const model = process.env.EVAL_JUDGE_MODEL || 'opus';
  const disallowed = denyList({ deny: [] }).map((t) => `--disallowed-tools ${quote(t)}`).join(' ');
  const r = await sh(
    `${bin} --print --output-format json --model ${model} --permission-mode bypassPermissions --max-budget-usd ${budgetUsd} --setting-sources project --strict-mcp-config ${disallowed} --add-dir ${quote(trialDir)} < ${quote(promptFile)}`,
    { cwd: trialDir, timeoutMs },
  );
  writeFileSync(join(trialDir, 'judge-transcript.json'), r.stdout || '');
  if (!existsSync(gradingPath)) throw new Error(`${c.id}: judge produced no grading.json (exit ${r.code})`);
  return readJson(gradingPath);
}
