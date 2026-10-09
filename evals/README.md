# Task evals

Replays tickets and PRs against `claude -p`, grades mechanically first (`tools/gate-check.mjs` over a case's `GATES.md`), then with an LLM judge (`tools/eval-grader.md`).

## Run

    node tools/eval-run.mjs --suite tasks            # all task cases
    node tools/eval-run.mjs --suite skill            # every skills/*/evals/evals.json, with + without skill
    node tools/eval-run.mjs --case example-review-offbyone --trials 1
    node tools/eval-report.mjs results > results/scoreboard.md

Env: `EVAL_TRIAL_USD` (6), `EVAL_JUDGE_USD` (2), `EVAL_TRIAL_MINUTES` (45), `EVAL_JUDGE_MODEL` (opus), `EVAL_REPOS_ROOT` (CI), `EVAL_INSTALL=ci` (npm ci instead of junction), `EVAL_CLAUDE_BIN` (tests).

Local repos resolve through `evals/repos.json` (repo key -> local clone path). `results/` and `evals/work/` are gitignored.

Tests: `node --test "tools/__tests__/*.test.mjs"` (quoted for PowerShell; bash can leave it unquoted).

## Case format

One directory per case under `evals/tasks/<id>/`:

| file | purpose |
|---|---|
| `case.json` | `id`, `kind` (`implement` or `review`), `repo` (key in repos.json), `base` (commit the case applies to), `prompt_file`, `skill`, `model`, `seed_patch`, `hidden`, `judge`, `deny` |
| `ticket.md` | the prompt shown to the agent |
| `GATES.md` | mechanical acceptance gates (CHECK-bearing only, never line numbers) |
| `hidden/` | implement cases: case-owned tests mirroring repo paths, copied in at grading time |
| `seed.patch` | review cases: the diff under review, with one defect planted; a control case leaves it clean |

See `example-build-slugify` and `example-review-offbyone`; they are illustrative and target placeholder repos.

Add a case: copy a sibling, edit, then `node tools/eval-run.mjs --case <id> --trials 1` and read `results/<id>/1/`.

Skill cases need no files: they come from `skills/<name>/evals/evals.json` (`id`, `eval_name`, `prompt`, `assertions`).

## GATES.md rules

Review-case gates are one conjoined line check: an uppercase severity anchor (`BLOCKER`/`MAJOR`), a file-path token, and case-insensitive reason keywords on the same line. Scope gates count untracked files too:

    (git diff --name-only <base> -- . ":!GATES.md" & git ls-files --others --exclude-standard) | grep -vE <allow> | wc -l

Use `&` not `;` (gate checks run under `cmd.exe` on Windows).

## Isolation

Trials run `claude -p` with `--setting-sources project --strict-mcp-config`. The worktree's project settings disable the plugin under test; deny rules go to both settings and `--disallowed-tools`. The deny list is a tripwire, not a sandbox: local runs use the operator's own credentials, so prefer CI.

## Scoreboard and baseline

PASS = every trial met every gate and (if judged) 100% of assertions; a timed-out or errored trial is FAIL. `vs baseline` compares to an optional `evals/baseline.json` (`{ "<case id>": { "pass": bool, "pass_rate": number|null } }`); if the file is absent the column is empty.

## Judge agreement

`tools/eval-agreement.mjs` builds a human-reviewable bundle from `results/`: one card per judge expectation with the scenario prompt, the agent's output, the assertion, the judge's verdict, and a blank `**Human:**` field. `--verify` re-checks a generated bundle against source results.

    node tools/eval-agreement.mjs --results results --out evals/judge-agreement.md --n 20 --seed 1

Below 80% agreement, rewrite the assertions before trusting the board.

## Spend

The real guard is a per-key spend cap on the API key, not `EVAL_TRIAL_USD`/`EVAL_JUDGE_USD` alone.
