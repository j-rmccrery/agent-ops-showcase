#!/usr/bin/env python3
"""Routing audit — read-only. Run weekly on each machine (stdlib only,
which is why this is .py in an .mjs toolbox: it must run anywhere python3
exists, with zero install).

Measures, from local Claude session transcripts (~/.claude/projects/*):
  1. Routing coverage: per domain, sessions touching it vs. sessions that
     invoked its owning skill. Domains: figma_write, be_edit, pr_merge,
     ticket_create. Note: pr_merge is session-joined here; the authoritative
     review metric joins on PR number (dispatch rule) — treat
     session-level pr_merge as a smell, not a verdict.
  2. Skill invocation frequency (a skill at zero for weeks = loading bug or
     dead skill — code-review once sat at 0 invocations before this
     existed).
  3. Delivery preflight: installed marketplace/cache plugin versions vs. this
     repo's plugin.json, and a frontmatter lint for the unquoted-colon
     description bug that silently unloaded the lead skills.
"""
import glob
import json
import os
import re
import sys
from collections import defaultdict

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
BE_WRITE_HINTS = ('git add', 'git commit', 'git push', 'sam deploy',
                  'sam build', 'npm run deploy', 'sed -i', '>>')
OWNERS = {
    'figma_write': ('design', 'design-spec', 'design-qa',
                    'design-preflight', 'design-explore',
                    'component-librarian'),
    'be_edit': ('be-lead',),
    'pr_merge': ('code-review',),
    'ticket_create': ('ticket', 'scrum', 'dispatch',
                      'project-manager', 'product-manager'),
}


def scan_sessions():
    sessions = {}
    for d in glob.glob(os.path.expanduser('~/.claude/projects/*')):
        for f in glob.glob(os.path.join(d, '*.jsonl')):
            skills, domains, ts = set(), set(), None
            try:
                with open(f, errors='replace') as fh:
                    for line in fh:
                        if '"tool_use"' not in line and '"timestamp"' not in line:
                            continue
                        try:
                            rec = json.loads(line)
                        except Exception:
                            continue
                        ts = rec.get('timestamp') or ts
                        content = (rec.get('message') or {}).get('content')
                        if not isinstance(content, list):
                            continue
                        for b in content:
                            if not isinstance(b, dict) or b.get('type') != 'tool_use':
                                continue
                            name, inp = b.get('name', ''), b.get('input') or {}
                            if name == 'Skill' and inp.get('skill'):
                                skills.add(str(inp.get('skill')).split(':')[-1])
                            if 'use_figma' in name:
                                domains.add('figma_write')
                            if name in ('Edit', 'Write', 'MultiEdit') and \
                                    'backend' in str(inp.get('file_path', '')):
                                domains.add('be_edit')
                            if name == 'Bash':
                                cmd = str(inp.get('command', ''))
                                if 'backend' in cmd and \
                                        any(h in cmd for h in BE_WRITE_HINTS):
                                    domains.add('be_edit')
                                if 'gh pr merge' in cmd:
                                    domains.add('pr_merge')
                            if name.endswith('save_issue') and not inp.get('id'):
                                domains.add('ticket_create')
                            if name.endswith('merge_diff'):
                                domains.add('pr_merge')
            except Exception:
                continue
            if domains or skills:
                sessions[f] = {'skills': skills, 'domains': domains,
                               'ts': (ts or '')[:10]}
    return sessions


def report_coverage(sessions):
    stats = defaultdict(lambda: [0, 0])
    misses = defaultdict(list)
    for f, s in sessions.items():
        for dom in s['domains']:
            if dom not in OWNERS:
                continue
            stats[dom][0] += 1
            if any(o in s['skills'] for o in OWNERS[dom]):
                stats[dom][1] += 1
            else:
                misses[dom].append((s['ts'], sorted(s['skills'])))
    print(f'\n== Routing coverage ({len(sessions)} active sessions) ==')
    print(f'{"domain":<14}{"touched":>8}{"routed":>8}{"miss %":>8}')
    for dom, (t, r) in sorted(stats.items()):
        pct = 0 if not t else round(100 * (t - r) / t)
        print(f'{dom:<14}{t:>8}{r:>8}{pct:>7}%')
        for ts, sk in sorted(misses[dom])[-3:]:
            print(f'    miss {ts} skills={sk if sk else "NONE"}')
    freq = defaultdict(int)
    for s in sessions.values():
        for sk in s['skills']:
            freq[sk] += 1
    print('\n== Skill invocation frequency ==')
    for sk in sorted(os.listdir(os.path.join(REPO, 'skills'))):
        if not os.path.isfile(os.path.join(REPO, 'skills', sk, 'SKILL.md')):
            continue
        print(f'  {sk}: {freq.get(sk, 0)}' + ('   <-- never invoked' if not freq.get(sk) else ''))


def preflight():
    print('\n== Delivery preflight ==')
    problems = 0
    repo_ver = json.load(open(os.path.join(REPO, '.claude-plugin', 'plugin.json')))['version']
    print(f'  repo plugin.json: {repo_ver}')
    for p in glob.glob(os.path.expanduser(
            '~/.claude/plugins/marketplaces/*/.claude-plugin/plugin.json')):
        v = json.load(open(p)).get('version')
        if 'agent-kit' in p and v != repo_ver:
            print(f'  DRIFT: {p} at {v}')
            problems += 1
    for f in glob.glob(os.path.join(REPO, 'skills', '*', 'SKILL.md')):
        with open(f) as fh:
            text = fh.read()
        m = re.search(r'^description:\s*(.+)$', text, re.M)
        if m:
            val = m.group(1).strip()
            if not val.startswith(("'", '"')) and ': ' in val:
                print(f'  FRONTMATTER: unquoted colon in description — {f}')
                problems += 1
    print(f'  {"OK" if not problems else f"{problems} problem(s)"}')
    return problems


if __name__ == '__main__':
    sessions = scan_sessions()
    report_coverage(sessions)
    sys.exit(1 if preflight() else 0)
