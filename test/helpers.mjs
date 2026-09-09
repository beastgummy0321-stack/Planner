import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

export const PLUGIN = path.resolve(import.meta.dirname, '..');
const HARNESS = path.join(PLUGIN, 'bin', 'harness.mjs');

export function tmpRepo() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'harness-'));
  const g = (...a) => execFileSync('git', a, { cwd: dir, stdio: 'pipe' });
  g('init', '-q', '-b', 'main');
  g('config', 'user.email', 't@t');
  g('config', 'user.name', 't');
  fs.mkdirSync(path.join(dir, 'src/modules/identity'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src/modules/billing'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src/app'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'src/modules/identity/index.ts'), 'export const a = 1;\n');
  fs.writeFileSync(path.join(dir, 'src/modules/billing/index.ts'), 'export const b = 1;\n');
  fs.writeFileSync(path.join(dir, 'src/app/main.ts'), '');
  fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"t","version":"0.0.0","scripts":{"test":"node -e 0"}}\n');
  g('add', '.');
  g('commit', '-qm', 'init');
  return dir;
}

export function harness(cwd, ...args) {
  const r = spawnSync(process.execPath, [HARNESS, ...args], { cwd, encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN } });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

export function hook(name, input, cwd) {
  const r = spawnSync(process.execPath, [path.join(PLUGIN, 'hooks', `${name}.mjs`)], {
    cwd, input: JSON.stringify(input), encoding: 'utf8', env: { ...process.env, CLAUDE_PLUGIN_ROOT: PLUGIN },
  });
  let json = null;
  try { json = JSON.parse(r.stdout); } catch {}
  return { code: r.status, out: r.stdout, err: r.stderr, json, denied: json?.hookSpecificOutput?.permissionDecision === 'deny', reason: json?.hookSpecificOutput?.permissionDecisionReason || '' };
}

export function userTyped(cwd, prompt, session = 's1') {
  return hook('prompt', { cwd, prompt, session_id: session }, cwd);
}

export function setMode(cwd, m, { challenge = true } = {}) {
  // entering work requires an Independent Challenge dispatched during plan mode; simulate the dispatch through the real gate hook
  if (m === 'work' && challenge) challengerDispatched(cwd);
  userTyped(cwd, `/${{ grill: 'dig', plan: 'carve', work: 'crank' }[m]}`);
  const r = harness(cwd, 'mode', m);
  if (r.code !== 0) throw new Error(r.err);
}
// dispatch through the PreToolUse gate and, unless told otherwise, return through PostToolUse with a verdict — a dispatch alone is not a review
export function challengerDispatched(cwd, prompt = 'Challenge this draft: contradiction, missing assumption, simpler route, execution trap.', { complete = true, verdict = 'CLEAR' } = {}) {
  const tool_input = { subagent_type: 'harness:challenger', prompt };
  const r = hook('gate', { cwd, tool_name: 'Agent', tool_input, tool_use_id: 'ch1' }, cwd);
  if (complete && !r.denied) hook('post', { cwd, tool_name: 'Agent', tool_input, tool_use_id: 'ch1', tool_response: `${verdict}
1. Contradiction: none.` }, cwd);
  return r;
}

export function writeIssue(cwd, dir, data, body = '# Objective\nx\n# Done\ny\n# Verify\nz\n# Blocked if\nw\n') {
  const file = path.join(cwd, '.work', dir, `${data.id}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `---\n${JSON.stringify(data)}\n---\n${body}`);
  return file;
}

export const ISSUE = (over = {}) => ({
  id: 'F01-T01-I01', feature: 'F01', ticket: 'T01', after: [],
  touch: ['src/modules/identity/**'], do_not_touch: ['src/modules/billing/**'],
  verify: ['npm test'], privileged: [], interface_change: false, review: 'none', ...over,
});

export const MANIFEST = () => ({
  harness: 1, stack: 'ts', app_shell: ['src/app/**'],
  modules: {
    identity: { root: 'src/modules/identity', public: 'src/modules/identity/index.ts', may_depend_on: [], owns: ['src/modules/identity/**'] },
    billing: { root: 'src/modules/billing', public: 'src/modules/billing/index.ts', may_depend_on: ['identity'], owns: ['src/modules/billing/**'] },
  },
  resources: {},
  verify: { test: 'npm test' },
  checker: { command: 'npm run check:architecture' },
});

export function writeManifest(cwd, m = MANIFEST(), body = '\n# Architecture\ncurrent truth\n') {
  fs.writeFileSync(path.join(cwd, 'ARCHITECTURE.md'), `---\n${JSON.stringify(m, null, 2)}\n---\n${body}`);
}

export function addWorktree(cwd, name) {
  const wt = path.join(cwd, '.harness', 'worktrees', name);
  execFileSync('git', ['worktree', 'add', '-q', '-b', `harness/${name}`, wt], { cwd, stdio: 'pipe' });
  return wt.replace(/\\/g, '/');
}
