#!/usr/bin/env python3
"""PreToolUse gate on Edit/Write/MultiEdit: edits to backend require
be-lead loaded (routing audits showed be_edit routing at 0%)."""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import gatelib

event = gatelib.read_event()
path = str((event.get('tool_input') or {}).get('file_path', ''))
if 'backend' not in path:
    sys.exit(0)
skills = gatelib.loaded_skills(event.get('session_id', 'unknown'))
if 'be-lead' in skills:
    sys.exit(0)
gatelib.block(
    'Blocked: this edit touches backend but be-lead is not loaded in '
    'this session. Invoke the be-lead skill via the Skill tool first (it owns '
    'backend architecture, data modeling, deploy pipeline, and security baseline), '
    'then retry the edit.')
