import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sh } from '../eval-lib.mjs';
import { sealHidden, gradeProgrammatic, captureOutputs, gradeJudge } from '../eval-grade.mjs';

const STUB = `node ${JSON.stringify(join(import.meta.dirname, 'fixtures', 'claude-stub.mjs'))}`;
const scratch = (p) => mkdtempSync(join(tmpdir(), p));

test('sealHidden copies hidden trees into cwd after the fact', () => {
  const dir = scratch('case-');
  mkdirSync(join(dir, 'hidden', 'tests'), { recursive: true });
  writeFileSync(join(dir, 'hidden', 'tests', 'h.test.js'), 'x');
  const cwd = scratch('cwd-');
  sealHidden({ dir, hidden: ['hidden/'] }, cwd);
  assert.ok(existsSync(join(cwd, 'tests', 'h.test.js')));
});

test('gradeProgrammatic runs GATES.md through gate-check and reports per-gate', async () => {
  const dir = scratch('case-');
  writeFileSync(join(dir, 'GATES.md'), [
    '- [ ] G1: echo works', '  CHECK: node -e "console.log(42)"', '  EXPECT: /42/', '  EVIDENCE: pending',
    '- [ ] G2: fails on purpose', '  CHECK: node -e "process.exit(1)"', '  EVIDENCE: pending', '',
  ].join('\n'));
  const cwd = scratch('cwd-');
  const r = await gradeProgrammatic({ dir, hidden: [] }, cwd);
  assert.equal(r.allMet, false);
  assert.deepEqual(r.gates.map((g) => [g.id, g.met]), [['G1', true], ['G2', false]]);
  assert.match(r.gates[0].evidence, /42/);
});

test('captureOutputs writes diff.patch from a git worktree and copies review-output.md', async () => {
  const cwd = scratch('repo-');
  const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  await sh('git init -q', { cwd, env });
  writeFileSync(join(cwd, 'a.txt'), 'one\n');
  await sh('git add -A && git commit -qm one', { cwd, env });
  const base = (await sh('git rev-parse HEAD', { cwd })).stdout.trim();
  writeFileSync(join(cwd, 'a.txt'), 'two\n');
  writeFileSync(join(cwd, 'review-output.md'), 'NO BLOCKERS\n');
  writeFileSync(join(cwd, 'GATES.md'), '- [ ] G1: x\n');
  const trialDir = scratch('trial-');
  await captureOutputs({ base, kind: 'review' }, cwd, trialDir, 'result text');
  assert.match(readFileSync(join(trialDir, 'outputs', 'diff.patch'), 'utf8'), /\+two/);
  assert.equal(readFileSync(join(trialDir, 'outputs', 'review-output.md'), 'utf8'), 'NO BLOCKERS\n');
  assert.equal(readFileSync(join(trialDir, 'outputs', 'result.md'), 'utf8'), 'result text');
  const files = readFileSync(join(trialDir, 'outputs', 'diff-files.txt'), 'utf8');
  assert.doesNotMatch(files, /GATES\.md/);
  assert.ok(existsSync(join(trialDir, 'gates.md')));
});

test('captureOutputs excludes hidden test files sealed into cwd from the diff', async () => {
  const cwd = scratch('repo-');
  const env = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  await sh('git init -q', { cwd, env });
  writeFileSync(join(cwd, 'a.txt'), 'one\n');
  await sh('git add -A && git commit -qm one', { cwd, env });
  const base = (await sh('git rev-parse HEAD', { cwd })).stdout.trim();
  writeFileSync(join(cwd, 'a.txt'), 'two\n');

  const dir = scratch('case-');
  mkdirSync(join(dir, 'hidden', 'tests'), { recursive: true });
  writeFileSync(join(dir, 'hidden', 'tests', 'h.test.js'), 'x');
  sealHidden({ dir, hidden: ['hidden/'] }, cwd); // lands cwd/tests/h.test.js, untracked, agent never touched it

  const trialDir = scratch('trial-');
  await captureOutputs({ dir, hidden: ['hidden/'], base, kind: 'implement' }, cwd, trialDir, 'result text');

  const files = readFileSync(join(trialDir, 'outputs', 'diff-files.txt'), 'utf8');
  assert.match(files, /a\.txt/);
  assert.doesNotMatch(files, /h\.test\.js/);
  assert.doesNotMatch(readFileSync(join(trialDir, 'outputs', 'diff.patch'), 'utf8'), /h\.test\.js/);
});

test('gradeJudge builds the grader prompt and parses grading.json', async () => {
  const prevBin = process.env.EVAL_CLAUDE_BIN;
  process.env.EVAL_CLAUDE_BIN = STUB;
  try {
    const trialDir = scratch('trial-');
    mkdirSync(join(trialDir, 'outputs'));
    writeFileSync(join(trialDir, 'transcript.json'), '{}');
    writeFileSync(join(trialDir, 'grading.json'), JSON.stringify({ summary: { pass_rate: 0 } })); // stale, from a reused trialDir
    const g = await gradeJudge({ id: 'j', judge: ['routes to the owner', 'asks before writing'] }, trialDir, { budgetUsd: 1, timeoutMs: 10000 });
    assert.equal(g.summary.pass_rate, 1);
    assert.equal(g.expectations.length, 2);
    assert.ok(existsSync(join(trialDir, 'grading.json')));
    const stubArgs = readFileSync(join(trialDir, 'stub-args.txt'), 'utf8');
    assert.match(stubArgs, /--setting-sources project/);
    assert.match(stubArgs, /--strict-mcp-config/);
    assert.match(stubArgs, /--disallowed-tools/);
    assert.match(stubArgs, /Bash\(gh \*\)/);
  } finally {
    if (prevBin === undefined) delete process.env.EVAL_CLAUDE_BIN;
    else process.env.EVAL_CLAUDE_BIN = prevBin;
  }
});

test('gradeJudge removes a stale grading.json before invoking the judge, so a judge that never writes one is a hard failure', async () => {
  const prevBin = process.env.EVAL_CLAUDE_BIN;
  process.env.EVAL_CLAUDE_BIN = 'node -e ""'; // exits 0 immediately, writes nothing
  try {
    const trialDir = scratch('trial-');
    mkdirSync(join(trialDir, 'outputs'));
    writeFileSync(join(trialDir, 'transcript.json'), '{}');
    writeFileSync(join(trialDir, 'grading.json'), JSON.stringify({ summary: { pass_rate: 0 } })); // stale, from a reused trialDir
    await assert.rejects(
      gradeJudge({ id: 'j', judge: ['routes to the owner'] }, trialDir, { budgetUsd: 1, timeoutMs: 10000 }),
      /produced no grading\.json/,
    );
    assert.ok(!existsSync(join(trialDir, 'grading.json')), 'stale grading.json was removed, not left behind as a false pass');
  } finally {
    if (prevBin === undefined) delete process.env.EVAL_CLAUDE_BIN;
    else process.env.EVAL_CLAUDE_BIN = prevBin;
  }
});
