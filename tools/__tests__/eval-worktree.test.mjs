import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readdirSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { sh } from '../eval-lib.mjs';
import { prepareWorktree, cleanupWorktree } from '../eval-worktree.mjs';

async function makeRepo() {
  const repo = mkdtempSync(join(tmpdir(), 'evalrepo-'));
  const g = (c) => sh(`git ${c}`, { cwd: repo, env: { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });
  await g('init -q');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  await g('add a.txt'); await g('commit -qm one');
  const base = (await g('rev-parse HEAD')).stdout.trim();
  writeFileSync(join(repo, 'a.txt'), 'two\n');
  await g('commit -qam two');
  mkdirSync(join(repo, 'node_modules', 'pkg'), { recursive: true });
  writeFileSync(join(repo, 'node_modules', 'pkg', 'index.js'), '');
  return { repo, base };
}

test('prepare checks out base, links node_modules, applies seed; cleanup keeps main node_modules', async () => {
  const { repo, base } = await makeRepo();
  const workRoot = mkdtempSync(join(tmpdir(), 'evalwork-'));
  const caseDir = mkdtempSync(join(tmpdir(), 'evalcase-'));
  writeFileSync(join(caseDir, 'seed.patch'), [
    'diff --git a/a.txt b/a.txt', '--- a/a.txt', '+++ b/a.txt', '@@ -1 +1 @@', '-one', '+seeded', '',
  ].join('\n'));
  const c = { id: 'wt-test', kind: 'review', dir: caseDir, base, seed_patch: 'seed.patch' };

  const wt = await prepareWorktree(c, { repoPath: repo, workRoot, trial: 1 });
  assert.ok(existsSync(join(wt.path, 'a.txt')));
  assert.equal((await sh('git log --oneline', { cwd: wt.path })).stdout.split('\n').filter(Boolean).length, 2, 'base + seed commit');
  assert.ok(lstatSync(join(wt.path, 'node_modules')).isSymbolicLink(), 'node_modules is a link, not a copy');
  assert.ok(existsSync(join(wt.path, 'node_modules', 'pkg', 'index.js')));

  await cleanupWorktree(wt);
  assert.ok(!existsSync(wt.path), 'worktree removed');
  assert.deepEqual(readdirSync(join(repo, 'node_modules')), ['pkg'], 'main clone node_modules intact');
});

test('failed seed patch leaves no worktree and does not touch main node_modules', async () => {
  const { repo, base } = await makeRepo();
  const workRoot = mkdtempSync(join(tmpdir(), 'evalwork-'));
  const caseDir = mkdtempSync(join(tmpdir(), 'evalcase-'));
  // Context this patch doesn't match (base has "one", not "nope") — git apply fails.
  writeFileSync(join(caseDir, 'seed.patch'), [
    'diff --git a/a.txt b/a.txt', '--- a/a.txt', '+++ b/a.txt', '@@ -1 +1 @@', '-nope', '+seeded', '',
  ].join('\n'));
  const c = { id: 'wt-badseed', kind: 'review', dir: caseDir, base, seed_patch: 'seed.patch' };
  const expectedPath = join(workRoot, 'wt-badseed-t1');

  await assert.rejects(
    prepareWorktree(c, { repoPath: repo, workRoot, trial: 1 }),
    /seed patch failed/,
  );
  assert.ok(!existsSync(expectedPath), 'worktree not left behind');
  assert.deepEqual(readdirSync(join(repo, 'node_modules')), ['pkg'], 'main clone node_modules intact');
});

test('prepare fails clearly on unknown base', async () => {
  const { repo } = await makeRepo();
  const workRoot = mkdtempSync(join(tmpdir(), 'evalwork-'));
  await assert.rejects(
    prepareWorktree({ id: 'bad', kind: 'implement', dir: workRoot, base: 'deadbeef', seed_patch: null }, { repoPath: repo, workRoot, trial: 1 }),
    /base deadbeef not found/,
  );
});
