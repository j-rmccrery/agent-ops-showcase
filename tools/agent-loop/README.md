# agent-loop

An unattended autonomous ticket loop: a planner picks tickets, a worker
implements each one, a supervisor verifies. Runs the dispatch cycle overnight: pull ready tickets, build each one in an
isolated worktree, verify, open a PR, merge into `rc`, and leave a morning report.

The runner is deliberately dumb. It owns process lifecycle, budgets, worktrees,
ordering and stop conditions — nothing else. Every judgment call (which ticket,
how to build it, whether an AC is met) belongs to the `claude -p` iterations,
which reach Linear and GitHub through your existing MCP and `gh` auth. **No
credentials live in this directory.**

## Run it

```bash
cd tools/agent-loop

node agent-loop.mjs --preflight-only   # is the substrate ready?
node agent-loop.mjs --dry-run          # what would tonight's queue be?
node agent-loop.mjs                    # the real thing
node agent-loop.mjs --max 2            # smaller first night
```

Exit codes: `0` clean · `1` preflight failed, nothing dispatched · `2` stopped
on a stop-condition with work incomplete · `3` internal error.

Schedule it with Task Scheduler (`node C:\...\agent-loop.mjs`) and read
`runs/<timestamp>/REPORT.md` over coffee.

## What one iteration does

```
preflight ──> plan ──> per ticket: worktree → claude -p → verify → PR
                            └─> merge train: merge → await deploy → e2e → next
```

Each ticket gets a **fresh** `claude -p` process. No session reuse, no context
carried between tickets — that isolation is the whole point of a loop.

**Parallel workers** : `concurrency.maxParallelWorkers` tickets
run at once — file-disjoint by planner guarantee, isolated in their own
worktrees, with the `git worktree add/remove` bookends serialized behind a
per-repo lock. The merge train stays strictly sequential. Stop-condition
semantics under parallelism: failures count in **completion** order, and a stop
condition stops *launches* — tickets already in flight run to completion
(killing a worker mid-ticket is how half-written branches happen).

## Gates

Every worker writes `GATES.md` in its worktree before coding — one checkbox per
acceptance criterion, each with a runnable `CHECK:`/`EXPECT:` line where a
command can prove it (format: unlazy v2, vendored as
`scripts/gate-check.mjs`, MIT). The runner then re-runs
`node scripts/gate-check.mjs GATES.md` as an implicit final verify step on every
ticket, plus a check that GATES.md was never committed. "Each AC is met" is
thereby a runner-enforced check, not a worker self-report; the supervisor's
diff review is the backstop against hand-flipped boxes. A worker that writes no
GATES.md fails verify — that is enforcement, not an accident.

Preflight also warns (without refusing) when `docs/agent-contract.md` has a
newer last-commit than `prompts/worker.md` — the operative contract copy is
synced by hand and silently going stale is exactly the failure mode files are
supposed to prevent.

## Preflight refuses to start if

- `git`, `node`, `npm`, `claude`, or `gh` is missing, or `gh` isn't authenticated
- a repo's working tree is **dirty** — workers branch from it, and a dirty base
  silently contaminates every PR of the night
- the latest CI run on `rc` is red — don't pile onto a broken base
- `merge.enabled` is true but `merge.verifiedGateOk` is false
- `merge.target` appears in `neverTargets` (`main`, `prod`)

## Stop conditions

The run halts and reports on any of:

| Condition | Behaviour |
|---|---|
| Worker emits `ESCALATE:` | Stop immediately — do not start the next ticket. Unconditional; the supervisor never sees or touches escalations |
| Two consecutive ticket failures | Stop — backstop after supervisor triage (see below); still fires if triage is disabled or unavailable |
| Supervisor rejects a PR in review | `review_rejected` — reasons posted as a PR comment (best-effort), PR excluded from the merge train, night continues (counts as neither success nor failure) |
| Ticket exceeds its time or dollar budget (`budgets`) | Kill the process tree, record `timeout` (a supervisor-triggered retry can spend up to 2× this) |
| Run exceeds its wall-clock or dollar ceiling | Stop between tickets |
| `e2e-happy-path` red after a merge | Halt the merge train — RC may be broken |
| Ready queue empty | Exit cleanly, don't idle-poll |

## Merging

Auto-merge targets `rc` and only `rc`. It needs **both** `merge.enabled` and
`merge.verifiedGateOk`; the runner refuses if either is false, so
`verifiedGateOk: false` is your one-switch kill for a night of PR-only output.

The merge train is strictly sequential — `update-branch` → watch checks → merge
— because strict checks mean each merge invalidates the next PR's run.

**On the deploy race.** The e2e gate is not sequenced after the RC deploy in
CI, so a fast push can exercise the *previous* build. Humans merging one PR at a
time rarely hit it; a loop merging several tickets a night is exactly the
workload that does. So after each merge the runner waits for the deploy to
finish, then triggers e2e against the build that actually shipped, and halts if
it's red. Closing this properly in CI would let `enforceDeployOrdering` go away.

## Supervisor

Two checkpoints where the runner used to apply a dumb rule now get a second
opinion first: a fresh, stateless `claude -p` call (`prompts/supervisor.md`,
model `model.supervisor`) that reads the situation and returns a JSON
verdict. The runner stays the enforcer — it only ever reads the whitelisted
fields below, so the supervisor structurally cannot raise budgets, touch
merge config, or override `neverTargets` or an escalation, whatever it says.

**Review gate** — every ticket that reaches `pr_open`, before it becomes
merge-train eligible. The supervisor reads the actual diff (`gh pr diff`,
`gh pr view`) and judges it against the ticket's acceptance criteria: wrong
problem solved, an AC not really met, scope creep, anything dangerous. It is
told explicitly not to nitpick style — lint and tests already passed.

```json
{"verdict": "approve" | "reject", "reasons": ["..."], "must_fix": ["..."]}
```

`reject` sets the ticket's outcome to `review_rejected`: the reasons and
must-fixes are posted as a best-effort `gh pr comment`, and the PR is
excluded from the merge train (it already fails `mergeTrain`'s `pr_open`
filter). The night continues — the counter resets like a success would,
since the worker did complete and the PR is fine sitting for morning review.

**Failure triage** — any ticket outcome other than `escalated` that isn't
`pr_open` (`verify_failed`, `timeout`, `error`, `no_pr`), called *before* the
consecutive-failures counter. The supervisor sees the failure tail and picks:

```json
{"action": "retry" | "skip" | "halt", "hint": "...", "reason": "..."}
```

- `retry` — up to `supervisor.maxRetriesPerTicket` (default 1) — reruns
  `runTicket` once with the supervisor's hint injected into the worker
  prompt as a marked "Supervisor hint from a previous failed attempt"
  section. The retry's result replaces the original and goes through the
  review gate / counter once — no second triage on a retry's own failure.
- `skip` — increments the consecutive-failures counter exactly like today.
- `halt` — sets `RUN.stopReason` to the supervisor's reason and stops the
  run between tickets, same as any other stop condition.

`escalated` is never triaged — that stop is unconditional. And any
supervisor failure (call errors, times out, returns unparseable or
invalid-shape JSON) logs `supervisor.unavailable` and returns `null` — every
caller falls back to the pre-supervisor behaviour on `null`.

**Kill switch:** `supervisor.enabled: false` in `loop.config.json` restores
pre-supervisor behaviour exactly — no review gate, no triage, the blind
two-consecutive-failures counter as the only stop condition.

**Retry cost:** a retried ticket's spend flows into `RUN.usd` automatically
through the shared `claude()` helper, so a retried ticket may cost up to 2×
`perTicketUsd`. The run's dollar ceiling still caps the whole night — this
just means one ticket's retry can eat more of that ceiling than a single
attempt would.

## Sleep

An overnight run is worthless if the machine sleeps at 2am, so the runner holds a
Windows wake lock (`SetThreadExecutionState`, flags `ES_CONTINUOUS |
ES_SYSTEM_REQUIRED | ES_AWAYMODE_REQUIRED`) for the duration of the run and
releases it on exit — including Ctrl-C and crashes. Normal sleep behaviour returns
the moment the run ends, so there's no permanent `powercfg` change to remember to
undo. `ES_DISPLAY_REQUIRED` is deliberately not set: the screen may still sleep.

Because the API is per-thread, the lock is held by a parked PowerShell child
process; killing it releases the lock. No-op on non-Windows hosts — use
`caffeinate` or `systemd-inhibit` there. Set `keepAwake: false` if you manage sleep
yourself (PowerToys Awake, a permanent `powercfg` change, a server that never
sleeps).

**Verify it on the first real run:** the log should show `wakelock.held`, and
`powercfg /requests` in another terminal should list the PowerShell process under
SYSTEM. On S0 Modern Standby machines the request is honoured but not absolute, so
check rather than assume. Watch for `wakelock.lost` in the log — that means the
helper died and the machine can sleep.

These are the things that still sleep a machine regardless:

- **Laptop lid close** — set lid-close to "do nothing" on AC.
- **Wi-Fi adapter power saving** — Device Manager → adapter → Power Management →
  uncheck "Allow the computer to turn off this device to save power." This one
  kills a remote-control session while the machine stays technically awake.
- **Running on battery** — the wake lock helps, but AC is the assumption.

## Files

```
agent-loop.mjs           the runner (no dependencies, Node 20+)
loop.config.json       repos, budgets, merge policy — the only file you edit
prompts/planner.md      builds the night's queue from the ticket backlog, then self-generates
prompts/worker.md       one ticket → one PR; the unattended loop prompt
prompts/supervisor.md   checkpoint review (PR gate) and triage (failure) verdicts
scripts/gate-check.mjs  vendored unlazy v2 gate checker (MIT) — implicit verify step
runs/<timestamp>/       run.jsonl, the rendered prompts, and REPORT.md
```

`prompts/worker.md` is the operative copy of the ticket contract for unattended
work. When `docs/agent-contract.md` changes, change
it here too — the contract wins on any conflict.

## Adding the backend

`backend` is configured but `enabled: false`. It needs a baseline
first (CI, test harness, PR template, CLAUDE.md agent-contract section). Note
also that branch protection there may require a named human bypass, so agents
can't land work there unattended even once CI exists.

## Testing changes to the runner

It shells out to `git`, `gh`, and `claude`, so it's testable with stubs on
`PATH`: point `loop.config.json` at a throwaway git repo, drop fake `gh` and
`claude` executables in a directory ahead of `PATH`, and exercise the paths that
matter — happy path, escalation, verify failure, dirty tree, merge refusals.
That's how the current version was checked before it ever touched a real repo.

## Known gaps — verify rather than trust

These are still open. **Do not treat a run as trustworthy until they are.**

- **The checkpoint supervisor has never been exercised in a live run** —
  stub-tested only (throwaway repo, fake `claude`/`gh`): review approve,
  review reject, triage retry, triage halt, and garbage-verdict fallback all
  passed against the stub harness, but neither the review gate nor the
  triage prompt has judged a real PR or a real failure yet.

- **The harness has never touched a live repo.** It passed 9/9 against a throwaway
  git repo with stubbed `claude`/`gh` — happy path, escalation, verify failure,
  dirty tree, merge refusals, stale-branch handling. That proves control flow, not
  live worker behaviour. **The planner's Linear read has never been exercised at
  all** and is the most likely thing to need adjustment.
- **The parallel worker pool and the gates verify step are stub-tested only**
  (same throwaway-repo method as the rest): two overlapping workers,
  gate pass/fail, committed-GATES.md rejection, and the escalation-stops-launches
  path all passed against stubs, but neither has run against a live repo.
  The config runs `maxParallelWorkers: 2` — watch the first real run.
- **The deploy-ordering logic is a workaround, not a fix.** CI leaves
  `e2e-happy-path` unsequenced after `deploy-web.yml`, so the harness waits for the
  deploy and runs e2e against what actually shipped. Fixing it in CI would let
  `enforceDeployOrdering` retire *and* give humans the same protection.

**Before any unattended run, confirm the e2e gate is trustworthy.** Auto-merge is
gated on the e2e run and halts if it's red. A gate that fails for reasons
unrelated to the change (for example a permanent skip that exits non-zero and
cascades into later tests never executing) halts every loop at its merge step
regardless of the quality of its work.

The wake lock (see Sleep) is also **committed but never exercised by a real run** —
syntax and wiring verified, behaviour not. Watch for `wakelock.held` on the first
run, and `wakelock.lost` if the helper dies mid-run.
