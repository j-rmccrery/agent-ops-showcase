// Shared helpers for tools/eval-run.mjs and tools/eval-report.mjs. Zero deps.
import { spawn } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const HERE = dirname(fileURLToPath(import.meta.url));
export const IS_WIN = process.platform === 'win32';

// On Windows, spawn(shell:true) runs cmd.exe, whose PATH may lack Git's
// grep/wc that GATES.md CHECK commands rely on. Prepend Git's usr/bin if present.
const GIT_USR_BIN = 'C:\\Program Files\\Git\\usr\\bin';
const WIN_PATH_PREFIX = IS_WIN && existsSync(GIT_USR_BIN) ? GIT_USR_BIN + ';' : '';

/** Run a shell command. Never throws on non-zero exit. Same contract as agent-loop's sh(). */
export function sh(cmd, { cwd, timeoutMs, env } = {}) {
  return new Promise((res) => {
    const mergedEnv = { ...process.env, ...env };
    if (WIN_PATH_PREFIX) {
      // Windows env keys are case-insensitive; the actual key can be PATH, Path, or path
      // depending on what launched this process. Writing a fresh "PATH" here would leave
      // the original key in place and spawn's case-insensitive dedupe would silently drop
      // one of them, clobbering the real PATH.
      const k = Object.keys(mergedEnv).find((k) => k.toUpperCase() === 'PATH') || 'PATH';
      mergedEnv[k] = WIN_PATH_PREFIX + (mergedEnv[k] || '');
    }
    // detached on POSIX puts the child in its own process group, so a timeout can SIGKILL the
    // whole group (-pid) instead of just the shell -- otherwise grandchildren (e.g. a "sleep &
    // wait" inside the shell -c) survive the kill and the promise never settles.
    const child = spawn(cmd, { cwd, shell: true, windowsHide: true, env: mergedEnv, detached: !IS_WIN });
    let stdout = '', stderr = '', timedOut = false, timer = null;
    if (timeoutMs) {
      timer = setTimeout(() => {
        timedOut = true;
        if (IS_WIN) spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { windowsHide: true });
        else { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }
      }, timeoutMs);
    }
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    child.on('close', (code) => { if (timer) clearTimeout(timer); res({ code, stdout, stderr, timedOut }); });
    child.on('error', (e) => { if (timer) clearTimeout(timer); res({ code: -1, stdout, stderr: String(e), timedOut }); });
  });
}

export const ok = (r) => r.code === 0;
export const quote = (s) => `"${String(s).replace(/"/g, '\\"')}"`;
export const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

const GATE_RE = /^- \[( |x|X)\] (.*)$/;
const ATTR_RE = /^\s+(CHECK|EXPECT|EVIDENCE):\s?(.*)$/;

/** Parse a GATES.md (unlazy format) into gate records. Mirrors gate-check.mjs's parser. */
export function parseGatesFile(text) {
  const gates = [];
  let cur = null;
  text.split(/\r?\n/).forEach((line, i) => {
    const g = line.match(GATE_RE);
    if (g) {
      const id = (g[2].match(/^(\S+?):/) || [null, `line${i + 1}`])[1];
      cur = { id, title: g[2].trim().replace(/^\S+?:\s*/, ''), checked: g[1].toLowerCase() === 'x', check: null, expect: null, evidence: null };
      gates.push(cur);
      return;
    }
    const a = cur && line.match(ATTR_RE);
    if (a) { cur[a[1].toLowerCase()] = a[2].trim(); return; }
    if (/^#|^- /.test(line)) cur = null;
  });
  for (const g of gates) g.met = g.checked && !!g.evidence && !/^pending$/i.test(g.evidence);
  return gates;
}
