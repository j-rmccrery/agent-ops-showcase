import { existsSync, lstatSync, mkdirSync, readdirSync, rmdirSync, symlinkSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { sh, ok, quote, IS_WIN } from './eval-lib.mjs';

const nmCount = (repoPath) => existsSync(join(repoPath, 'node_modules')) ? readdirSync(join(repoPath, 'node_modules')).length : 0;

// rmdirSync only removes a Windows junction. On POSIX a symlink is a regular
// file to rmdir, which throws ENOTDIR — unlinkSync is the POSIX equivalent.
const unlinkLink = (p) => { if (existsSync(p) && lstatSync(p).isSymbolicLink()) (IS_WIN ? rmdirSync : unlinkSync)(p); };

export function linkNodeModules(from, to) {
  // Windows: a junction needs no admin rights; lstat reports it as a symlink, and rmdir removes only the link.
  symlinkSync(from, to, IS_WIN ? 'junction' : 'dir');
}

export async function prepareWorktree(c, { repoPath, workRoot, trial }) {
  const path = join(workRoot, `${c.id}-t${trial}`);
  if (existsSync(path)) await cleanupWorktree({ path, repoPath, nmCountBefore: nmCount(repoPath) });
  mkdirSync(workRoot, { recursive: true });

  // Quoted: on Windows, sh() runs via cmd.exe, where a bare ^ is its own escape
  // char and silently eats the literal "^{commit}" suffix (confirmed 2026-09-02).
  const have = await sh(`git cat-file -e ${quote(c.base + '^{commit}')}`, { cwd: repoPath });
  if (!ok(have)) throw new Error(`${c.id}: base ${c.base} not found in ${repoPath} (git fetch?)`);

  const add = await sh(`git worktree add --detach ${quote(path)} ${c.base}`, { cwd: repoPath });
  if (!ok(add)) throw new Error(`${c.id}: worktree add failed: ${add.stderr.trim()}`);

  const nmCountBefore = nmCount(repoPath);
  try {
    // Seed patch applies before node_modules is linked/installed: in a repo
    // that doesn't .gitignore node_modules (e.g. this module's own tests),
    // `git add -A` after linking would stage straight through the junction.
    if (c.seed_patch) {
      const ap = await sh(`git apply ${quote(join(c.dir, c.seed_patch))}`, { cwd: path });
      if (!ok(ap)) throw new Error(`${c.id}: seed patch failed: ${ap.stderr.trim()}`);
      // --no-verify: a worktree shares the main clone's hooks, and node_modules isn't linked yet at this point.
      const cm = await sh('git add -A && git -c user.name=eval -c user.email=eval@example.com commit -qm "eval: diff under review" --no-verify', { cwd: path });
      if (!ok(cm)) throw new Error(`${c.id}: seed commit failed: ${cm.stderr.trim()}`);
    }

    if (process.env.EVAL_INSTALL === 'ci') {
      const ci = await sh('npm ci --no-audit --no-fund', { cwd: path, timeoutMs: 15 * 60 * 1000 });
      if (!ok(ci)) throw new Error(`${c.id}: npm ci failed: ${ci.stderr.slice(-500)}`);
    } else if (existsSync(join(repoPath, 'node_modules'))) {
      linkNodeModules(join(repoPath, 'node_modules'), join(path, 'node_modules'));
    }
  } catch (e) {
    // Don't leave a registered worktree + junction behind on failure — the
    // exact hazard this module exists to contain. Cleanup failure must not
    // mask the original cause; attach it and rethrow the original error.
    try { await cleanupWorktree({ path, repoPath, nmCountBefore }); }
    catch (ce) { e.cleanupError = ce; }
    throw e;
  }
  return { path, repoPath, nmCountBefore };
}

export async function cleanupWorktree(wt) {
  const nm = join(wt.path, 'node_modules');
  // Junction/symlink first. `git worktree remove --force` follows a junction and empties the main clone (seen twice 2026-09-01).
  unlinkLink(nm);
  const rm = await sh(`git worktree remove --force ${quote(wt.path)}`, { cwd: wt.repoPath });
  if (!ok(rm)) {
    // Windows long paths defeat worktree remove (agent-loop field notes). Fall back to rm + prune.
    unlinkLink(nm);
    rmSync(wt.path, { recursive: true, force: true });
    await sh('git worktree prune', { cwd: wt.repoPath });
  }
  const after = nmCount(wt.repoPath);
  if (after < wt.nmCountBefore) throw new Error(`cleanup shrank ${wt.repoPath}/node_modules from ${wt.nmCountBefore} to ${after} entries — junction hazard`);
}
