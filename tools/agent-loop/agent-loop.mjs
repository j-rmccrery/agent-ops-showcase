#!/usr/bin/env node
/**
 * agent-loop — unattended dispatch harness for an autonomous ticket loop.
 *
 * Implements the unattended-loop section of the agent contract. The runner is deliberately dumb: it owns
 * process lifecycle, budgets, worktrees, ordering and stop conditions. All
 * judgment (which ticket, how to build it, whether an AC is met) lives in the
 * `claude -p` iterations, which reach Linear/GitHub through the operator's
 * existing MCP auth. No credentials live here.
 *
 * Usage:
 *   node agent-loop.mjs                     # full run, honours loop.config.json
 *   node agent-loop.mjs --dry-run           # preflight + plan, spawn nothing
 *   node agent-loop.mjs --max 2             # override maxTicketsPerRun
 *   node agent-loop.mjs --preflight-only    # just check the substrate
 *   node agent-loop.mjs --repo app     # restrict to one repo
 *
 * Exit codes: 0 clean, 1 preflight failed, 2 stopped on a stop-condition
 * with work incomplete, 3 internal error.
 */

import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, appendFileSync, existsSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const IS_WIN = process.platform === 'win32';

/* ------------------------------------------------------------------ args */

function parseArgs(argv) {
  const a = { dryRun: false, preflightOnly: false, max: null, repo: null, config: join(HERE, 'loop.config.json') };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i];
    if (v === '--dry-run') a.dryRun = true;
    else if (v === '--preflight-only') a.preflightOnly = true;
    else if (v === '--max') a.max = Number(argv[++i]);
    else if (v === '--repo') a.repo = argv[++i];
    else if (v === '--config') a.config = resolve(argv[++i]);
    else if (v === '--help' || v === '-h') { console.log(HELP); process.exit(0); }
    else { fail(`unknown argument: ${v}`); }
  }
  return a;
}

const HELP = `agent-loop — unattended dispatch harness (agent contract)

  --dry-run          preflight + plan only; spawn no workers, open no PRs
  --preflight-only   check substrate readiness and exit
  --max N            cap tickets this run (overrides budgets.maxTicketsPerRun)
  --repo NAME        restrict to a single configured repo
  --config PATH      alternate config file
`;

function fail(msg) { console.error(`agent-loop: ${msg}`); process.exit(3); }

/* --------------------------------------------------------------- logging */

let RUN = null;

function startRun(cfg) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const dir = join(cfg.output.runsDir, stamp);
  mkdirSync(dir, { recursive: true });
  RUN = {
    id: stamp, dir, startedAt: Date.now(),
    log: join(dir, 'run.jsonl'),
    usd: 0, tickets: [], stopReason: null, supervisorVerdicts: [],
  };
  return RUN;
}

function log(event, data = {}) {
  const rec = { t: new Date().toISOString(), event, ...data };
  const line = JSON.stringify(rec);
  if (RUN) appendFileSync(RUN.log, line + '\n');
  const tag = event.padEnd(22);
  console.log(`[${rec.t.slice(11, 19)}] ${tag} ${data.msg ?? data.ticket ?? ''}`);
}

/* ----------------------------------------------------------------- shell */

/**
 * Run a command, capturing output. Resolves { code, stdout, stderr, timedOut }.
 * Never throws on non-zero exit — callers decide what a failure means.
 */
function sh(cmd, { cwd, timeoutMs, env } = {}) {
  return new Promise((res) => {
    const child = spawn(cmd, {
      cwd, shell: true, windowsHide: true,
      env: { ...process.env, ...env },
    });
    let stdout = '', stderr = '', timedOut = false;
    let timer = null;
    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        // On Windows, kill the whole tree — `claude` spawns children.
        if (IS_WIN) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
        else child.kill('SIGKILL');
      }, timeoutMs);
    }
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => { if (timer) clearTimeout(timer); res({ code, stdout, stderr, timedOut }); });
    child.on('error', (e) => { if (timer) clearTimeout(timer); res({ code: -1, stdout, stderr: String(e), timedOut }); });
  });
}

const ok = (r) => r.code === 0;

/* ------------------------------------------------------------- wake lock */

let WAKE = null;

/**
 * Keep the machine awake for the duration of the run — and only that long.
 *
 * SetThreadExecutionState is per-thread and holds only while that thread is
 * alive, so we park a PowerShell process that asserts the flag and blocks.
 * Killing it releases the lock, which means normal sleep behaviour returns the
 * moment the run ends (or crashes) rather than requiring a permanent powercfg
 * change someone has to remember to undo.
 *
 * Flags: ES_CONTINUOUS | ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED (0x80000041).
 * ES_DISPLAY_REQUIRED is deliberately omitted — the screen may sleep, only the
 * system must not.
 *
 * On S0 Modern Standby machines this suppresses idle sleep but is not absolute;
 * confirm with `powercfg /requests` during a run that SYSTEM shows this process.
 */
function acquireWakeLock() {
  if (!IS_WIN) return null; // POSIX hosts: caller's responsibility (caffeinate, systemd-inhibit)

  const script = [
    '$sig = \'[DllImport("kernel32.dll", SetLastError=true)] public static extern uint SetThreadExecutionState(uint esFlags);\'',
    '$t = Add-Type -MemberDefinition $sig -Name Power -Namespace Win32 -PassThru',
    '$r = $t::SetThreadExecutionState([uint32]"0x80000041")',
    'if ($r -eq 0) { exit 1 }',
    'while ($true) { Start-Sleep -Seconds 3600 }',
  ].join('; ');

  try {
    const child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', script],
      { windowsHide: true, stdio: 'ignore' });

    child.on('error', () => log('wakelock.failed', { msg: 'could not acquire — machine may sleep mid-run' }));
    child.on('exit', (code) => {
      // A non-zero exit means the API call itself failed; silence would be worse
      // than noise here, because the failure mode is a run that dies at 3am.
      if (code) log('wakelock.lost', { msg: `helper exited ${code} — machine may sleep mid-run` });
    });

    log('wakelock.held', { msg: 'system sleep suppressed for this run (display may still sleep)' });
    return child;
  } catch {
    log('wakelock.failed', { msg: 'could not acquire — machine may sleep mid-run' });
    return null;
  }
}

function releaseWakeLock() {
  if (!WAKE || WAKE.killed) return;
  try { WAKE.kill(); } catch { /* best effort */ }
  WAKE = null;
}

/** Release on every exit path, including Ctrl-C and an unhandled throw. */
function installWakeLockCleanup() {
  process.on('exit', releaseWakeLock);
  process.on('SIGINT', () => { releaseWakeLock(); process.exit(130); });
  process.on('SIGTERM', () => { releaseWakeLock(); process.exit(143); });
}

/* ------------------------------------------------------------ claude call */

/**
 * One agent iteration. Fresh process, no session reuse — that is the whole
 * point of the loop (agent contract: "fresh instance per iteration").
 */
let PROMPT_SEQ = 0;

async function claude(prompt, { cwd, model, budgetUsd, timeoutMs, cfg, addDirs = [] }) {
  // Sequence, not Date.now() alone — parallel workers can collide within 1ms.
  const promptFile = join(RUN.dir, `prompt-${Date.now()}-${++PROMPT_SEQ}.md`);
  writeFileSync(promptFile, prompt);

  const args = [
    '--print',
    '--output-format', 'json',
    '--model', model,
    '--permission-mode', cfg.claude.permissionMode,
    '--max-budget-usd', String(budgetUsd),
  ];
  for (const d of addDirs) args.push('--add-dir', quote(d));
  for (const t of cfg.claude.disallowedTools) args.push('--disallowed-tools', quote(t));

  // Prompt via stdin redirect keeps it off the command line (Windows arg limits).
  const cmd = `claude ${args.join(' ')} < ${quote(promptFile)}`;
  const r = await sh(cmd, { cwd, timeoutMs });

  let parsed = null;
  try { parsed = JSON.parse(r.stdout); } catch { /* fall through */ }

  const usd = parsed?.total_cost_usd ?? 0;
  RUN.usd += usd;

  return {
    ok: ok(r) && !!parsed && parsed.subtype === 'success',
    timedOut: r.timedOut,
    text: parsed?.result ?? r.stdout,
    usd,
    turns: parsed?.num_turns ?? null,
    raw: r,
  };
}

function quote(s) { return `"${String(s).replace(/"/g, '\\"')}"`; }

/* ------------------------------------------------------------- preflight */

async function preflight(cfg, repos) {
  const problems = [];

  for (const bin of ['git --version', 'node --version', 'npm --version', 'claude --version', 'gh --version']) {
    const r = await sh(bin);
    if (!ok(r)) problems.push(`missing or broken on PATH: ${bin.split(' ')[0]}`);
  }

  const auth = await sh('gh auth status');
  if (!ok(auth)) problems.push('gh is not authenticated (`gh auth login`) — workers cannot open PRs');

  for (const [name, repo] of repos) {
    if (!existsSync(repo.path)) { problems.push(`${name}: path does not exist: ${repo.path}`); continue; }

    const status = await sh('git status --porcelain', { cwd: repo.path });
    if (!ok(status)) { problems.push(`${name}: git is unusable here — ${status.stderr.trim()}`); continue; }
    if (status.stdout.trim()) {
      problems.push(`${name}: working tree is dirty. Commit, stash or clean before an unattended run — ` +
                    `workers branch from it and a dirty base silently contaminates every PR.`);
    }

    const fetch = await sh('git fetch --quiet --all --prune', { cwd: repo.path });
    if (!ok(fetch)) problems.push(`${name}: git fetch failed — ${fetch.stderr.trim()}`);

    // Base branch CI must be green before we pile more on top of it.
    const base = repo.prBase;
    const runs = await sh(
      `gh run list --branch ${base} --limit 1 --json conclusion,status,displayTitle`,
      { cwd: repo.path });
    if (ok(runs)) {
      try {
        const [last] = JSON.parse(runs.stdout || '[]');
        if (last && last.status === 'completed' && last.conclusion !== 'success') {
          problems.push(`${name}: latest CI on ${base} is ${last.conclusion} ("${last.displayTitle}") — ` +
                        `fix ${base} before running the loop against it`);
        }
      } catch { /* non-fatal */ }
    }
  }

  // Drift check, warn-only: prompts/worker.md is the operative copy of the
  // agent contract for unattended work and is synced by hand. If the contract
  // moved since worker.md last did, tonight's workers run on stale rules.
  const ctxRoot = resolve(HERE, '..', '..');
  const lastCommit = async (p) => Number((await sh(`git log -1 --format=%ct -- ${quote(p)}`, { cwd: ctxRoot })).stdout.trim()) || 0;
  const contractAt = await lastCommit('docs/agent-contract.md');
  const workerAt = await lastCommit('tools/agent-loop/prompts/worker.md');
  if (contractAt > workerAt) {
    log('preflight.warn', {
      msg: `docs/agent-contract.md changed after prompts/worker.md was last synced ` +
           `(${new Date(contractAt * 1000).toISOString().slice(0, 10)} vs ${new Date(workerAt * 1000).toISOString().slice(0, 10)}) — ` +
           `check worker.md reflects the current contract`,
    });
  }

  // The merge gate is belt-and-braces: config can ask for auto-merge, but the
  // runner independently refuses while the known false-green risk is open.
  if (cfg.merge.enabled && !cfg.merge.verifiedGateOk) {
    problems.push('merge.enabled is true but merge.verifiedGateOk is false — refusing to auto-merge. ' +
                  'See loop.config.json for what has to be true first.');
  }
  if (cfg.merge.enabled && cfg.merge.neverTargets.includes(cfg.merge.target)) {
    problems.push(`merge.target "${cfg.merge.target}" is in neverTargets — refusing.`);
  }

  return problems;
}

/* ------------------------------------------------------------------ plan */

async function buildQueue(cfg, repos, limit) {
  const prompt = renderPrompt('planner.md', {
    LIMIT: limit,
    REPOS: [...repos.keys()].join(', '),
    LINEAR_PROJECT: cfg.queue.linearProject,
    SOURCE: cfg.queue.source,
    SELF_GEN_MAX: cfg.queue.selfGeneratedMax,
    SELF_GEN_KINDS: cfg.queue.selfGeneratedAllowedKinds.join(', '),
  });

  const anyRepo = [...repos.values()][0];
  const r = await claude(prompt, {
    cwd: anyRepo.path,
    model: cfg.model.planner,
    budgetUsd: Math.min(cfg.budgets.perTicketUsd, 8),
    timeoutMs: 20 * 60 * 1000,
    cfg,
    addDirs: [...repos.values()].map((x) => x.path),
  });

  if (!r.ok) { log('plan.failed', { msg: r.timedOut ? 'planner timed out' : 'planner errored' }); return []; }

  const tickets = extractJson(r.text);
  if (!Array.isArray(tickets)) { log('plan.unparseable', { msg: 'planner did not return a JSON array' }); return []; }

  log('plan.ready', { msg: `${tickets.length} ticket(s), $${r.usd.toFixed(2)}` });
  return tickets.slice(0, limit);
}

/** Pull the last fenced or bare JSON value (array or object) out of a model response. */
function extractJson(text) {
  if (!text) return null;
  const fenced = [...String(text).matchAll(/```(?:json)?\s*([\s\S]*?)```/g)].map((m) => m[1]);
  const candidates = [...fenced].reverse();
  const braceIdx = String(text).search(/[[{]/);
  const bare = braceIdx >= 0 ? String(text).slice(braceIdx) : '';
  candidates.push(bare, String(text));
  for (const c of candidates) {
    try { const v = JSON.parse(c.trim()); if (v && typeof v === 'object') return v; } catch { /* next */ }
  }
  return null;
}

/* -------------------------------------------------------------- worktree */

/**
 * git worktree add/remove mutate the shared repo's refs and index, so two
 * parallel workers must not run them at once. Only these bookend operations
 * serialize — the `claude` iterations inside the worktrees stay concurrent.
 */
const REPO_LOCKS = new Map();
function withRepoLock(repo, fn) {
  const prev = REPO_LOCKS.get(repo.path) ?? Promise.resolve();
  const next = prev.then(fn, fn);
  REPO_LOCKS.set(repo.path, next.then(() => {}, () => {}));
  return next;
}

async function addWorktree(repo, ticket) {
  // Lock covers only the git surgery; the (slow) install runs unlocked in the
  // new worktree so parallel workers don't queue behind each other's npm ci.
  const wt = await withRepoLock(repo, () => addWorktreeUnlocked(repo, ticket));
  if (wt.error) return wt;
  const install = await sh(repo.install, { cwd: wt.path, timeoutMs: 15 * 60 * 1000 });
  if (!ok(install)) return { error: `install failed: ${tail(install.stderr || install.stdout)}` };
  return wt;
}

async function addWorktreeUnlocked(repo, ticket) {
  const branch = ticket.branch || `agent/${String(ticket.id).toLowerCase()}`;
  const path = join(repo.worktreeRoot, String(ticket.id).toLowerCase());
  mkdirSync(repo.worktreeRoot, { recursive: true });
  if (existsSync(path)) await removeWorktreeUnlocked(repo, path); // already under the lock

  // A local branch may survive an earlier attempt at this ticket: worktree
  // teardown removes the checkout, not the ref. Whether that leftover is
  // garbage or live work depends on whether it was ever pushed.
  const exists = ok(await sh(`git show-ref --verify --quiet refs/heads/${branch}`, { cwd: repo.path }));
  if (exists) {
    const pushed = ok(await sh(`git show-ref --verify --quiet refs/remotes/origin/${branch}`, { cwd: repo.path }));
    if (pushed) {
      // Almost certainly an open PR from a previous run. One ticket = one PR,
      // and no agent picks up a ticket whose PR is still open.
      return { error: `branch ${branch} already exists on origin — a PR for ${ticket.id} is probably still open. Skipping.` };
    }
    const del = await sh(`git branch -D ${branch}`, { cwd: repo.path });
    if (!ok(del)) return { error: `stale local branch ${branch} could not be deleted: ${del.stderr.trim()}` };
    log('worktree.stale_branch_cleared', { ticket: ticket.id, msg: branch });
  }

  const r = await sh(`git worktree add -b ${branch} ${quote(path)} ${repo.baseBranch}`, { cwd: repo.path });
  if (!ok(r)) return { error: r.stderr.trim() || r.stdout.trim() };

  return { path, branch };
}

function removeWorktree(repo, path) {
  // The lock is not reentrant — code already holding it (addWorktreeUnlocked)
  // must call removeWorktreeUnlocked directly or it deadlocks on itself.
  return withRepoLock(repo, () => removeWorktreeUnlocked(repo, path));
}

async function removeWorktreeUnlocked(repo, path) {
  const r = await sh(`git worktree remove --force ${quote(path)}`, { cwd: repo.path });
  if (!ok(r)) {
    // Windows long paths defeat `git worktree remove`.
    try { rmSync(path, { recursive: true, force: true }); } catch { /* best effort */ }
    await sh('git worktree prune', { cwd: repo.path });
  }
}

/* ---------------------------------------------------------------- verify */

/**
 * Path to the vendored gate checker (unlazy v2). Every ticket ends with two
 * implicit verify steps beyond the repo's own list:
 *   gates          — re-runs the CHECK commands in the worker's GATES.md;
 *                    unmet gates fail the ticket like a red test. "AC met" is
 *                    a runner-enforced check, not a worker self-report.
 *   gates-untracked — GATES.md is a working artifact; a worker that commits
 *                    it fails here rather than shipping it in the PR.
 */
const GATE_CHECK = join(HERE, 'scripts', 'gate-check.mjs');

async function verify(repo, cwd) {
  const steps = [...repo.verify, { name: 'gates', cmd: `node ${quote(GATE_CHECK)} GATES.md` }];
  const results = [];
  for (const step of steps) {
    const r = await sh(step.cmd, { cwd, timeoutMs: 20 * 60 * 1000 });
    results.push({ name: step.name, pass: ok(r), output: ok(r) ? '' : tail(r.stdout + r.stderr) });
    if (!ok(r)) break; // first failure is the signal; no value in the rest
  }
  if (results.every((x) => x.pass)) {
    const tracked = await sh('git ls-files --error-unmatch GATES.md', { cwd });
    results.push({
      name: 'gates-untracked', pass: !ok(tracked),
      output: ok(tracked) ? 'GATES.md is committed — it is a working artifact, remove it from the branch' : '',
    });
  }
  return { pass: results.every((x) => x.pass), results };
}

function tail(s, n = 2000) { const t = String(s || ''); return t.length > n ? t.slice(-n) : t; }

/* --------------------------------------------------------------- tickets */

async function runTicket(cfg, repo, repoName, ticket, hint = null) {
  const started = Date.now();
  log('ticket.start', { ticket: ticket.id, msg: ticket.title });

  const wt = await addWorktree(repo, ticket);
  if (wt.error) {
    log('ticket.worktree_failed', { ticket: ticket.id, msg: wt.error });
    return { ...ticket, repo: repoName, outcome: 'error', detail: `worktree: ${wt.error}` };
  }

  const hintSection = hint
    ? `\n### Supervisor hint from a previous failed attempt\n\n${hint}\n`
    : '';

  const prompt = renderPrompt('worker.md', {
    TICKET_ID: ticket.id,
    TITLE: ticket.title,
    ACS: (ticket.acceptanceCriteria || []).map((a) => `- ${a}`).join('\n'),
    OUT_OF_SCOPE: (ticket.outOfScope || []).map((a) => `- ${a}`).join('\n') || '- (none declared)',
    FILES: (ticket.files || []).join(', ') || '(not declared — infer from the ACs, stay narrow)',
    REPO: repoName,
    BRANCH: wt.branch,
    PR_BASE: repo.prBase,
    ATTRIBUTION: repo.attribution,
    VERIFY: repo.verify.map((v) => `- \`${v.cmd}\``).join('\n'),
    TOKENS: cfg.budgets.perTicketTokensAdvisory.toLocaleString(),
    TOOL_CALLS: cfg.budgets.perTicketToolCallsAdvisory,
    MINUTES: cfg.budgets.perTicketMinutes,
    GATE_CHECK: GATE_CHECK,
    HINT_SECTION: hintSection,
  });

  const r = await claude(prompt, {
    cwd: wt.path,
    model: cfg.model.worker,
    budgetUsd: cfg.budgets.perTicketUsd,
    timeoutMs: cfg.budgets.perTicketMinutes * 60 * 1000,
    cfg,
  });

  const minutes = Math.round((Date.now() - started) / 60000);

  const workerTail = tail(r.text, 1500);

  if (r.timedOut) {
    log('ticket.timeout', { ticket: ticket.id, msg: `${minutes}m` });
    await removeWorktree(repo, wt.path);
    return { ...ticket, repo: repoName, outcome: 'timeout', minutes, usd: r.usd, workerTail,
             detail: `exceeded ${cfg.budgets.perTicketMinutes}m` };
  }

  // The worker signals a deliberate stop rather than failing silently.
  const escalated = /^\s*ESCALATE:/m.exec(r.text);
  if (escalated) {
    log('ticket.escalated', { ticket: ticket.id, msg: tail(r.text, 200) });
    await removeWorktree(repo, wt.path);
    return { ...ticket, repo: repoName, outcome: 'escalated', minutes, usd: r.usd, workerTail, detail: tail(r.text, 1500) };
  }

  const v = await verify(repo, wt.path);
  const verifyTail = tail(v.results.map((x) => `${x.name}: ${x.pass ? 'pass' : 'fail'}\n${x.output}`).join('\n'), 1500);
  const prMatch = /https:\/\/github\.com\/\S+\/pull\/\d+/.exec(r.text);

  await removeWorktree(repo, wt.path);

  if (!v.pass) {
    const failed = v.results.find((x) => !x.pass);
    log('ticket.verify_failed', { ticket: ticket.id, msg: failed?.name });
    return { ...ticket, repo: repoName, outcome: 'verify_failed', minutes, usd: r.usd, workerTail, verifyTail,
             pr: prMatch?.[0] ?? null, detail: `${failed?.name} failed:\n${failed?.output}` };
  }

  if (!prMatch) {
    log('ticket.no_pr', { ticket: ticket.id, msg: 'verify passed but no PR URL in output' });
    return { ...ticket, repo: repoName, outcome: 'no_pr', minutes, usd: r.usd, workerTail, verifyTail, detail: tail(r.text, 1500) };
  }

  log('ticket.pr_open', { ticket: ticket.id, msg: prMatch[0] });
  return { ...ticket, repo: repoName, outcome: 'pr_open', minutes, usd: r.usd, workerTail, verifyTail, pr: prMatch[0] };
}

/* ----------------------------------------------------------- merge train */

/**
 * Sequential merge with the deploy/e2e ordering the CI workflow does not yet
 * guarantee itself: merge → wait for deploy-web → run e2e-happy-path against
 * the build that deploy actually published → only then continue.
 *
 * The e2e job is not sequenced after the deploy job within one workflow run,
 * so a very fast push could exercise the previous deploy rather than this
 * one. An unattended run
 * merging several tickets a night is exactly the workload that narrows the gap
 * between pushes, so the harness closes it.
 */
async function mergeTrain(cfg, repo, repoName, merged) {
  if (!cfg.merge.enabled || !cfg.merge.verifiedGateOk) {
    log('merge.skipped', { msg: 'auto-merge disabled — PRs left for human review' });
    return;
  }

  for (const t of merged) {
    // `pr_open` only — a supervisor-rejected PR carries outcome
    // `review_rejected`, which this filter already excludes.
    if (t.outcome !== 'pr_open') continue;

    log('merge.update_branch', { ticket: t.id });
    await sh(`gh pr update-branch ${t.pr}`, { cwd: repo.path });

    const checks = await sh(`gh pr checks ${t.pr} --watch --fail-fast`, { cwd: repo.path, timeoutMs: 30 * 60 * 1000 });
    if (!ok(checks)) { t.outcome = 'merge_blocked'; t.detail = 'PR checks red after update-branch'; continue; }

    const m = await sh(`gh pr merge ${t.pr} --squash --delete-branch`, { cwd: repo.path });
    if (!ok(m)) { t.outcome = 'merge_blocked'; t.detail = tail(m.stderr); continue; }
    log('merge.merged', { ticket: t.id });

    // 1. wait for the RC deploy this merge triggered
    const deploy = await sh(
      `gh run list --workflow deploy-web.yml --branch ${repo.prBase} --limit 1 --json databaseId --jq ".[0].databaseId"`,
      { cwd: repo.path });
    const deployId = deploy.stdout.trim();
    if (deployId) {
      log('merge.await_deploy', { ticket: t.id, msg: `run ${deployId}` });
      const w = await sh(`gh run watch ${deployId} --exit-status`, { cwd: repo.path, timeoutMs: 30 * 60 * 1000 });
      if (!ok(w)) {
        t.outcome = 'deploy_failed';
        t.detail = 'deploy-web.yml failed after merge';
        RUN.stopReason = `RC deploy failed after merging ${t.id} — stopping the train.`;
        return;
      }
    }

    // 2. only now exercise the live build
    log('merge.e2e', { ticket: t.id, msg: 'running e2e-happy-path against the fresh deploy' });
    const dispatch = await sh(`gh workflow run ci.yml --ref ${repo.prBase}`, { cwd: repo.path });
    if (!ok(dispatch)) log('merge.e2e_dispatch_failed', { ticket: t.id, msg: tail(dispatch.stderr, 300) });
    const listed = await sh(
      `gh run list --workflow ci.yml --branch ${repo.prBase} --limit 1 --json databaseId --jq ".[0].databaseId"`,
      { cwd: repo.path });
    const e2eId = listed.stdout.trim();
    if (e2eId) {
      const w = await sh(`gh run watch ${e2eId} --exit-status`, { cwd: repo.path, timeoutMs: 45 * 60 * 1000 });
      if (!ok(w)) {
        t.outcome = 'e2e_failed';
        t.detail = 'e2e-happy-path failed against the freshly deployed RC build — stopping the train';
        RUN.stopReason = `e2e-happy-path red after merging ${t.id}. RC may be broken; nothing further merged.`;
        return;
      }
    }
    t.outcome = 'merged';
  }
}

/* ------------------------------------------------------------- supervisor */

/**
 * Checkpoint supervisor: a fresh, stateless `claude -p` call at the review
 * and triage gates. Advisory only — the runner never surfaces more than the
 * whitelisted verdict fields below, so a supervisor structurally cannot
 * raise budgets, touch merge config, or override neverTargets/escalations,
 * whatever it says. Any failure to get a clean verdict (call not ok,
 * timeout, unparseable, missing/invalid fields) logs and returns null; every
 * caller falls back to the pre-supervisor behaviour on null.
 */
async function supervise(cfg, repo, repoName, mode, vars) {
  const prompt = renderPrompt('supervisor.md', {
    MODE: mode,
    REPO_NAME: repoName,
    REPO_PATH: repo.path,
    TICKET_JSON: 'n/a', NIGHT_DIGEST: 'n/a',
    PR_NUMBER: 'n/a', VERIFY_TAIL: 'n/a', WORKER_TAIL: 'n/a',
    FAILURE_TAIL: 'n/a', OUTCOME: 'n/a',
    ...vars,
  });

  const r = await claude(prompt, {
    cwd: repo.path,
    model: cfg.model.supervisor,
    budgetUsd: cfg.budgets.perSupervisorCallUsd,
    timeoutMs: 15 * 60 * 1000,
    cfg,
  });

  if (!r.ok || r.timedOut) {
    log('supervisor.unavailable', { msg: `mode=${mode} ${r.timedOut ? 'timed out' : 'call failed'} — falling back` });
    return null;
  }

  const verdict = extractJson(r.text);
  const validReview = mode === 'review' && verdict && (verdict.verdict === 'approve' || verdict.verdict === 'reject');
  const validTriage = mode === 'triage' && verdict && ['retry', 'skip', 'halt'].includes(verdict.action);
  if (!validReview && !validTriage) {
    log('supervisor.unavailable', { msg: `mode=${mode} unparseable or invalid verdict — falling back` });
    return null;
  }

  log('supervisor.verdict', { msg: `mode=${mode} ${JSON.stringify(verdict)}` });
  return verdict;
}

function nightDigest() {
  return JSON.stringify(RUN.tickets.map((t) => ({
    id: t.id, outcome: t.outcome, minutes: t.minutes ?? null, usd: +(t.usd ?? 0).toFixed(2),
  })));
}

function reviewVars(result) {
  return {
    TICKET_JSON: JSON.stringify(result),
    NIGHT_DIGEST: nightDigest(),
    PR_NUMBER: (result.pr || '').match(/\/pull\/(\d+)/)?.[1] ?? 'unknown',
    VERIFY_TAIL: result.verifyTail || '(none captured)',
    WORKER_TAIL: result.workerTail || '(none captured)',
  };
}

function triageVars(result) {
  const failureTail = [result.workerTail, result.verifyTail, result.detail].filter(Boolean).join('\n---\n');
  return {
    TICKET_JSON: JSON.stringify(result),
    NIGHT_DIGEST: nightDigest(),
    FAILURE_TAIL: failureTail || '(no output captured)',
    OUTCOME: result.outcome,
  };
}

/** Best-effort: post the reject reasons to the PR. Log and move on if it fails. */
async function postReviewComment(repo, result) {
  const prNum = (result.pr || '').match(/\/pull\/(\d+)/)?.[1];
  if (!prNum) return;
  const lines = ['**Supervisor review: changes requested**', ''];
  for (const r of result.reviewReasons?.length ? result.reviewReasons : ['(no reasons given)']) lines.push(`- ${r}`);
  const bodyFile = join(RUN.dir, `review-comment-${prNum}-${Date.now()}.md`);
  writeFileSync(bodyFile, lines.join('\n'));
  const r = await sh(`gh pr comment ${prNum} --body-file ${quote(bodyFile)}`, { cwd: repo.path });
  if (!ok(r)) log('supervisor.comment_failed', { ticket: result.id, msg: `PR #${prNum}: ${tail(r.stderr, 300)}` });
}

/* ---------------------------------------------------------------- prompts */

function renderPrompt(name, vars) {
  const p = join(HERE, 'prompts', name);
  let s = readFileSync(p, 'utf8');
  for (const [k, v] of Object.entries(vars)) s = s.replaceAll(`{{${k}}}`, String(v));
  const leftover = s.match(/\{\{[A-Z_]+\}\}/g);
  if (leftover) fail(`prompt ${name} has unfilled placeholders: ${[...new Set(leftover)].join(', ')}`);
  return s;
}

/* ---------------------------------------------------------------- report */

function writeReport(cfg) {
  const mins = Math.round((Date.now() - RUN.startedAt) / 60000);
  const by = (o) => RUN.tickets.filter((t) => t.outcome === o);

  const rows = RUN.tickets.map((t) =>
    `| ${t.id} | ${t.repo} | ${t.outcome}${t.retries ? ` (retry ${t.retries}x)` : ''} | ${t.minutes ?? '—'}m | $${(t.usd ?? 0).toFixed(2)} | ${t.pr ?? '—'} |`
  ).join('\n');

  const escalations = RUN.tickets
    .filter((t) => ['escalated', 'verify_failed', 'timeout', 'error', 'no_pr', 'merge_blocked', 'e2e_failed', 'deploy_failed', 'review_rejected'].includes(t.outcome))
    .map((t) => {
      const reasons = t.reviewReasons?.length ? `\n\n**Supervisor reasons:**\n${t.reviewReasons.map((r) => `- ${r}`).join('\n')}` : '';
      const retried = t.retries ? ` (retried ${t.retries}x — hint: ${tail(t.retryHint || '', 200)})` : '';
      return `### ${t.id} — ${t.outcome}${retried}\n\n${t.title}${reasons}\n\n\`\`\`\n${tail(t.detail || '', 1200)}\n\`\`\``;
    })
    .join('\n\n');

  const supervisorSection = RUN.supervisorVerdicts?.length
    ? `\n## Supervisor verdicts\n\n${RUN.supervisorVerdicts.map((v) => `- **${v.ticket}** (${v.mode}): ${JSON.stringify(v.verdict)}`).join('\n')}\n`
    : '';

  const md = `# agent-loop run ${RUN.id}

**Stopped because:** ${RUN.stopReason ?? 'queue drained / ticket cap reached'}
**Wall clock:** ${mins}m · **Spend:** $${RUN.usd.toFixed(2)} · **Tickets attempted:** ${RUN.tickets.length}
**Auto-merge:** ${cfg.merge.enabled && cfg.merge.verifiedGateOk ? `on → ${cfg.merge.target}` : 'off (PRs left for review)'}

## Outcomes

| Ticket | Repo | Outcome | Time | Spend | PR |
|---|---|---|---|---|---|
${rows || '| — | — | nothing attempted | — | — | — |'}

- PRs open for review: **${by('pr_open').length}**
- Merged: **${by('merged').length}**
- Needs you: **${RUN.tickets.length - by('pr_open').length - by('merged').length}**

${escalations ? `## Needs your attention\n\n${escalations}` : '## Needs your attention\n\nNothing — clean run.'}
${supervisorSection}
---
Raw event log: \`${RUN.log}\`
`;

  const path = join(RUN.dir, 'REPORT.md');
  writeFileSync(path, md);
  return path;
}

/* ------------------------------------------------------------------ main */

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!existsSync(args.config)) fail(`config not found: ${args.config}`);
  const cfg = JSON.parse(readFileSync(args.config, 'utf8'));

  const active = args.repo ? [args.repo] : cfg.activeRepos;
  const repos = new Map();
  for (const name of active) {
    const r = cfg.repos[name];
    if (!r) fail(`repo "${name}" is not in config.repos`);
    if (r.enabled === false) { console.warn(`agent-loop: skipping ${name} — ${r.disabledReason}`); continue; }
    repos.set(name, r);
  }
  if (repos.size === 0) fail('no enabled repos to work in');

  startRun(cfg);
  log('run.start', { msg: `${RUN.id} · repos: ${[...repos.keys()].join(', ')}` });

  const problems = await preflight(cfg, repos);
  if (problems.length) {
    for (const p of problems) log('preflight.problem', { msg: p });
    log('run.abort', { msg: 'preflight failed — nothing dispatched' });
    RUN.stopReason = `preflight failed:\n- ${problems.join('\n- ')}`;
    console.log(`\nReport: ${writeReport(cfg)}`);
    process.exit(1);
  }
  log('preflight.ok', { msg: 'substrate ready' });
  if (args.preflightOnly) { log('run.done', { msg: 'preflight-only' }); process.exit(0); }

  // Held from here (covers planner + workers) until the process exits.
  if (cfg.keepAwake !== false) {
    installWakeLockCleanup();
    WAKE = acquireWakeLock();
  }

  const limit = args.max ?? cfg.budgets.maxTicketsPerRun;
  const queue = await buildQueue(cfg, repos, limit);
  if (queue.length === 0) {
    RUN.stopReason = 'ready queue was empty — nothing to do (exited cleanly rather than idle-polling)';
    log('run.done', { msg: RUN.stopReason });
    console.log(`\nReport: ${writeReport(cfg)}`);
    process.exit(0);
  }

  if (args.dryRun) {
    RUN.stopReason = 'dry run — planned only, spawned nothing';
    RUN.tickets = queue.map((t) => ({ ...t, repo: t.repo ?? [...repos.keys()][0], outcome: 'planned' }));
    log('run.done', { msg: RUN.stopReason });
    console.log(`\n${JSON.stringify(queue, null, 2)}\n\nReport: ${writeReport(cfg)}`);
    process.exit(0);
  }

  /**
   * Worker pool — up to concurrency.maxParallelWorkers tickets in flight at
   * once. Safe because the planner guarantees file-disjoint tickets, each
   * runs in its own worktree, and REPO_LOCKS serializes the git bookends.
   * The merge train below stays strictly sequential regardless.
   *
   * Parallel semantics of the §8.3 stop conditions:
   * - Failures are counted in COMPLETION order ("consecutive" has no
   *   queue-order meaning once workers overlap).
   * - A stop condition stops LAUNCHES; tickets already in flight run to
   *   completion — killing a worker mid-ticket is how half-written branches
   *   happen (field notes: never user-stop a worker).
   * - First stop reason wins (??=); later finishers don't overwrite it.
   */
  let consecutiveFailures = 0;
  let stopLaunching = false;
  const deadline = RUN.startedAt + cfg.budgets.runWallClockMinutes * 60 * 1000;
  const maxWorkers = Math.max(1, cfg.concurrency?.maxParallelWorkers ?? 1);

  async function handleTicket(ticket) {
    const repoName = ticket.repo && repos.has(ticket.repo) ? ticket.repo : [...repos.keys()][0];
    const repo = repos.get(repoName);
    let result = await runTicket(cfg, repo, repoName, ticket);
    let halted = false;

    // Failure triage — before the consecutiveFailures counter, everything
    // except escalations (those always stop unconditionally, untouched by
    // the supervisor). One retry attempt max, config-bounded.
    if (result.outcome !== 'pr_open' && result.outcome !== 'escalated' && cfg.supervisor?.enabled) {
      const verdict = await supervise(cfg, repo, repoName, 'triage', triageVars(result));
      if (verdict) (RUN.supervisorVerdicts ??= []).push({ ticket: ticket.id, mode: 'triage', verdict });

      if (verdict?.action === 'halt') {
        RUN.stopReason ??= `supervisor halted the run after ${result.id}: ${verdict.reason || 'no reason given'}`;
        result.supervisorHalt = verdict.reason;
        halted = true;
      } else if (verdict?.action === 'retry' && (result.retries ?? 0) < cfg.supervisor.maxRetriesPerTicket) {
        log('ticket.retry', { ticket: ticket.id, msg: verdict.hint });
        const retryResult = await runTicket(cfg, repo, repoName, ticket, verdict.hint);
        result = { ...retryResult, retries: (result.retries ?? 0) + 1, retryHint: verdict.hint };
        // Falls through to the review gate / counter below — no second triage.
      }
      // action === 'skip', verdict === null, or retries already exhausted:
      // fall through unchanged, counted as a failure below (today's behaviour).
    }

    // Review gate — every green PR, before merge-train eligibility.
    if (!halted && result.outcome === 'pr_open' && cfg.supervisor?.enabled) {
      const verdict = await supervise(cfg, repo, repoName, 'review', reviewVars(result));
      if (verdict) (RUN.supervisorVerdicts ??= []).push({ ticket: ticket.id, mode: 'review', verdict });

      if (verdict?.verdict === 'reject') {
        result.outcome = 'review_rejected';
        result.reviewReasons = [...(verdict.reasons || []), ...(verdict.must_fix || [])];
        await postReviewComment(repo, result);
      }
    }

    RUN.tickets.push(result);
    if (halted) { stopLaunching = true; return; }

    // review_rejected: worker completed and the PR is fine for morning
    // review, so it resets the counter like success — but it is neither a
    // merge-train success nor a counted failure.
    if (result.outcome === 'pr_open' || result.outcome === 'review_rejected') {
      consecutiveFailures = 0;
    } else {
      consecutiveFailures++;
      if (result.outcome === 'escalated') {
        RUN.stopReason ??= `worker escalated on ${result.id} — stopping rather than guessing`;
        stopLaunching = true;
      } else if (consecutiveFailures >= 2) {
        RUN.stopReason ??= 'two consecutive ticket failures — stopping (stop condition)';
        stopLaunching = true;
      }
    }
  }

  const inFlight = new Set();
  for (const ticket of queue) {
    if (stopLaunching) break;
    if (Date.now() > deadline) { RUN.stopReason ??= 'run wall-clock ceiling reached'; break; }
    if (RUN.usd >= cfg.budgets.runUsdCeiling) { RUN.stopReason ??= `run spend ceiling ($${cfg.budgets.runUsdCeiling}) reached`; break; }

    const p = handleTicket(ticket)
      .catch((e) => log('ticket.error', { ticket: ticket.id, msg: String(e) }))
      .finally(() => inFlight.delete(p));
    inFlight.add(p);
    if (inFlight.size >= maxWorkers) await Promise.race(inFlight);
  }
  await Promise.all([...inFlight]);

  const first = [...repos.entries()][0];
  await mergeTrain(cfg, first[1], first[0], RUN.tickets);

  const report = writeReport(cfg);
  log('run.done', { msg: RUN.stopReason ?? 'completed' });
  console.log(`\nReport: ${report}`);
  process.exit(RUN.stopReason && RUN.tickets.some((t) => t.outcome !== 'pr_open' && t.outcome !== 'merged') ? 2 : 0);
}

main().catch((e) => { console.error(e); process.exit(3); });
