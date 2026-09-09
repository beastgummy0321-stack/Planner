// Scenarios 17–29 from the third-round stress test: holes that only real use hits (greenfield, model reflexes,
// side doors, false-positive ownership, a challenger that never returns, a session that dies mid-issue,
// privileged re-runs, self-asserted review, smoke pollution, prompt regex, checker reuse, package managers).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpRepo, harness, hook, userTyped, setMode, challengerDispatched, writeIssue, ISSUE, writeManifest, MANIFEST, PLUGIN } from './helpers.mjs';
import { planAdapter, envCommands } from '../lib/adapters.mjs';

const g = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
const B = (cwd, command, extra = {}) => hook('gate', { cwd, tool_name: 'Bash', tool_input: { command }, tool_use_id: extra.tool_use_id || 'b1', ...extra }, cwd);
const CLI = `node "${PLUGIN.replace(/\\/g, '/')}/bin/harness.mjs"`;
const ticket = (r, data, body = '# Outcome\nx\n# Acceptance\ny\n') => {
  fs.mkdirSync(path.join(r, '.work/tickets'), { recursive: true });
  fs.writeFileSync(path.join(r, `.work/tickets/${data.id}.md`), `---\n${JSON.stringify({ feature: data.id.slice(0, 3), title: 't', verify: [], closed: false, ...data })}\n---\n${body}`);
};
function workReady(r, extraManifest = {}) {
  harness(r, 'init');
  writeManifest(r, { ...MANIFEST(), checker: { command: 'node -e 0' }, ...extraManifest });
  g(r, 'add', '-A'); g(r, 'commit', '-qm', 'arch');
  setMode(r, 'plan'); ticket(r, { id: 'F01-T01' }); setMode(r, 'work');
}
function workerDoes(r, id, edit) {
  assert.equal(harness(r, 'claim', id).code, 0, harness(r, 'claim', id).err);
  const wt = path.join(r, '.claude/worktrees', id);
  g(r, 'worktree', 'add', '-q', '-b', `wt-${id}`, wt);
  assert.equal(harness(wt, 'attach', id).code, 0);
  edit(wt);
  return wt;
}
const clean = (r) => g(r, 'status', '--porcelain').split('\n').filter(Boolean).filter((l) => !l.includes('.work/'));

test('scenario 17: a module declared in /carve before it exists — plan and first issue succeed, feature close waits for it', { timeout: 120000 }, () => {
  const r = tmpRepo();
  const m = { ...MANIFEST(), checker: { command: 'node -e 0' } };
  m.modules.notify = { root: 'src/modules/notify', public: 'src/modules/notify/index.ts', may_depend_on: ['identity'], owns: ['src/modules/notify/**'] };
  m.modules.audit = { root: 'src/modules/audit', public: 'src/modules/audit/index.ts', may_depend_on: [], owns: ['src/modules/audit/**'] };
  workReady(r, m);
  assert.equal(harness(r, 'validate').code, 0, harness(r, 'validate').out); // desired topology is valid before it is real
  writeIssue(r, 'ready', ISSUE({ touch: ['src/modules/notify/**'], do_not_touch: [] }));
  workerDoes(r, 'F01-T01-I01', (wt) => { fs.mkdirSync(path.join(wt, 'src/modules/notify'), { recursive: true }); fs.writeFileSync(path.join(wt, 'src/modules/notify/index.ts'), 'export const n = 1;\n'); });
  assert.equal(harness(r, 'finish', 'F01-T01-I01').code, 0, harness(r, 'finish', 'F01-T01-I01').out);
  assert.equal(harness(r, 'merge', 'F01-T01-I01').code, 0);
  assert.ok(fs.existsSync(path.join(r, 'src/modules/notify/index.ts')));
  assert.equal(harness(r, 'integrate', 'ticket', 'F01-T01').code, 0);
  assert.equal(harness(r, 'close', 'ticket', 'F01-T01').code, 0);
  const feat = harness(r, 'integrate', 'feature', 'F01');
  assert.equal(feat.code, 1); assert.match(feat.out, /not materialized[\s\S]*audit/); // audit was declared and never built
  // a repo with no module root at all: the checker is not red for inspecting nothing, it is explicitly greenfield
  const r2 = tmpRepo(); fs.rmSync(path.join(r2, 'src'), { recursive: true }); g(r2, 'add', '-A'); g(r2, 'commit', '-qm', 'empty');
  harness(r2, 'init'); writeManifest(r2, { ...MANIFEST(), checker: { command: 'node -e "process.exit(1)"' } });
  const c = harness(r2, 'adapter', 'check');
  assert.equal(c.code, 0); assert.match(c.out, /greenfield/);
});

test('scenario 18: a destructive command in the main conversation is denied before it runs; work mode is harness + read-only git', () => {
  const r = tmpRepo(); harness(r, 'init');
  for (const cmd of ['git reset --hard HEAD~1', 'git clean -fd', 'git checkout -- src', 'rm -rf src', 'npm install zod', 'pip install requests', 'git push --force origin main']) {
    const d = B(r, cmd); assert.equal(d.denied, true, cmd); assert.match(d.reason, /destructive/);
  }
  assert.equal(B(r, 'git log --oneline -5').denied, false);
  assert.equal(B(r, 'node .harness/scratch/probes/bench/run.mjs').denied, false);
  assert.ok(fs.existsSync(path.join(r, 'src/modules/identity/index.ts')), 'nothing was destroyed');
  writeManifest(r); setMode(r, 'plan'); setMode(r, 'work');
  const d = B(r, 'npm test'); assert.equal(d.denied, true); assert.match(d.reason, /work mode/);
  assert.equal(B(r, `${CLI} queue next`).denied, false);
  assert.equal(B(r, 'git status --porcelain').denied, false);
  assert.equal(B(r, 'sed -n 1,10p .harness/runtime/logs/x.log', { agent_type: 'harness:utility', agent_id: 'u1' }).denied, false);
  assert.equal(B(r, 'git reset --hard', { agent_type: 'harness:utility', agent_id: 'u1' }).denied, true);
});

test('scenario 20 (ts): ownership is a binding, not a word — local `payments` is green, importing the table is red, dynamic supabase target is red', () => {
  const r = tmpRepo();
  fs.writeFileSync(path.join(r, 'src/modules/billing/schema.ts'), "export const payments = 'payments';\n");
  const m = MANIFEST();
  m.resources = {
    payments: { owner: 'billing', kind: 'drizzle-table', definition: ['src/modules/billing/schema.ts'], symbol: 'payments' },
    profiles: { owner: 'identity', kind: 'supabase-table', definition: ['supabase/migrations/**'], symbol: 'profiles' },
  };
  writeManifest(r, m);
  const run = () => spawnSync(process.execPath, [path.join(PLUGIN, 'adapters/ts/check_ownership.mjs'), r], { encoding: 'utf8' });
  const put = (f, s) => fs.writeFileSync(path.join(r, f), s);
  put('src/modules/identity/a.ts', 'const payments = [];\nexport const total = payments.length;\n'); // 20A
  put('src/modules/billing/e.ts', "export const xs = Array.from(new Set([1]));\nexport const b = Buffer.from('x');\n");
  let res = run(); assert.equal(res.status, 0, res.stdout);
  put('src/modules/identity/b.ts', "import { payments } from '../billing/schema';\nexport const p = payments;\n"); // 20B
  res = run(); assert.equal(res.status, 1); assert.match(res.stdout, /identity\/b\.ts:1: identity accesses resource payments owned by billing/);
  fs.rmSync(path.join(r, 'src/modules/identity/b.ts'));
  put('src/modules/identity/c.ts', "import { payments as p } from '@/modules/billing/schema';\nexport const q = p;\n"); // aliased path
  res = run(); assert.equal(res.status, 1, res.stdout); fs.rmSync(path.join(r, 'src/modules/identity/c.ts'));
  put('src/modules/billing/d.ts', "const t = 'profiles';\nexport const q = (sb) => sb.from(t).select();\n"); // 20C
  res = run(); assert.equal(res.status, 1); assert.match(res.stdout, /non-literal target/);
  fs.rmSync(path.join(r, 'src/modules/billing/d.ts'));
  put('src/modules/billing/f.ts', "export const q = (sb) => sb.from('profiles').select();\n");
  res = run(); assert.equal(res.status, 1); assert.match(res.stdout, /billing accesses resource profiles owned by identity/);
});

test('scenario 20 (python): same — local name green, definition import red, dynamic target red', () => {
  const r = tmpRepo();
  for (const d of ['pkg/identity', 'pkg/billing', 'pkg/app']) fs.mkdirSync(path.join(r, d), { recursive: true });
  fs.writeFileSync(path.join(r, 'pkg/__init__.py'), '');
  fs.writeFileSync(path.join(r, 'pkg/identity/__init__.py'), '');
  fs.writeFileSync(path.join(r, 'pkg/billing/__init__.py'), '');
  fs.writeFileSync(path.join(r, 'pkg/billing/models.py'), 'class Invoice: pass\n');
  fs.writeFileSync(path.join(r, 'pkg/app/__init__.py'), '');
  writeManifest(r, {
    harness: 1, stack: 'python', app_shell: ['pkg/app/**'],
    modules: {
      identity: { root: 'pkg/identity', public: 'pkg/identity/__init__.py', may_depend_on: [], owns: ['pkg/identity/**'] },
      billing: { root: 'pkg/billing', public: 'pkg/billing/__init__.py', may_depend_on: ['identity'], owns: ['pkg/billing/**'] },
    },
    resources: {
      invoices: { owner: 'billing', kind: 'sqlalchemy-model', definition: ['pkg/billing/models.py'], symbol: 'Invoice' },
      profiles: { owner: 'identity', kind: 'supabase-table', definition: ['supabase/migrations/**'], symbol: 'profiles' },
    },
    verify: { test: 'python -c 0' }, checker: { command: 'x' },
  });
  const run = () => spawnSync('python', [path.join(PLUGIN, 'adapters/python/check_architecture.py'), r], { encoding: 'utf8' });
  const put = (f, s) => fs.writeFileSync(path.join(r, f), s);
  put('pkg/identity/a.py', 'Invoice = "local name"\nprint(Invoice)\n');
  let res = run(); assert.equal(res.status, 0, res.stdout);
  put('pkg/identity/b.py', 'from pkg.billing.models import Invoice\n');
  res = run(); assert.ok(res.status >= 1); assert.match(res.stdout, /identity\/b\.py:1: identity accesses resource invoices owned by billing/); // plus may_depend_on + internals violations, correctly
  fs.rmSync(path.join(r, 'pkg/identity/b.py'));
  put('pkg/billing/c.py', 'def q(c, name):\n    return c.table(name).select("*")\n');
  res = run(); assert.equal(res.status, 1); assert.match(res.stdout, /non-literal target/);
});

test('scenario 21+22: a dispatched challenger that never returns is not a review; a CLEAR covers only the plan it read', () => {
  const r = tmpRepo(); harness(r, 'init'); writeManifest(r); setMode(r, 'plan');
  challengerDispatched(r, undefined, { complete: false });
  userTyped(r, '/crank');
  let w = harness(r, 'mode', 'work'); assert.equal(w.code, 1); assert.match(w.err, /never returned/);
  challengerDispatched(r); // came back: CLEAR
  userTyped(r, '/crank'); w = harness(r, 'mode', 'work'); assert.equal(w.code, 0, w.err);
  // 22: plan edited after CLEAR
  setMode(r, 'plan'); challengerDispatched(r);
  writeManifest(r, MANIFEST(), '\n# Architecture\nquietly changed after the review\n');
  userTyped(r, '/crank'); w = harness(r, 'mode', 'work'); assert.equal(w.code, 1); assert.match(w.err, /changed after the challenger said CLEAR/);
  // a CHALLENGE expects one planner fix round, so a changed plan is allowed there
  challengerDispatched(r, undefined, { verdict: 'CHALLENGE' });
  writeManifest(r, MANIFEST(), '\n# Architecture\nfixed after the challenge\n');
  userTyped(r, '/crank'); assert.equal(harness(r, 'mode', 'work').code, 0);
});

test('scenario 23: the session dies after attach + partial edit — the next /crank recovers: diff saved, issue re-queued, no deadlock, no identical-retry refusal', { timeout: 120000 }, () => {
  const r = tmpRepo(); workReady(r);
  writeIssue(r, 'ready', ISSUE());
  const wt = workerDoes(r, 'F01-T01-I01', (w) => fs.writeFileSync(path.join(w, 'src/modules/identity/half.ts'), 'export const half = 1; // unfinished\n'));
  // same session: nothing to recover, the lease stays
  userTyped(r, '/crank', 's1'); assert.equal(harness(r, 'mode', 'work').code, 0);
  assert.ok(fs.existsSync(path.join(r, '.harness/runtime/leases/F01-T01-I01.json')));
  // new session
  userTyped(r, '/crank', 's2');
  const w = harness(r, 'mode', 'work');
  assert.equal(w.code, 0, w.err); assert.match(w.out, /recovered F01-T01-I01.*partial diff saved/);
  assert.ok(fs.existsSync(path.join(r, '.work/ready/F01-T01-I01.md')));
  assert.ok(!fs.existsSync(path.join(r, '.harness/runtime/leases/F01-T01-I01.json')));
  assert.ok(!fs.existsSync(wt), 'worktree discarded');
  const logs = fs.readdirSync(path.join(r, '.harness/runtime/logs')).filter((f) => /recovered/.test(f));
  assert.equal(logs.length, 1);
  assert.match(fs.readFileSync(path.join(r, '.harness/runtime/logs', logs[0]), 'utf8'), /half\.ts/);
  assert.equal(JSON.parse(harness(r, 'queue', 'next').out).claimable[0], 'F01-T01-I01');
  assert.equal(harness(r, 'claim', 'F01-T01-I01').code, 0, 'a lost session is not a blocked issue');
  // release also frees the worktree, not only the lease
  const wt2 = path.join(r, '.claude/worktrees/F01-T01-I01'); g(r, 'worktree', 'add', '-q', '-b', 'wt-2', wt2); harness(wt2, 'attach', 'F01-T01-I01');
  assert.equal(harness(r, 'release', 'F01-T01-I01').code, 0);
  assert.ok(!fs.existsSync(wt2));
});

test('scenario 24: a privileged command runs once, by the worker; finish re-runs only verify', { timeout: 120000 }, () => {
  const r = tmpRepo(); workReady(r);
  const marker = path.join(os.tmpdir(), `harness-priv-${Date.now()}.txt`).replace(/\\/g, '/');
  const priv = `node -e "require('fs').appendFileSync('${marker}','x')"`;
  writeIssue(r, 'ready', ISSUE({ verify: ['npm test'], privileged: [priv] }));
  workerDoes(r, 'F01-T01-I01', (wt) => {
    fs.writeFileSync(path.join(wt, 'src/modules/identity/gen.ts'), 'export const gen = 1;\n');
    assert.equal(B(wt, priv, { agent_id: 'a1', agent_type: 'harness:worker' }).denied, false);
    spawnSync(priv, { cwd: wt, shell: true });
  });
  assert.equal(fs.readFileSync(marker, 'utf8'), 'x');
  const fin = harness(r, 'finish', 'F01-T01-I01');
  assert.equal(fin.code, 0, fin.out);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'x', 'finish did not re-run the generator');
  assert.ok(JSON.parse(fin.out).steps.some((s) => s.step === 'verify: npm test'));
  fs.rmSync(marker);
});

test('scenario 25: planner review is a hook-signed receipt for the exact head — the control plane cannot approve', { timeout: 120000 }, () => {
  const r = tmpRepo(); workReady(r);
  writeIssue(r, 'ready', ISSUE({ interface_change: true, review: 'planner' }));
  const wt = workerDoes(r, 'F01-T01-I01', (w) => fs.writeFileSync(path.join(w, 'src/modules/identity/api.ts'), 'export const api = 1;\n'));
  assert.equal(harness(r, 'finish', 'F01-T01-I01').code, 0);
  let m = harness(r, 'merge', 'F01-T01-I01'); assert.equal(m.code, 1); assert.match(m.err, /needs planner review/);
  const cmd = `${CLI} review F01-T01-I01 approve`;
  // the control plane typing the same command: no receipt
  assert.equal(B(r, cmd).denied, false);
  assert.equal(harness(r, 'review', 'F01-T01-I01', 'approve').code, 1);
  assert.equal(harness(r, 'merge', 'F01-T01-I01').code, 1);
  // the planner agent running it: receipt for the current head
  assert.equal(B(r, cmd, { agent_type: 'harness:planner', agent_id: 'p1' }).denied, false);
  const rv = harness(r, 'review', 'F01-T01-I01', 'approve'); assert.equal(rv.code, 0, rv.err); assert.match(rv.out, /harness:planner/);
  // the worker adds a commit after the review: receipt no longer matches
  fs.writeFileSync(path.join(wt, 'src/modules/identity/api.ts'), 'export const api = 2;\n');
  assert.equal(harness(r, 'finish', 'F01-T01-I01').code, 0);
  m = harness(r, 'merge', 'F01-T01-I01'); assert.equal(m.code, 1); assert.match(m.err, /review receipt is for/);
  assert.equal(B(r, cmd, { agent_type: 'harness:planner', agent_id: 'p1' }).denied, false);
  assert.equal(harness(r, 'merge', 'F01-T01-I01').code, 0);
});

test('scenario 26: smoke that passes but writes a cache file leaves the main tree clean; acceptance commands that dirty it are red', { timeout: 120000 }, () => {
  const r = tmpRepo(); workReady(r, { verify: { test: 'npm test', smoke: `node -e "require('fs').writeFileSync('smoke.cache','x')"` } });
  writeIssue(r, 'ready', ISSUE({ verify: ['npm test'] }));
  workerDoes(r, 'F01-T01-I01', (wt) => fs.writeFileSync(path.join(wt, 'src/modules/identity/s.ts'), 'export const s = 1;\n'));
  assert.equal(harness(r, 'finish', 'F01-T01-I01').code, 0);
  const m = harness(r, 'merge', 'F01-T01-I01'); assert.equal(m.code, 0, m.err + m.out);
  assert.ok(!fs.existsSync(path.join(r, 'smoke.cache')), 'smoke ran in the worktree, not the main tree');
  assert.deepEqual(clean(r), []);
  ticket(r, { id: 'F01-T01', runtime: [`node -e "require('fs').writeFileSync('shot.png','x')"`] });
  const it = harness(r, 'integrate', 'ticket', 'F01-T01');
  assert.equal(it.code, 1); assert.match(it.out, /dirtied the main tree: shot\.png/);
  fs.rmSync(path.join(r, 'shot.png'));
});

test('scenario 27: "先不要 /carve" is not /carve', () => {
  const r = tmpRepo(); harness(r, 'init');
  userTyped(r, '先不要 /carve，我還想再聊一下');
  assert.equal(harness(r, 'mode', 'plan').code, 1);
  userTyped(r, 'do not /carve yet');
  assert.equal(harness(r, 'mode', 'plan').code, 1);
  userTyped(r, '/carve');
  assert.equal(harness(r, 'mode', 'plan').code, 0);
});

test('scenario 28: an existing check:architecture script is composed with, never overwritten', () => {
  const r = tmpRepo();
  fs.writeFileSync(path.join(r, 'package.json'), '{"name":"t","version":"0.0.0","scripts":{"test":"node -e 0","check:architecture":"eslint --rule import/no-cycle"}}\n');
  harness(r, 'init'); writeManifest(r);
  const plan = planAdapter(r);
  assert.equal(plan.scriptName, 'check:architecture:harness');
  assert.match(plan.checker, /npm run check:architecture && npm run check:architecture:harness/);
  assert.match(plan.reuse, /kept/);
  const fresh = tmpRepo(); harness(fresh, 'init'); writeManifest(fresh);
  assert.equal(planAdapter(fresh).scriptName, 'check:architecture');
});

test('scenario 29: environment setup picks the right frozen install per package manager and names what is not reproducible', () => {
  const dir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'env-'));
  let d = dir(); fs.writeFileSync(path.join(d, 'yarn.lock'), '');
  assert.deepEqual(envCommands(d, 'ts').cmds, ['yarn install --frozen-lockfile']); // Yarn Classic rejects --immutable
  fs.writeFileSync(path.join(d, '.yarnrc.yml'), 'nodeLinker: node-modules\n');
  assert.deepEqual(envCommands(d, 'ts').cmds, ['yarn install --immutable']);
  d = dir(); fs.writeFileSync(path.join(d, 'pnpm-lock.yaml'), '');
  assert.deepEqual(envCommands(d, 'ts').cmds, ['pnpm install --frozen-lockfile']);
  d = dir(); fs.writeFileSync(path.join(d, 'package-lock.json'), '{}');
  assert.deepEqual(envCommands(d, 'ts').cmds, ['npm ci']);
  d = dir();
  const e = envCommands(d, 'ts'); assert.deepEqual(e.cmds, ['npm install --no-package-lock']); assert.match(e.notes[0], /not reproducible/);
  d = dir(); fs.writeFileSync(path.join(d, 'uv.lock'), '');
  assert.deepEqual(envCommands(d, 'python').cmds, ['uv sync --frozen']);
  assert.match(envCommands(dir(), 'python').notes[0], /no uv\.lock/);
});
