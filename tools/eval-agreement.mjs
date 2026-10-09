#!/usr/bin/env node
// eval-agreement — build a human-reviewable judge-agreement bundle.
// Each row is one judge expectation, with the full scenario, the agent's full
// output, and the judge's untruncated evidence, so a human can actually label it.
// Usage: node tools/eval-agreement.mjs --results <dir> --out <file> --n <int> --seed <int> --suite <prefix> [--verify]
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readJson, HERE } from './eval-lib.mjs';
import { loadSkillCases } from './eval-cases.mjs';

const ROOT = join(HERE, '..');

// mulberry32 — tiny deterministic PRNG for sample order. No dependency.
function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle(arr, rand) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/** Every judge expectation from <results>/<caseId starting with suite>/<trial>/grading.json. */
export function loadRows(resultsDir, suite) {
  const rows = [];
  const caseDirs = readdirSync(resultsDir)
    .filter((d) => d.startsWith(suite) && statSync(join(resultsDir, d)).isDirectory())
    .sort();
  for (const caseId of caseDirs) {
    const caseDir = join(resultsDir, caseId);
    const trials = readdirSync(caseDir).filter((t) => existsSync(join(caseDir, t, 'grading.json'))).sort();
    for (const trial of trials) {
      const trialDir = join(caseDir, trial);
      const grading = readJson(join(trialDir, 'grading.json'));
      const outFile = join(trialDir, 'outputs', 'result.md');
      const resultMd = existsSync(outFile) ? readFileSync(outFile, 'utf8') : '';
      (grading.expectations || []).forEach((exp, idx) => {
        rows.push({ caseId, trial, idx, text: exp.text, passed: !!exp.passed, evidence: exp.evidence ?? '', resultMd });
      });
    }
  }
  return rows;
}

/** caseId -> case (from each skill's evals/evals.json), reusing eval-cases.mjs's loader. */
export function buildCaseIndex(root = ROOT) {
  return new Map(loadSkillCases(root).map((c) => [c.id, c]));
}

function roundRobin(pool, count, seed) {
  const rand = mulberry32(seed);
  const byCase = new Map();
  for (const r of pool) {
    if (!byCase.has(r.caseId)) byCase.set(r.caseId, []);
    byCase.get(r.caseId).push(r);
  }
  const caseOrder = shuffle([...byCase.keys()].sort(), rand);
  const picked = [];
  let progressed = true;
  while (picked.length < count && progressed) {
    progressed = false;
    for (const caseId of caseOrder) {
      const q = byCase.get(caseId);
      if (q.length) {
        picked.push(q.shift());
        progressed = true;
        if (picked.length === count) break;
      }
    }
  }
  return picked;
}

/** Balanced PASS/FAIL sample (n/2 each, fewer if the pool is smaller), round-robin across
 * cases, deterministic under seed. Rows interleave PASS/FAIL for readability. */
export function sampleRows(rows, { n = 20, seed = 1 } = {}) {
  const half = Math.floor(n / 2);
  const passPicked = roundRobin(rows.filter((r) => r.passed), half, seed);
  const failPicked = roundRobin(rows.filter((r) => !r.passed), half, seed + 1);
  const picked = [];
  for (let i = 0; i < Math.max(passPicked.length, failPicked.length); i++) {
    if (passPicked[i]) picked.push(passPicked[i]);
    if (failPicked[i]) picked.push(failPicked[i]);
  }
  return { rows: picked, wantedHalf: half, gotPass: passPicked.length, gotFail: failPicked.length };
}

/** Fence longer than any backtick run already inside the content, so it can't be spoofed. */
function fence(text) {
  const runs = text.match(/`+/g) || [];
  const max = runs.reduce((m, r) => Math.max(m, r.length), 0);
  return '`'.repeat(Math.max(3, max + 1));
}

function renderCard(row, k, caseInfo) {
  const installed = caseInfo?.skill ? 'installed' : 'not installed';
  const prompt = caseInfo?.prompt ?? '(scenario not found — case id did not resolve against skills/*/evals/evals.json)';
  const pf = fence(prompt);
  const of = fence(row.resultMd);
  return [
    `## Row ${k} — ${row.caseId}`,
    '',
    `**Scenario** (skill ${installed}):`,
    pf,
    prompt,
    pf,
    '',
    '**Agent output** (`outputs/result.md`, full):',
    of,
    row.resultMd,
    of,
    '',
    `**Assertion:** ${row.text}`,
    `**Judge verdict:** ${row.passed ? 'PASS' : 'FAIL'}`,
    `**Judge evidence:** ${row.evidence}`,
    '**Human:** _____',
  ].join('\n');
}

export function renderBundle(rows, caseIndex, { resultsDir, suite, n, seed, wantedHalf, gotPass, gotFail }) {
  const date = new Date().toISOString().slice(0, 10);
  const shortfall = gotPass < wantedHalf || gotFail < wantedHalf
    ? ` — pool only had ${gotPass} PASS / ${gotFail} FAIL available for prefix \`${suite}\`, sampled all of it`
    : '';
  const header = [
    '# Judge agreement sample',
    '',
    `Generated \`node tools/eval-agreement.mjs --results ${resultsDir} --out <file> --n ${n} --seed ${seed} --suite ${suite}\` on ${date}.`,
    '',
    `Source: \`${resultsDir}\` (case prefix \`${suite}\`). Rows: ${rows.length} (${gotPass} PASS / ${gotFail} FAIL)${shortfall}.`,
    '',
    'Fill in **Human:** PASS or FAIL per row; agreement % = matches / rows; below 80% = rewrite assertions.',
  ].join('\n');
  const cards = rows.map((r, i) => renderCard(r, i + 1, caseIndex.get(r.caseId))).join('\n\n');
  return `${header}\n\n${cards}\n`;
}

const CARD_RE = /^## Row \d+ — (?<caseId>\S+)\n\n\*\*Scenario\*\* \(skill (?:installed|not installed)\):\n(?<pfence>`+)\n(?<scenario>[\s\S]*?)\n\k<pfence>\n\n\*\*Agent output\*\* \(`outputs\/result\.md`, full\):\n(?<ofence>`+)\n(?<output>[\s\S]*?)\n\k<ofence>\n\n\*\*Assertion:\*\* (?<assertion>[\s\S]*?)\n\*\*Judge verdict:\*\* (?<verdict>PASS|FAIL)\n\*\*Judge evidence:\*\* (?<evidence>[\s\S]*?)\n\*\*Human:\*\*/gm;

/** Re-parse a rendered bundle and check every card's text against the source rows/cases
 * verbatim — proves the bundle never truncated anything. Returns { count, problems }. */
export function verifyBundle(text, rows, caseIndex) {
  const lf = (v) => String(v).replace(/\r\n/g, '\n'); // tolerate CRLF checkouts (core.autocrlf)
  text = lf(text);
  const bySig = new Map(rows.map((r) => [`${r.caseId}\0${r.text}`, r]));
  const problems = [];
  let count = 0;
  for (const m of text.matchAll(CARD_RE)) {
    count++;
    const { caseId, scenario, output, assertion, verdict, evidence } = m.groups;
    const src = bySig.get(`${caseId}\0${assertion}`);
    if (!src) { problems.push(`row ${count} (${caseId}): no source expectation matches this assertion text`); continue; }
    const wantPrompt = caseIndex.get(caseId)?.prompt ?? '(scenario not found — case id did not resolve against skills/*/evals/evals.json)';
    if (scenario !== lf(wantPrompt)) problems.push(`row ${count} (${caseId}): scenario text differs from skills/*/evals/evals.json`);
    if (output !== lf(src.resultMd)) problems.push(`row ${count} (${caseId}): agent output differs from outputs/result.md`);
    if (evidence !== lf(src.evidence)) problems.push(`row ${count} (${caseId}): judge evidence differs from grading.json`);
    if ((verdict === 'PASS') !== src.passed) problems.push(`row ${count} (${caseId}): judge verdict differs from grading.json`);
  }
  return { count, problems };
}

function parseArgs(argv) {
  const a = { results: 'results', out: null, n: 20, seed: 1, suite: 'skill-', verify: false };
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--results') a.results = argv[++i];
    else if (t === '--out') a.out = argv[++i];
    else if (t === '--n') a.n = parseInt(argv[++i], 10);
    else if (t === '--seed') a.seed = parseInt(argv[++i], 10);
    else if (t === '--suite') a.suite = argv[++i];
    else if (t === '--verify') a.verify = true;
  }
  return a;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const resultsDir = resolve(args.results);
  const month = new Date().toISOString().slice(0, 7);
  const outFile = resolve(args.out || join(ROOT, 'evals', `judge-agreement-${month}.md`));
  const caseIndex = buildCaseIndex();
  const rows = loadRows(resultsDir, args.suite);

  if (args.verify) {
    if (!existsSync(outFile)) { console.error(`--verify: ${outFile} does not exist`); process.exit(1); }
    const text = readFileSync(outFile, 'utf8');
    const { count, problems } = verifyBundle(text, rows, caseIndex);
    if (count === 0) { console.error(`--verify: no cards found in ${outFile}`); process.exit(1); }
    if (problems.length) { console.error(`--verify: ${problems.length} mismatch(es) in ${count} cards:\n${problems.join('\n')}`); process.exit(1); }
    console.log(`--verify: OK, ${count} cards match source verbatim.`);
    return;
  }

  const { rows: picked, wantedHalf, gotPass, gotFail } = sampleRows(rows, { n: args.n, seed: args.seed });
  const bundle = renderBundle(picked, caseIndex, { resultsDir: args.results, suite: args.suite, n: args.n, seed: args.seed, wantedHalf, gotPass, gotFail });
  writeFileSync(outFile, bundle);
  console.log(`wrote ${outFile}: ${picked.length} rows (${gotPass} PASS / ${gotFail} FAIL)`);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith('eval-agreement.mjs')) {
  main();
}
