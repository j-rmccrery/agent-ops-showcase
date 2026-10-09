// Case loading and repo resolution for tools/eval-run.mjs. Zero deps.
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { readJson } from './eval-lib.mjs';

// 'skill' is not a valid case.json kind: skill cases only come from loadSkillCases.
const KINDS = new Set(['implement', 'review']);

export function loadCase(dir) {
  const c = readJson(join(dir, 'case.json'));
  for (const k of ['id', 'kind', 'repo', 'base']) if (!c[k]) throw new Error(`${dir}: case.json missing "${k}"`);
  if (!KINDS.has(c.kind)) throw new Error(`${dir}: unknown kind "${c.kind}"`);
  if (c.kind === 'implement' && !c.prompt_file) throw new Error(`${dir}: implement case needs prompt_file`);
  if (c.kind === 'review' && !c.seed_patch) throw new Error(`${dir}: review case needs seed_patch (the diff under review)`);
  return {
    ...c, dir,
    model: c.model ?? 'sonnet',
    skill: c.skill ?? null,
    seed_patch: c.seed_patch ?? null,
    prompt_file: c.prompt_file ?? null,
    hidden: c.hidden ?? [],
    judge: c.judge ?? [],
    deny: c.deny ?? [],
  };
}

export function loadTaskCases(root, { caseId } = {}) {
  const tasks = join(root, 'evals', 'tasks');
  if (!existsSync(tasks)) return [];
  return readdirSync(tasks)
    .filter((d) => existsSync(join(tasks, d, 'case.json')))
    .map((d) => loadCase(join(tasks, d)))
    .filter((c) => !caseId || c.id === caseId);
}

/** One skill eval entry becomes two cases: with the skill installed, and without (baseline). */
export function loadSkillCases(root, { caseId } = {}) {
  const skills = join(root, 'skills');
  if (!existsSync(skills)) return [];
  const out = [];
  for (const name of readdirSync(skills)) {
    const f = join(skills, name, 'evals', 'evals.json');
    if (!existsSync(f)) continue;
    const { evals = [] } = readJson(f);
    for (const e of evals) {
      if (e.id === undefined || e.id === null) throw new Error(`${f}: eval entry missing "id"`);
      if (typeof e.prompt !== 'string' || !e.prompt) throw new Error(`${f}: eval entry ${e.id} missing "prompt"`);
      if (!Array.isArray(e.assertions)) throw new Error(`${f}: eval entry ${e.id} missing "assertions"`);
      const slug = String(e.eval_name || e.id).toLowerCase().replace(/[^a-z0-9]+/g, '-');
      for (const withSkill of [true, false]) {
        out.push({
          id: `skill-${name}-${e.id}-${slug}-${withSkill ? 'withskill' : 'noskill'}`,
          kind: 'skill', dir: join(skills, name, 'evals'), repo: null, base: null,
          skill: withSkill ? name : null, withSkill, model: 'sonnet',
          prompt: e.prompt, prompt_file: null, seed_patch: null, hidden: [],
          judge: e.assertions ?? [], deny: [],
        });
      }
    }
  }
  return out.filter((c) => !caseId || c.id === caseId);
}

export function resolveRepo(fullName, root) {
  if (process.env.EVAL_REPOS_ROOT) return join(process.env.EVAL_REPOS_ROOT, fullName.split('/')[1]);
  const map = readJson(join(root, 'evals', 'repos.json'));
  if (!map[fullName]) throw new Error(`evals/repos.json has no entry for ${fullName}`);
  return map[fullName];
}
