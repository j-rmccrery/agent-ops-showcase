import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn as nodeSpawn } from 'node:child_process';
import { parseGatesFile, sh, quote, IS_WIN } from '../eval-lib.mjs';

test('parseGatesFile reads boxes, ids, titles, evidence', () => {
  const text = [
    '# Gates',
    '- [x] G1: lint clean',
    '  CHECK: npm run lint',
    '  EVIDENCE: 0 problems',
    '- [ ] G2: hidden test passes',
    '  CHECK: npx jest foo',
    '  EVIDENCE: pending',
    '- [x] G3: manual thing',
    '  EVIDENCE: pending',
  ].join('\n');
  const gates = parseGatesFile(text);
  assert.deepEqual(gates.map(g => g.id), ['G1', 'G2', 'G3']);
  assert.equal(gates[0].checked, true);
  assert.equal(gates[0].evidence, '0 problems');
  assert.equal(gates[0].title, 'lint clean');
  assert.equal(gates[1].checked, false);
  assert.equal(gates[2].checked, true);
  assert.equal(gates[2].evidence, 'pending');
  assert.equal(gates[2].met, false, 'checked but pending evidence is not met');
  assert.equal(gates[0].met, true);
});

test('sh captures stdout and exit code without throwing', async () => {
  const r = await sh('node -e "process.stdout.write(\'hi\'); process.exit(3)"');
  assert.equal(r.stdout, 'hi');
  assert.equal(r.code, 3);
  assert.equal(r.timedOut, false);
});

test('sh reports timeout', async () => {
  const r = await sh('node -e "setTimeout(()=>{}, 5000)"', { timeoutMs: 300 });
  assert.equal(r.timedOut, true);
});

// On POSIX, a shell -c "sleep 5 & wait" backgrounds sleep as a grandchild of the spawned
// shell; killing only the shell leaves sleep running and the process group's stdio open,
// so without process-group kill the promise would hang until sleep exits (~5s). Detached +
// kill(-pid) kills the whole group instead. Cannot run on this machine (Windows); CI's
// Ubuntu `node --test` step exercises it.
test('sh kills the whole process group on timeout (POSIX)', { skip: IS_WIN }, async () => {
  const t0 = Date.now();
  const r = await sh('sh -c "sleep 5 & wait"', { timeoutMs: 300 });
  assert.equal(r.timedOut, true);
  assert.ok(Date.now() - t0 < 1500, `expected the promise to resolve within ~1.5s, took ${Date.now() - t0}ms`);
});

test('quote wraps and escapes', () => {
  assert.equal(quote('a"b'), '"a\\"b"');
});

test('sh finds Git usr/bin tools on PATH (grep)', async () => {
  const r = await sh('grep --version');
  assert.equal(r.code, 0);
});

test('sh prepends Git usr/bin to child PATH and preserves the rest', { skip: !IS_WIN }, async () => {
  const r = await sh('node -e "process.stdout.write(process.env.PATH || process.env.Path || \'\')"');
  assert.ok(
    r.stdout.startsWith('C:\\Program Files\\Git\\usr\\bin;'),
    `expected child PATH to start with Git usr/bin, got: ${r.stdout.slice(0, 120)}`
  );
  const parentPath = process.env.PATH ?? process.env.Path ?? '';
  const parentEntry = parentPath.split(';').find(Boolean);
  if (parentEntry) {
    assert.ok(r.stdout.includes(parentEntry), 'expected an original PATH entry to survive the prepend');
  }
});

// Reproduces the bug where a parent process whose PATH lives under the
// case-variant key "Path" (typical of a process launched from PowerShell/cmd)
// got its real PATH dropped: {...process.env} is a plain object, so writing
// mergedEnv.PATH created a second, distinct key next to the original "Path"
// key, and Windows' spawn collapses same-name-different-case keys, keeping
// only one — silently discarding the original full PATH.
test('sh does not clobber PATH when the parent env carries it under "Path"', { skip: !IS_WIN }, async () => {
  const libUrl = new URL('../eval-lib.mjs', import.meta.url).href;
  const script = `(async () => {
    const { sh } = await import(${JSON.stringify(libUrl)});
    const r = await sh('node --version');
    process.stdout.write(JSON.stringify({ code: r.code, stdout: r.stdout.trim(), stderr: r.stderr.trim() }));
  })();`;
  const fullPath = process.env.PATH ?? process.env.Path ?? '';
  const childEnv = { ...process.env };
  delete childEnv.PATH;
  delete childEnv.Path;
  childEnv.Path = fullPath; // only PATH-like key the child process sees is "Path"

  const out = await new Promise((resolve, reject) => {
    const child = nodeSpawn(process.execPath, ['-e', script], { env: childEnv, windowsHide: true });
    let stdout = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.on('close', () => resolve(stdout));
    child.on('error', reject);
  });

  const result = JSON.parse(out);
  assert.equal(result.code, 0, `expected 'node --version' to succeed inside the child; got: ${JSON.stringify(result)}`);
});
