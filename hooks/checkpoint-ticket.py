#!/usr/bin/env python3
"""PostToolUse on Linear get_issue: a ticket was just picked up — inject a
routing checkpoint naming what's loaded, so autonomous multi-ticket sessions
re-route at every transition, not just at the first prompt."""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gatelib

event = gatelib.read_event()
skills = sorted(gatelib.loaded_skills(event.get('session_id', 'unknown')))
print(json.dumps({
    'hookSpecificOutput': {
        'hookEventName': 'PostToolUse',
        'additionalContext': (
            '[routing] Ticket read. Before working it, name its owning '
            'skill and invoke it if not already loaded. Loaded so far: '
            + (', '.join(skills) if skills else 'none') + '.')
    }
}))
