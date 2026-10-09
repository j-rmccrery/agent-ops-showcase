import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadRows, buildCaseIndex, sampleRows, renderBundle, verifyBundle } from '../eval-agreement.mjs';

const scratch = (p) => mkdtempSync(join(tmpdir(), p));

/** Build a tiny fake results + skills tree: 2 cases x 3 expectations each. */
function buildFixture() {
  const root = scratch('agree-root-');
  const skillDir = join(root, 'skills', 'demo-skill', 'evals');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, 'evals.json'), JSON.stringify({
    skill_name: 'demo-skill',
    evals: [
      { id: 0, eval_name: 'case-a', prompt: 'Prompt A with a `code` span.', assertions: ['a1', 'a2'] },
      { id: 1, eval_name: 'case-b', prompt: 'Prompt B, plain text.', assertions: ['b1'] },
    ],
  }));

  const results = scratch('agree-results-');
  const writeTrial = (caseId, expectations, resultMd) => {
    const trialDir = join(results, caseId, '1');
    mkdirSync(join(trialDir, 'outputs'), { recursive: true });
    writeFileSync(join(trialDir, 'grading.json'), JSON.stringify({ expectations }));
    writeFileSync(join(trialDir, 'outputs', 'result.md'), resultMd);
  };
  // case-a: withskill (2 expectations, 1 pass 1 fail), noskill (2 expectations, 2 fail)
  writeTrial('skill-demo-skill-0-case-a-withskill', [
    { text: 'a1', passed: true, evidence: 'evidence a1 withskill' },
    { text: 'a2', passed: false, evidence: 'evidence a2 withskill' },
  ], 'Output A withskill, with a ```fenced``` block inside.');
  writeTrial('skill-demo-skill-0-case-a-noskill', [
    { text: 'a1', passed: false, evidence: 'evidence a1 noskill' },
    { text: 'a2', passed: false, evidence: 'evidence a2 noskill' },
  ], 'Output A noskill.');
  // case-b: withskill (1 pass), noskill (1 pass) — gives us 3 PASS / 3 FAIL total pool
  writeTrial('skill-demo-skill-1-case-b-withskill', [
    { text: 'b1', passed: true, evidence: 'evidence b1 withskill' },
  ], 'Output B withskill.');
  writeTrial('skill-demo-skill-1-case-b-noskill', [
    { text: 'b1', passed: true, evidence: 'evidence b1 noskill' },
  ], 'Output B noskill.');

  return { root, results };
}

test('loadRows reads every expectation across all matching case dirs', () => {
  const { results } = buildFixture();
  const rows = loadRows(results, 'skill-');
  assert.equal(rows.length, 6);
  assert.equal(rows.filter((r) => r.passed).length, 3);
  assert.equal(rows.filter((r) => !r.passed).length, 3);
});

test('buildCaseIndex resolves scenario prompts by reusing eval-cases.mjs loadSkillCases', () => {
  const { root } = buildFixture();
  const idx = buildCaseIndex(root);
  assert.equal(idx.get('skill-demo-skill-0-case-a-withskill').prompt, 'Prompt A with a `code` span.');
  assert.equal(idx.get('skill-demo-skill-1-case-b-noskill').skill, null);
  assert.equal(idx.get('skill-demo-skill-1-case-b-withskill').skill, 'demo-skill');
});

test('sampleRows balances PASS/FAIL and caps at what the pool has', () => {
  const { results } = buildFixture();
  const rows = loadRows(results, 'skill-');
  const { rows: picked, gotPass, gotFail } = sampleRows(rows, { n: 4, seed: 1 });
  assert.equal(gotPass, 2);
  assert.equal(gotFail, 2);
  assert.equal(picked.length, 4);
  // asked for more than the pool has (only 3 PASS / 3 FAIL exist) -> capped, not padded
  const wide = sampleRows(rows, { n: 20, seed: 1 });
  assert.equal(wide.gotFail, 3);
  assert.equal(wide.gotPass, 3);
  assert.equal(wide.rows.length, 6);
});

test('sampleRows is deterministic under a fixed seed, varies with a different seed', () => {
  const { results } = buildFixture();
  const rows = loadRows(results, 'skill-');
  const a = sampleRows(rows, { n: 4, seed: 1 }).rows.map((r) => r.evidence);
  const b = sampleRows(rows, { n: 4, seed: 1 }).rows.map((r) => r.evidence);
  assert.deepEqual(a, b);
  const c = sampleRows(rows, { n: 4, seed: 2 }).rows.map((r) => r.evidence);
  assert.notDeepEqual(a, c);
});

test('renderBundle produces cards carrying scenario, full output, assertion, full evidence verbatim', () => {
  const { root, results } = buildFixture();
  const idx = buildCaseIndex(root);
  const rows = loadRows(results, 'skill-');
  const { rows: picked, gotPass, gotFail, wantedHalf } = sampleRows(rows, { n: 6, seed: 1 });
  const md = renderBundle(picked, idx, { resultsDir: results, suite: 'skill-', n: 6, seed: 1, wantedHalf, gotPass, gotFail });
  const cards = md.split(/^## Row /m).slice(1);
  assert.equal(cards.length, 6);
  for (const c of cards) {
    assert.match(c, /\*\*Scenario\*\* \(skill (?:not installed|installed)\):/);
    assert.match(c, /\*\*Agent output\*\* \(`outputs\/result\.md`, full\):/);
    assert.match(c, /\*\*Assertion:\*\*/);
    assert.match(c, /\*\*Judge verdict:\*\* (?:PASS|FAIL)/);
    assert.match(c, /\*\*Judge evidence:\*\*/);
    assert.match(c, /\*\*Human:\*\* _____/);
  }
  // a full evidence string appears untruncated, not the first-200-chars kind of thing
  assert.match(md, /evidence a1 withskill/);
  // the fenced block for the output containing ``` uses a longer fence so it isn't cut early
  assert.match(md, /````\nOutput A withskill, with a ```fenced``` block inside\.\n````/);
});

test('verifyBundle passes on a freshly rendered bundle and fails when the file is hand-edited', () => {
  const { root, results } = buildFixture();
  const idx = buildCaseIndex(root);
  const rows = loadRows(results, 'skill-');
  const { rows: picked, gotPass, gotFail, wantedHalf } = sampleRows(rows, { n: 6, seed: 1 });
  const md = renderBundle(picked, idx, { resultsDir: results, suite: 'skill-', n: 6, seed: 1, wantedHalf, gotPass, gotFail });

  const clean = verifyBundle(md, rows, idx);
  assert.equal(clean.problems.length, 0);
  assert.equal(clean.count, 6);

  // a CRLF checkout (core.autocrlf) must verify the same as LF
  const crlf = verifyBundle(md.replace(/\n/g, '\r\n'), rows, idx);
  assert.equal(crlf.problems.length, 0);
  assert.equal(crlf.count, 6);

  const tampered = md.replace('evidence a1 withskill', 'evidence a1 withskill, but shortened');
  const dirty = verifyBundle(tampered, rows, idx);
  assert.ok(dirty.problems.length > 0);
  assert.match(dirty.problems[0], /evidence differs/);
});
