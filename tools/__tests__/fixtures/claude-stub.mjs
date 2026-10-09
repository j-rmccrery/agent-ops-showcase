#!/usr/bin/env node
// Stands in for `claude -p`. Reads the prompt from stdin, writes a marker file so tests can see what
// the executor would have done, and prints the JSON envelope claude -p prints. Never calls an API.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
const prompt = readFileSync(0, 'utf8');
const args = process.argv.slice(2);
const model = args[args.indexOf('--model') + 1] || 'unknown';
const cwd = process.cwd();
writeFileSync(join(cwd, 'stub-args.txt'), args.join(' '));
// Behave like a tiny agent: if the prompt mentions review-output.md, write one; else touch a file.
if (/review-output\.md/.test(prompt)) writeFileSync(join(cwd, 'review-output.md'), 'BLOCKER src/x.ts stub finding\n');
else if (existsSync(join(cwd, 'a.txt'))) writeFileSync(join(cwd, 'a.txt'), 'agent-edited\n');
const skillSeen = existsSync(join(cwd, '.claude', 'skills'));
// Judge mode: the grader prompt names a grading.json path; write a passing grade for every expectation.
// Scope the bullet match to the "expectations:" block only -- the vendored grader prompt text
// above it is full of unrelated "- " bullets (instructions, field docs) that would otherwise count.
const gm = prompt.match(/Write grading\.json to (.+)\n/);
if (gm) {
  const block = prompt.match(/^expectations:\n([\s\S]*?)\n\n/m);
  const exps = block ? [...block[1].matchAll(/^- (.+)$/gm)].map((m) => m[1]) : [];
  writeFileSync(gm[1].trim(), JSON.stringify({
    expectations: exps.map((text) => ({ text, passed: true, evidence: 'stub' })),
    summary: { passed: exps.length, failed: 0, total: exps.length, pass_rate: 1 },
  }));
}
process.stdout.write(JSON.stringify({
  type: 'result', subtype: 'success', is_error: false, stop_reason: 'end_turn', num_turns: 2, duration_ms: 12,
  total_cost_usd: 0.01, result: `stub done (skill dir present: ${skillSeen}; prompt bytes: ${prompt.length})`,
  modelUsage: { [`stub-${model}`]: { costUSD: 0.01 } },
}));
