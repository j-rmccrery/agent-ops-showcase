#!/usr/bin/env python3
"""PreToolUse gate on Linear save_issue: creating a ticket (no id in input)
requires a ticket-owning skill loaded (a routing audit found many
ticket-creating sessions had none)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gatelib

OWNERS = ('ticket', 'scrum', 'dispatch',
          'project-manager', 'product-manager')

event = gatelib.read_event()
inp = event.get('tool_input') or {}
if inp.get('id'):  # update, not creation
    sys.exit(0)
skills = gatelib.loaded_skills(event.get('session_id', 'unknown'))
if any(s in skills for s in OWNERS):
    sys.exit(0)
gatelib.block(
    'Blocked: this call creates a new Linear ticket but no ticket-owning skill is '
    'loaded (ticket / scrum / dispatch / project-manager / '
    'product-manager). Invoke the right one via the Skill tool first — it '
    'carries the template, TL;DR rule, project/state naming, and attribution '
    'conventions — then retry.')
