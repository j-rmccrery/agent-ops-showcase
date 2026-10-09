#!/usr/bin/env python3
"""PostToolUse on the Skill tool: record every skill this session loads.
The gate hooks read this state — invocation-based attestation, not
self-reported params."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gatelib

event = gatelib.read_event()
skill = str((event.get('tool_input') or {}).get('skill', ''))
if skill:
    gatelib.record_skill(event.get('session_id', 'unknown'), skill.split(':')[-1])
sys.exit(0)
