import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildPrompt, installSkill, writeDenySettings, runAgent } from '../eval-agent.mjs';

const STUB = `node ${JSON.stringify(join(import.meta.dirname, 'fixtures', 'claude-stub.mjs'))}`;

function scratch(p) { return mkdtempSync(join(tmpdir(), p)); }

test('buildPrompt: implement appends the working contract; review asks for review-output.md; skill is raw', () => {
  const dir = scratch('bp-');
  writeFileSync(join(dir, 'ticket.md'), '# PROJ-1\nDo it.');
  const imp = buildPrompt({ kind: 'implement', dir, prompt_file: 'ticket.md', repo: 'your-org/app', base: 'abc' });
  assert.match(imp, /# PROJ-1/);
  assert.match(imp, /Do not push/);
  assert.match(imp, /only source of truth/);
  const rev = buildPrompt({ kind: 'review', dir, prompt_file: 'ticket.md', repo: 'your-org/app', base: 'abc' });
  assert.match(rev, /git diff abc HEAD/);
  assert.match(rev, /review-output\.md/);
  assert.match(rev, /BLOCKER/);
  assert.match(rev, /only source of truth/);
  assert.equal(buildPrompt({ kind: 'skill', prompt: 'raw prompt' }), 'raw prompt');
});

test('installSkill copies skills/<name> into .claude/skills and restore removes it', () => {
  const root = scratch('root-');
  mkdirSync(join(root, 'skills', 'x'), { recursive: true });
  writeFileSync(join(root, 'skills', 'x', 'SKILL.md'), '---\nname: x\n---\n');
  const cwd = scratch('cwd-');
  const restore = installSkill({ skill: 'x' }, cwd, root);
  assert.ok(existsSync(join(cwd, '.claude', 'skills', 'x', 'SKILL.md')));
  restore();
  assert.ok(!existsSync(join(cwd, '.claude', 'skills')));
});

test('writeDenySettings merges into an existing tracked settings file and restores it', () => {
  const cwd = scratch('deny-');
  mkdirSync(join(cwd, '.claude'));
  writeFileSync(join(cwd, '.claude', 'settings.json'), JSON.stringify({
    permissions: { allow: ['mcp__Linear'] },
    enabledPlugins: { 'a@x': true, 'agent-kit@agent-context': true },
  }));
  const restore = writeDenySettings({ deny: ['sam ', 'eas '] }, cwd);
  const s = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(s.permissions.allow, ['mcp__Linear']);
  assert.ok(s.permissions.deny.includes('Bash(sam *)'));
  assert.ok(s.permissions.deny.includes('WebFetch'));
  assert.equal(s.enabledPlugins['a@x'], false);
  assert.equal(s.enabledPlugins['agent-kit@agent-context'], false);
  restore();
  const after = JSON.parse(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8'));
  assert.deepEqual(after, {
    permissions: { allow: ['mcp__Linear'] },
    enabledPlugins: { 'a@x': true, 'agent-kit@agent-context': true },
  });
});

test('runAgent invokes the binary in cwd, records meta, saves transcript', async () => {
  const prevBin = process.env.EVAL_CLAUDE_BIN;
  process.env.EVAL_CLAUDE_BIN = STUB;
  try {
    const root = scratch('root-');
    mkdirSync(join(root, 'skills', 'x'), { recursive: true });
    writeFileSync(join(root, 'skills', 'x', 'SKILL.md'), 'x');
    const cwd = scratch('run-');
    writeFileSync(join(cwd, 'a.txt'), 'one\n');
    const trialDir = scratch('trial-');
    const c = { id: 't', kind: 'implement', dir: cwd, prompt_file: 'a.txt', repo: 'r', base: 'b', model: 'sonnet', skill: 'x', deny: ['sam '] };
    const r = await runAgent(c, cwd, { root, trialDir, budgetUsd: 1, timeoutMs: 10000 });
    assert.equal(r.meta.exit, 0);
    assert.deepEqual(r.meta.model_reported, ['stub-sonnet']);
    assert.equal(r.meta.usd, 0.01);
    assert.match(r.resultText, /skill dir present: true/);
    assert.equal(readFileSync(join(cwd, 'a.txt'), 'utf8'), 'agent-edited\n');
    assert.ok(existsSync(join(trialDir, 'transcript.json')));
    assert.ok(!existsSync(join(cwd, '.claude', 'skills')), 'skill removed after run');
    assert.ok(!existsSync(join(cwd, '.claude', 'settings.json')), 'settings removed when it did not exist before');
    assert.ok(!existsSync(join(cwd, '.eval-prompt.md')));
    const stubArgs = readFileSync(join(cwd, 'stub-args.txt'), 'utf8');
    assert.match(stubArgs, /--disallowed-tools/);
    assert.match(stubArgs, /Bash\(sam \*\)/);
    assert.match(stubArgs, /--setting-sources project/);
    assert.match(stubArgs, /--strict-mcp-config/);
    assert.match(stubArgs, /--max-turns 60/);
  } finally {
    if (prevBin === undefined) delete process.env.EVAL_CLAUDE_BIN;
    else process.env.EVAL_CLAUDE_BIN = prevBin;
  }
});

test('runAgent leaves no trace when buildPrompt fails before any mutation', async () => {
  const prevBin = process.env.EVAL_CLAUDE_BIN;
  process.env.EVAL_CLAUDE_BIN = STUB;
  try {
    const root = scratch('root-');
    mkdirSync(join(root, 'skills', 'x'), { recursive: true });
    writeFileSync(join(root, 'skills', 'x', 'SKILL.md'), 'x');
    const cwd = scratch('run-');
    mkdirSync(join(cwd, '.claude'));
    const settingsBefore = JSON.stringify({ permissions: { allow: ['mcp__Linear'] } });
    writeFileSync(join(cwd, '.claude', 'settings.json'), settingsBefore);
    const trialDir = scratch('trial-');
    // No a.txt written: prompt_file does not exist.
    const c = { id: 't', kind: 'implement', dir: cwd, prompt_file: 'missing.txt', repo: 'r', base: 'b', model: 'sonnet', skill: 'x', deny: ['sam '] };
    await assert.rejects(() => runAgent(c, cwd, { root, trialDir, budgetUsd: 1, timeoutMs: 10000 }));
    assert.ok(!existsSync(join(cwd, '.claude', 'skills')), 'skill never installed');
    assert.equal(readFileSync(join(cwd, '.claude', 'settings.json'), 'utf8'), settingsBefore, 'settings untouched');
  } finally {
    if (prevBin === undefined) delete process.env.EVAL_CLAUDE_BIN;
    else process.env.EVAL_CLAUDE_BIN = prevBin;
  }
});
