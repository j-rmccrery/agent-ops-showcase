import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sh } from '../eval-lib.mjs';

const RUN = join(import.meta.dirname, '..', 'eval-run.mjs');
const STUB = `node ${JSON.stringify(join(import.meta.dirname, 'fixtures', 'claude-stub.mjs'))}`;
const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };

async function fixtureRoot() {
  const root = mkdtempSync(join(tmpdir(), 'evalroot-'));
  const repo = join(root, 'repos', 'app');
  mkdirSync(repo, { recursive: true });
  await sh('git init -q', { cwd: repo, env });
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  await sh('git add -A && git commit -qm one', { cwd: repo, env });
  const base = (await sh('git rev-parse HEAD', { cwd: repo })).stdout.trim();

  const impl = join(root, 'evals', 'tasks', 'impl-ok');
  mkdirSync(join(impl, 'hidden'), { recursive: true });
  writeFileSync(join(impl, 'case.json'), JSON.stringify({ id: 'impl-ok', kind: 'implement', repo: 'your-org/app', base, prompt_file: 'ticket.md', hidden: ['hidden'] }));
  writeFileSync(join(impl, 'ticket.md'), 'Edit a.txt');
  writeFileSync(join(impl, 'hidden', 'check.js'), 'const fs=require("fs");process.exit(fs.readFileSync("a.txt","utf8").includes("agent-edited")?0:1)');
  writeFileSync(join(impl, 'GATES.md'), '- [ ] G1: hidden check\n  CHECK: node check.js\n  EVIDENCE: pending\n');

  const rev = join(root, 'evals', 'tasks', 'review-miss');
  mkdirSync(rev, { recursive: true });
  writeFileSync(join(rev, 'case.json'), JSON.stringify({ id: 'review-miss', kind: 'review', repo: 'your-org/app', base, prompt_file: 'ticket.md', seed_patch: 'seed.patch' }));
  writeFileSync(join(rev, 'ticket.md'), 'ticket');
  writeFileSync(join(rev, 'seed.patch'), 'diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1 +1 @@\n-one\n+bug\n');
  writeFileSync(join(rev, 'GATES.md'), '- [ ] G1: flags a.txt\n  CHECK: grep -E "BLOCKER.*a\\.txt" review-output.md\n  EVIDENCE: pending\n');

  mkdirSync(join(root, 'skills', 'x', 'evals'), { recursive: true });
  writeFileSync(join(root, 'skills', 'x', 'SKILL.md'), 'x');
  writeFileSync(join(root, 'skills', 'x', 'evals', 'evals.json'), JSON.stringify({ skill_name: 'x', evals: [{ id: 1, eval_name: 'clean', prompt: 'p', assertions: ['a1'] }] }));
  return { root, base };
}

test('eval-run: tasks suite grades both cases, exit 1 because the review case fails', async () => {
  const { root } = await fixtureRoot();
  const r = await sh(`node ${JSON.stringify(RUN)} --suite tasks --root ${JSON.stringify(root)} --out ${JSON.stringify(join(root, 'results'))} --work ${JSON.stringify(join(root, 'work'))}`,
    { env: { EVAL_CLAUDE_BIN: STUB, EVAL_REPOS_ROOT: join(root, 'repos') }, timeoutMs: 60000 });
  assert.equal(r.code, 1, r.stdout + r.stderr);
  const ok = JSON.parse(readFileSync(join(root, 'results', 'impl-ok', '1', 'result.json'), 'utf8'));
  assert.equal(ok.pass, true);
  assert.equal(ok.gates[0].met, true);
  const miss = JSON.parse(readFileSync(join(root, 'results', 'review-miss', '1', 'result.json'), 'utf8'));
  assert.equal(miss.pass, false, 'stub reviewer flags src/x.ts, not a.txt');
  assert.equal(miss.gates[0].met, false);
  assert.equal(miss.error, null);
  const summary = JSON.parse(readFileSync(join(root, 'results', 'summary.json'), 'utf8'));
  assert.deepEqual([summary.ran, summary.passed, summary.failed], [2, 1, 1]);
  assert.ok(!existsSync(join(root, 'work', 'impl-ok-t1')), 'worktree cleaned');
});

test('eval-run: skill suite runs with/without pairs through the judge, --trials overrides', async () => {
  const { root } = await fixtureRoot();
  const r = await sh(`node ${JSON.stringify(RUN)} --suite skill --trials 1 --root ${JSON.stringify(root)} --out ${JSON.stringify(join(root, 'results'))} --work ${JSON.stringify(join(root, 'work'))}`,
    { env: { EVAL_CLAUDE_BIN: STUB }, timeoutMs: 60000 });
  assert.equal(r.code, 0, r.stdout + r.stderr);
  const w = JSON.parse(readFileSync(join(root, 'results', 'skill-x-1-clean-withskill', '1', 'result.json'), 'utf8'));
  assert.equal(w.judge.summary.pass_rate, 1);
  assert.match(readFileSync(join(root, 'results', 'skill-x-1-clean-withskill', '1', 'outputs', 'result.md'), 'utf8'), /skill dir present: true/);
  const n = readFileSync(join(root, 'results', 'skill-x-1-clean-noskill', '1', 'outputs', 'result.md'), 'utf8');
  assert.match(n, /skill dir present: false/);
  assert.ok(!existsSync(join(root, 'results', 'skill-x-1-clean-withskill', '2')), '--trials 1 overrode the judge default of 3');
});

test('eval-run: unknown --case exits 2', async () => {
  const { root } = await fixtureRoot();
  const r = await sh(`node ${JSON.stringify(RUN)} --suite tasks --case nope --root ${JSON.stringify(root)}`, { env: { EVAL_CLAUDE_BIN: STUB } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /no cases matching nope/);
});

test('eval-run: --trials abc exits 2 with a clear message', async () => {
  const { root } = await fixtureRoot();
  const r = await sh(`node ${JSON.stringify(RUN)} --suite tasks --trials abc --root ${JSON.stringify(root)}`, { env: { EVAL_CLAUDE_BIN: STUB } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /positive integer/);
});

test('eval-run: --case with no value exits 2', async () => {
  const { root } = await fixtureRoot();
  const r = await sh(`node ${JSON.stringify(RUN)} --suite tasks --root ${JSON.stringify(root)} --case`, { env: { EVAL_CLAUDE_BIN: STUB } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /--case needs a value/);
});

test('eval-run: EVAL_TRIAL_MINUTES=0 exits 2 before touching a worktree', async () => {
  const { root } = await fixtureRoot();
  const r = await sh(`node ${JSON.stringify(RUN)} --suite tasks --case impl-ok --root ${JSON.stringify(root)}`,
    { env: { EVAL_CLAUDE_BIN: STUB, EVAL_REPOS_ROOT: join(root, 'repos'), EVAL_TRIAL_MINUTES: '0' } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /EVAL_TRIAL_MINUTES must be between 1 and 1440/);
  assert.ok(!existsSync(join(root, 'evals', 'work')), 'no worktree left behind');
});

test('eval-run: EVAL_TRIAL_MINUTES=Infinity exits 2 before touching a worktree', async () => {
  const { root } = await fixtureRoot();
  const r = await sh(`node ${JSON.stringify(RUN)} --suite tasks --case impl-ok --root ${JSON.stringify(root)}`,
    { env: { EVAL_CLAUDE_BIN: STUB, EVAL_REPOS_ROOT: join(root, 'repos'), EVAL_TRIAL_MINUTES: 'Infinity' } });
  assert.equal(r.code, 2);
  assert.match(r.stderr, /EVAL_TRIAL_MINUTES must be between 1 and 1440/);
  assert.ok(!existsSync(join(root, 'evals', 'work')), 'no worktree left behind');
});

test('eval-run: EVAL_TRIAL_MINUTES="" falls back to the default and the run completes', async () => {
  const { root } = await fixtureRoot();
  const r = await sh(`node ${JSON.stringify(RUN)} --suite tasks --root ${JSON.stringify(root)} --out ${JSON.stringify(join(root, 'results'))} --work ${JSON.stringify(join(root, 'work'))}`,
    { env: { EVAL_CLAUDE_BIN: STUB, EVAL_REPOS_ROOT: join(root, 'repos'), EVAL_TRIAL_MINUTES: '' }, timeoutMs: 60000 });
  assert.equal(r.code, 1, r.stdout + r.stderr);
});
