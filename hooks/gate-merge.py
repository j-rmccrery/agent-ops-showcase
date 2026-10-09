#!/usr/bin/env python3
"""PreToolUse gate on Bash `gh pr merge`: enforces the dispatch review-evidence
rule — the PR must carry a [code-review] verdict
comment, or the merge is explicitly marked trivial.

Trivial escape hatch: prefix the merge command with AGENT_REVIEW_SKIP="<reason>"
— the gate allows it and reminds you to log `trivial: <reason>, review skipped`
on the ticket. Fail-closed on gh errors: an unverifiable merge is a blocked
merge (green-looking pipelines lie)."""
import json
import os
import re
import subprocess
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gatelib

event = gatelib.read_event()
cmd = str((event.get('tool_input') or {}).get('command', ''))
if not re.search(r'\bgh\s+pr\s+merge\b', cmd):
    sys.exit(0)

if 'AGENT_REVIEW_SKIP=' in cmd:
    # allowed; the dispatch rule still requires `trivial: <reason>, review
    # skipped` logged on the ticket — the model sees this via the rule text.
    sys.exit(0)

m = re.search(r'\bgh\s+pr\s+merge\s+(?!-)(\S+)', cmd)
ref = [m.group(1)] if m else []
# A bare PR number only resolves inside a clone; honour an explicit -R/--repo so
# the check works from any cwd (Windows sessions often sit in a non-repo dir).
r = re.search(r'(?:\s-R|\s--repo)[\s=]+(\S+)', cmd)
if r and ref and not ref[0].startswith('http'):
    ref += ['-R', r.group(1)]
try:
    out = subprocess.run(
        ['gh', 'pr', 'view', *ref, '--json', 'comments,reviews'],
        capture_output=True, text=True, encoding='utf-8', errors='replace', timeout=20)
    if out.returncode != 0:
        raise RuntimeError(out.stderr.strip()[:200])
    data = json.loads(out.stdout)
    bodies = [c.get('body', '') for c in data.get('comments', [])]
    bodies += [r.get('body', '') for r in data.get('reviews', [])]
    # Prefix match, not the full `[code-review]`: the skill posts its
    # verdict with a tier suffix (`[code-review tier-1]`),
    # so the closing bracket doesn't follow `review`. Matching the open-bracket
    # prefix recognizes both the bare and tier-tagged marker; a real verdict is
    # still required.
    if any('[code-review' in b for b in bodies):
        sys.exit(0)
    reason = 'no [code-review] verdict comment found on the PR'
except Exception as e:
    reason = f'could not verify review evidence ({e})'

gatelib.block(
    f'Blocked: {reason}. The dispatch rule requires merge-time review '
    'evidence: run code-review in a separate session and have it post its '
    'verdict comment on the PR, then retry. If the PR is genuinely trivial, re-run '
    'the merge prefixed with AGENT_REVIEW_SKIP="<reason>" AND log '
    '`trivial: <reason>, review skipped` on the ticket. Audits join review to '
    'merge on the PR number.')
