#!/usr/bin/env python3
"""PostToolUse on Linear comment writes: a same-write nudge for ticket-state
hygiene (a postmortem found same-write misses: ACs left unchecked after
verification, status stale, assignee not moved when the ticket became blocked
on a human).

The same-write rule lives in docs/linear-architecture.md (Accounts &
assignment) and docs/agent-contract.md (Decision tickets and ticket state):
a comment that records a blocker, a verification, or a ruling must land its
body/status/assignee update in the SAME write, not a follow-up one. This hook
cannot see the comment's semantics reliably (no classifier — out of scope), so it always nudges on a matching write; the reminder names the three
things the same-write rule requires and lets the agent judge whether they
apply. Nudge only: never blocks, always exits 0.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gatelib

event = gatelib.read_event()
tool_name = str(event.get('tool_name', ''))

# Matcher in hooks.json is a suffix pattern (".*save_comment$"); this hook
# still checks membership itself since a single command handles hookSpecificOutput
# emission and should stay inert if it's ever wired to a broader matcher.
if not tool_name.endswith('save_comment'):
    sys.exit(0)

print(json.dumps({
    'hookSpecificOutput': {
        'hookEventName': 'PostToolUse',
        'additionalContext': (
            '[hygiene] Comment saved. If it records a blocker, a '
            'verification, or a ruling, the same-write rule '
            '(docs/linear-architecture.md -> Accounts & assignment; '
            'docs/agent-contract.md -> Decision tickets and ticket state) '
            'requires updating the ticket NOW, in this write, not a follow-up '
            'one: (1) body ACs -- check any satisfied since the last write; '
            '(2) status -- move it if this comment changes the ticket\'s '
            'state (e.g. In Progress -> In Review, or -> Blocked); '
            '(3) assignee -- blocked on a specific human means assignee = '
            'that human now, and assignee returns to the agent account when '
            'an agent resumes. If none of these apply to this comment, no '
            'action needed.')
    }
}))
sys.exit(0)
