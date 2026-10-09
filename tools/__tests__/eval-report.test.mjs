import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildScoreboard } from '../eval-report.mjs';

const results = {
  trials: {
    'impl-ok': [{ trial: 1, kind: 'implement', pass: true, gates: [{ id: 'G1', title: 'hidden', met: true, evidence: '1 passed' }], judge: null, meta: { usd: 0.4, duration_ms: 60000, model_reported: ['claude-sonnet-5'] }, error: null }],
    'skill-x-withskill': [
      { trial: 1, kind: 'skill', pass: true, gates: [], judge: { summary: { pass_rate: 1 } }, meta: { usd: 0.1, duration_ms: 1000, model_reported: ['claude-sonnet-5'] }, error: null },
      { trial: 2, kind: 'skill', pass: false, gates: [], judge: { summary: { pass_rate: 0.5 } }, meta: { usd: 0.1, duration_ms: 1000, model_reported: ['claude-sonnet-5'] }, error: null },
    ],
    'prep-fail-case': [{ trial: 1, kind: 'implement', pass: false, gates: [], judge: null, meta: null, error: 'prepare failed' }],
    'flip-steady-rate': [{ trial: 1, kind: 'skill', pass: false, gates: [], judge: { summary: { pass_rate: 1 } }, meta: { usd: 0.1, duration_ms: 1000, model_reported: ['claude-sonnet-5'] }, error: null }],
  },
};

test('scoreboard has per-case rows, judge mean±sd, delta vs baseline', () => {
  const md = buildScoreboard(results, { 'impl-ok': { pass: false, pass_rate: null }, 'skill-x-withskill': { pass: true, pass_rate: 1 } });
  assert.match(md, /\| impl-ok \| implement \| PASS \|/);
  assert.match(md, /G1 hidden: PASS/);
  assert.match(md, /0\.75 ± 0\.25/);
  assert.match(md, /impl-ok.*↑ from FAIL/);
  assert.match(md, /skill-x-withskill.*↓ from 1\.00/);
  assert.match(md, /claude-sonnet-5/);
});

test('scoreboard tolerates missing baseline', () => {
  const md = buildScoreboard(results, {});
  assert.match(md, /new/);
});

test('trial with null meta (prepare/launch threw) renders FAIL, ? model, and ERROR gate line', () => {
  const md = buildScoreboard(results, {});
  assert.match(md, /\| prep-fail-case \| implement \| FAIL \|/);
  assert.match(md, /\| prep-fail-case \|.*\| \? \| new \|/);
  assert.match(md, /- prep-fail-case t1: ERROR prepare failed/);
});

test('pass flips PASS->FAIL with an unchanged judge rate still reports the boolean flip, not "same"', () => {
  const md = buildScoreboard(results, { 'flip-steady-rate': { pass: true, pass_rate: 1 } });
  assert.match(md, /flip-steady-rate.*↓ from PASS/);
});

test('header count is derived from trials on disk (a case passes when every trial passes), not from a summary.json field', () => {
  const twoCases = {
    trials: {
      'ok-case': [{ trial: 1, kind: 'implement', pass: true, gates: [], judge: null, meta: { usd: 0, duration_ms: 0, model_reported: [] }, error: null }],
      'bad-case': [{ trial: 1, kind: 'implement', pass: false, gates: [], judge: null, meta: { usd: 0, duration_ms: 0, model_reported: [] }, error: null }],
    },
  };
  const md = buildScoreboard(twoCases, {});
  assert.match(md, /## Eval scoreboard — 1\/2 cases pass/);
});
