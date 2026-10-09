#!/usr/bin/env node
/**
 * eval-run — replay tickets/PRs/skill prompts against `claude -p` and grade them.
 *
 *   node tools/eval-run.mjs [--suite tasks|skill|all] [--case <id>] [--trials N]
 *                           [--out results] [--work evals/work] [--root <context dir>]
 *
 * Exit: 0 all cases pass, 1 any fail, 2 usage/config error.
 */
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { HERE } from './eval-lib.mjs';
import { loadTaskCases, loadSkillCases, resolveRepo } from './eval-cases.mjs';
import { prepareWorktree, cleanupWorktree } from './eval-worktree.mjs';
import { runAgent } from './eval-agent.mjs';
import { gradeProgrammatic, captureOutputs, gradeJudge } from './eval-grade.mjs';

const VALUE_FLAGS = new Set(['--suite', '--case', '--trials', '--out', '--work', '--root']);

function parseArgs(argv) {
  const a = { suite: 'tasks', caseId: null, trials: null, out: null, work: null, root: resolve(HERE, '..') };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (VALUE_FLAGS.has(v) && (argv[i + 1] === undefined || argv[i + 1].startsWith('--'))) {
      console.error(`eval-run: ${v} needs a value`); process.exit(2);
    }
    if (v === '--suite') a.suite = argv[++i];
    else if (v === '--case') a.caseId = argv[++i];
    else if (v === '--trials') a.trials = Number(argv[++i]);
    else if (v === '--out') a.out = resolve(argv[++i]);
    else if (v === '--work') a.work = resolve(argv[++i]);
    else if (v === '--root') a.root = resolve(argv[++i]);
    else { console.error(`eval-run: unknown arg ${v}`); process.exit(2); }
  }
  a.out = a.out || join(a.root, 'results');
  a.work = a.work || join(a.root, 'evals', 'work');
  if (!['tasks', 'skill', 'all'].includes(a.suite)) { console.error('eval-run: --suite must be tasks|skill|all'); process.exit(2); }
  if (a.trials !== null && !(Number.isInteger(a.trials) && a.trials >= 1)) { console.error('eval-run: --trials must be a positive integer'); process.exit(2); }
  return a;
}

const num = (env, dflt) => {
  const raw = process.env[env];
  if (raw === undefined || raw === '') return dflt;
  const n = Number(raw);
  if (Number.isNaN(n) || n < 0) { console.error(`eval-run: ${env} must be a non-negative number`); process.exit(2); }
  if (env === 'EVAL_TRIAL_MINUTES' && !(n >= 1 && n <= 1440)) { console.error('eval-run: EVAL_TRIAL_MINUTES must be between 1 and 1440'); process.exit(2); }
  return n;
};

async function runTrial(c, trial, a, budgets) {
  const trialDir = join(a.out, c.id, String(trial));
  mkdirSync(trialDir, { recursive: true });
  const result = { id: c.id, kind: c.kind, trial, withSkill: c.withSkill ?? !!c.skill, pass: false, gates: [], allMet: null, judge: null, meta: null, error: null };
  let wt = null, cwd = null;
  try {
    if (c.repo) {
      wt = await prepareWorktree(c, { repoPath: resolveRepo(c.repo, a.root), workRoot: a.work, trial });
      cwd = wt.path;
    } else {
      cwd = mkdtempSync(join(tmpdir(), `eval-${c.id}-`)); // skill cases: empty scratch dir, no repo access by construction
    }
    const agent = await runAgent(c, cwd, { root: a.root, trialDir, budgetUsd: budgets.trialUsd, timeoutMs: budgets.trialTimeoutMs });
    result.meta = agent.meta;
    const prog = await gradeProgrammatic(c, cwd);
    result.gates = prog.gates; result.allMet = prog.allMet;
    writeFileSync(join(trialDir, 'gate-check.log'), prog.output);
    await captureOutputs(c, cwd, trialDir, agent.resultText);
    if (c.judge.length) {
      result.judge = await gradeJudge(c, trialDir, { budgetUsd: budgets.judgeUsd, timeoutMs: 15 * 60 * 1000 });
    }
    const judgeOk = !c.judge.length || result.judge.summary.pass_rate === 1;
    result.pass = prog.allMet && judgeOk && !agent.meta.timedOut;
  } catch (e) {
    result.error = String(e?.stack || e);
  } finally {
    try { if (wt) await cleanupWorktree(wt); else if (cwd) rmSync(cwd, { recursive: true, force: true }); }
    catch (e) { result.error = (result.error ? result.error + '\n' : '') + `cleanup: ${e.message}`; result.pass = false; }
  }
  writeFileSync(join(trialDir, 'result.json'), JSON.stringify(result, null, 2));
  console.log(`${result.pass ? 'PASS' : 'FAIL'} ${c.id} trial ${trial}${result.error ? ' — ' + result.error.split('\n')[0] : ''}`);
  return result;
}

async function main() {
  const a = parseArgs(process.argv.slice(2));
  let cases = [];
  if (a.suite !== 'skill') cases.push(...loadTaskCases(a.root, { caseId: a.caseId }));
  if (a.suite !== 'tasks') cases.push(...loadSkillCases(a.root, { caseId: a.caseId }));
  if (!cases.length) { console.error(`eval-run: no cases${a.caseId ? ` matching ${a.caseId}` : ''}`); process.exit(2); }
  const budgets = { trialUsd: num('EVAL_TRIAL_USD', 6), trialTimeoutMs: num('EVAL_TRIAL_MINUTES', 45) * 60 * 1000, judgeUsd: num('EVAL_JUDGE_USD', 2) };
  mkdirSync(a.out, { recursive: true });

  const summary = { ran: 0, passed: 0, failed: 0, cases: [] };
  for (const c of cases) {
    const trials = a.trials ?? (c.judge.length ? 3 : 1);
    const results = [];
    for (let t = 1; t <= trials; t++) results.push(await runTrial(c, t, a, budgets));
    const pass = results.every((r) => r.pass);
    summary.ran++; summary[pass ? 'passed' : 'failed']++;
    summary.cases.push({ id: c.id, kind: c.kind, withSkill: c.withSkill ?? !!c.skill, pass, trials: results.map((r) => ({ trial: r.trial, pass: r.pass, usd: r.meta?.usd ?? null, error: r.error ? r.error.split('\n')[0] : null })) });
  }
  writeFileSync(join(a.out, 'summary.json'), JSON.stringify(summary, null, 2));
  console.log(`\n${summary.passed}/${summary.ran} cases passed`);
  process.exit(summary.failed ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(2); });
