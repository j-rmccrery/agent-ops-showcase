#!/usr/bin/env python3
"""UserPromptSubmit: inject the routing table on every prompt so routing
survives mid-session pivots. Stdout becomes context. Kept short — this runs on
every user message."""
print(
    '[routing] Route by the task in front of you, not the session\'s first '
    'prompt — mid-session pivots re-route the same way. Before acting, invoke the '
    'owning skill via the Skill tool: '
    '"what\'s ready / knock off / cycle work" -> dispatch FIRST (it routes '
    'each ticket); Figma canvas -> design family; backend code or '
    'architecture -> be-lead; FE architecture -> fe-lead; writing '
    'tickets -> ticket; PR review -> code-review (separate session; '
    'merges need its verdict on the PR); product scope -> product-manager; '
    'Linear structure -> project-manager. Gates enforce Figma, BE edits, '
    'ticket creation, and merges; advisory domains rely on this table.')
