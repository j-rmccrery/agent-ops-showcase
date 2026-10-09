#!/usr/bin/env python3
"""PreToolUse gate on use_figma: Figma canvas work runs under a design
family skill (a past session hand-drew icons because only
figma-use was loaded)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gatelib

OWNERS = ('design', 'design-spec', 'design-qa',
          'design-preflight', 'design-explore', 'component-librarian')

event = gatelib.read_event()
skills = gatelib.loaded_skills(event.get('session_id', 'unknown'))
if any(s in skills for s in OWNERS):
    sys.exit(0)
# back-compat: honor skillNames attestation from older sessions
if 'design' in str((event.get('tool_input') or {}).get('skillNames', '')):
    sys.exit(0)
gatelib.block(
    'Blocked: Figma canvas work routes through the design skill family. '
    'Invoke the matching workflow skill via the Skill tool first — design for '
    'drafting/updating frames; design-spec / -qa / -preflight / -explore or '
    'component-librarian for their jobs — then retry. figma-use alone is the '
    'Plugin-API mechanics prerequisite, not the workflow: it does not know the project\'s '
    'icon library, components, or drafting playbook.')
