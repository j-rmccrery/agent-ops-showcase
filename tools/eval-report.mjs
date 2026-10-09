#!/usr/bin/env node
// eval-report — fold results/ into a markdown scoreboard. Usage: node tools/eval-report.mjs <results dir> [--baseline evals/baseline.json]
import { existsSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readJson, HERE } from './eval-lib.mjs';

export function loadResults(dir) {
  const summaryFile = join(dir, 'summary.json');
  const summary = existsSync(summaryFile) ? readJson(summaryFile) : null;
  const trials = {};
  for (const id of readdirSync(dir)) {
    const cdir = join(dir, id);
    if (!existsSync(join(cdir, '1', 'result.json'))) continue;
    trials[id] = readdirSync(cdir).filter((t) => existsSync(join(cdir, t, 'result.json'))).map((t) => readJson(join(cdir, t, 'result.json'))).sort((x, y) => x.trial - y.trial);
  }
  return { summary, trials };
}

const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
const sd = (xs) => { const m = mean(xs); return Math.sqrt(mean(xs.map((x) => (x - m) ** 2))); };
const f2 = (x) => x.toFixed(2);

export function buildScoreboard({ trials }, baseline = {}) {
  const caseIds = Object.keys(trials);
  const passed = caseIds.filter((id) => trials[id].every((t) => t.pass)).length;
  const lines = [`## Eval scoreboard — ${passed}/${caseIds.length} cases pass`, '', '| case | kind | result | judge pass rate | usd | time | model | vs baseline |', '|---|---|---|---|---|---|---|---|'];
  for (const [id, ts] of Object.entries(trials)) {
    const pass = ts.every((t) => t.pass);
    const rates = ts.filter((t) => t.judge).map((t) => t.judge.summary.pass_rate);
    const judge = rates.length ? `${f2(mean(rates))} ± ${f2(sd(rates))}` : '—';
    const usd = f2(ts.reduce((a, t) => a + (t.meta?.usd ?? 0), 0));
    const secs = Math.round(ts.reduce((a, t) => a + (t.meta?.duration_ms ?? 0), 0) / 1000);
    const models = [...new Set(ts.flatMap((t) => t.meta?.model_reported ?? []))].join(', ') || '?';
    const b = baseline[id];
    let delta = 'new';
    if (b) {
      if (rates.length && b.pass_rate != null && Math.abs(mean(rates) - b.pass_rate) > 1e-9) delta = `${mean(rates) > b.pass_rate ? '↑' : '↓'} from ${f2(b.pass_rate)}`;
      else if (b.pass !== pass) delta = pass ? '↑ from FAIL' : '↓ from PASS';
      else delta = 'same';
    }
    lines.push(`| ${id} | ${ts[0].kind} | ${pass ? 'PASS' : 'FAIL'} | ${judge} | ${usd} | ${secs}s | ${models} | ${delta} |`);
  }
  lines.push('', '### Gates', '');
  for (const [id, ts] of Object.entries(trials)) {
    for (const t of ts) {
      if (t.error) lines.push(`- ${id} t${t.trial}: ERROR ${t.error.split('\n')[0]}`);
      for (const g of t.gates) lines.push(`- ${id} t${t.trial} ${g.id} ${g.title}: ${g.met ? 'PASS' : 'FAIL'}${g.evidence ? ` — ${g.evidence.slice(0, 120)}` : ''}`);
    }
  }
  return lines.join('\n') + '\n';
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('eval-report.mjs')) {
  const args = process.argv.slice(2);
  const dir = resolve(args[0] || join(HERE, '..', 'results'));
  const bi = args.indexOf('--baseline');
  const bfile = bi !== -1 ? resolve(args[bi + 1]) : join(HERE, '..', 'evals', 'baseline.json');
  process.stdout.write(buildScoreboard(loadResults(dir), existsSync(bfile) ? readJson(bfile) : {}));
}
