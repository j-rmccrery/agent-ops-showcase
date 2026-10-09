"""Shared state for routing hooks: which skills this session has
invoked. State lives outside the repo (~/.claude/agent-routing/<session_id>.json)
so gates work identically in any checkout, worktree, or repo."""
import json
import os
import time

STATE_DIR = os.path.expanduser('~/.claude/agent-routing')


def _path(session_id):
    safe = ''.join(c for c in str(session_id) if c.isalnum() or c in '-_')
    return os.path.join(STATE_DIR, f'{safe}.json')


def read_event():
    # Hooks must never disrupt a session: empty or non-JSON stdin (harness
    # anomaly, manual invocation) exits 0 silently instead of tracebacking.
    import sys
    try:
        return json.load(sys.stdin)
    except (ValueError, UnicodeDecodeError):
        sys.exit(0)


def loaded_skills(session_id):
    try:
        with open(_path(session_id)) as f:
            return set(json.load(f).get('skills', []))
    except Exception:
        return set()


def record_skill(session_id, skill):
    os.makedirs(STATE_DIR, exist_ok=True)
    skills = loaded_skills(session_id)
    skills.add(skill)
    with open(_path(session_id), 'w') as f:
        json.dump({'skills': sorted(skills), 'updated': time.time()}, f)
    # prune state files older than 7 days
    cutoff = time.time() - 7 * 86400
    for name in os.listdir(STATE_DIR):
        p = os.path.join(STATE_DIR, name)
        try:
            if os.path.getmtime(p) < cutoff:
                os.remove(p)
        except OSError:
            pass


def block(message):
    import sys
    sys.stderr.write(message)
    sys.exit(2)
