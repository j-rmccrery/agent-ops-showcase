import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadCase, loadTaskCases, loadSkillCases, resolveRepo } from '../eval-cases.mjs';

function scratch() { return mkdtempSync(join(tmpdir(), 'evalcases-')); }

test('loadCase fills defaults and validates', () => {
  const d = scratch();
  writeFileSync(join(d, 'case.json'), JSON.stringify({ id: 'x', kind: 'implement', repo: 'your-org/app', base: 'abc', prompt_file: 'ticket.md' }));
  const c = loadCase(d);
  assert.equal(c.model, 'sonnet');
  assert.deepEqual(c.hidden, []);
  assert.deepEqual(c.judge, []);
  assert.equal(c.dir, d);
});

test('loadCase rejects bad kind and missing fields', () => {
  const d = scratch();
  writeFileSync(join(d, 'case.json'), JSON.stringify({ id: 'x', kind: 'nope', repo: 'r', base: 'b' }));
  assert.throws(() => loadCase(d), /kind/);
  writeFileSync(join(d, 'case.json'), JSON.stringify({ id: 'x', kind: 'review', repo: 'r', base: 'b' }));
  assert.throws(() => loadCase(d), /seed_patch/);
});

test('loadTaskCases lists evals/tasks/* and filters by id', () => {
  const root = scratch();
  for (const id of ['a', 'b']) {
    mkdirSync(join(root, 'evals', 'tasks', id), { recursive: true });
    writeFileSync(join(root, 'evals', 'tasks', id, 'case.json'), JSON.stringify({ id, kind: 'implement', repo: 'r', base: 'b', prompt_file: 't.md' }));
  }
  assert.deepEqual(loadTaskCases(root, {}).map(c => c.id), ['a', 'b']);
  assert.deepEqual(loadTaskCases(root, { caseId: 'b' }).map(c => c.id), ['b']);
});

test('loadSkillCases expands evals.json into with/without pairs', () => {
  const root = scratch();
  mkdirSync(join(root, 'skills', 'x', 'evals'), { recursive: true });
  writeFileSync(join(root, 'skills', 'x', 'evals', 'evals.json'), JSON.stringify({
    skill_name: 'x',
    evals: [{ id: 1, eval_name: 'clean', prompt: 'do the thing', assertions: ['routes to the owner'] }],
  }));
  const cases = loadSkillCases(root, {});
  assert.equal(cases.length, 2);
  assert.deepEqual(cases.map(c => c.id).sort(), ['skill-x-1-clean-noskill', 'skill-x-1-clean-withskill']);
  const w = cases.find(c => c.withSkill);
  assert.equal(w.kind, 'skill');
  assert.equal(w.skill, 'x');
  assert.equal(w.prompt, 'do the thing');
  assert.deepEqual(w.judge, ['routes to the owner']);
  assert.equal(cases.find(c => !c.withSkill).skill, null);
});

test('resolveRepo prefers EVAL_REPOS_ROOT', () => {
  const root = scratch();
  mkdirSync(join(root, 'evals'), { recursive: true });
  writeFileSync(join(root, 'evals', 'repos.json'), JSON.stringify({ 'your-org/app': 'C:/x/app' }));
  const prev = process.env.EVAL_REPOS_ROOT;
  delete process.env.EVAL_REPOS_ROOT;
  try {
    assert.equal(resolveRepo('your-org/app', root), 'C:/x/app');
    process.env.EVAL_REPOS_ROOT = '/ci/repos';
    assert.equal(resolveRepo('your-org/app', root), join('/ci/repos', 'app'));
  } finally {
    if (prev === undefined) delete process.env.EVAL_REPOS_ROOT;
    else process.env.EVAL_REPOS_ROOT = prev;
  }
});

test('loadSkillCases rejects an eval entry missing prompt', () => {
  const root = scratch();
  mkdirSync(join(root, 'skills', 'x', 'evals'), { recursive: true });
  writeFileSync(join(root, 'skills', 'x', 'evals', 'evals.json'), JSON.stringify({
    skill_name: 'x',
    evals: [{ id: 1, eval_name: 'clean', assertions: ['routes to the owner'] }],
  }));
  assert.throws(() => loadSkillCases(root, {}), /prompt/);
});
