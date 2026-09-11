// Holes that only real use hits: greenfield, ownership false positives, a session that dies mid-issue,
// privileged re-runs, review receipts at head, smoke pollution, checker reuse, package managers, dependency approval.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpRepo, harness, hook, userTyped, writeIssue, writeFeature, ISSUE, writeManifest, MANIFEST, PLUGIN, workReady, workerDoes } from './helpers.mjs';
import { planAdapter, envCommands } from '../lib/adapters.mjs';

const g = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
const B = (cwd, command, extra = {}) => hook('gate', { cwd, tool_name: 'Bash', tool_input: { command }, tool_use_id: extra.tool_use_id || 'b1', ...extra }, cwd);
const clean = (r) => g(r, 'status', '--porcelain').split('\n').filter(Boolean).filter((l) => !l.includes('.work/'));

test('scenario 17: a module declared before it exists — plan and first issue succeed, feature integration waits for it; greenfield checker', { timeout: 120000 }, () => {
  const r = tmpRepo();
  const m = { ...MANIFEST(), checker: { command: 'node -e 0' } };
  m.modules.notify = { root: 'src/modules/notify', public: 'src/modules/notify/index.ts', may_depend_on: ['identity'], owns: ['src/modules/notify/**'] };
  m.modules.audit = { root: 'src/modules/audit', public: 'src/modules/audit/index.ts', may_depend_on: [], owns: ['src/modules/audit/**'] };
  workReady(r, m);
  assert.equal(harness(r, 'validate').code, 0, harness(r, 'validate').out);
  writeIssue(r, 'ready', ISSUE({ touch: ['src/modules/notify/**'], do_not_touch: [] }));
  workerDoes(r, 'F01-I01', (wt) => { fs.mkdirSync(path.join(wt, 'src/modules/notify'), { recursive: true }); fs.writeFileSync(path.join(wt, 'src/modules/notify/index.ts'), 'export const n = 1;\n'); });
  assert.equal(harness(r, 'finish', 'F01-I01').code, 0, harness(r, 'finish', 'F01-I01').out);
  assert.equal(harness(r, 'merge', 'F01-I01').code, 0);
  assert.ok(fs.existsSync(path.join(r, 'src/modules/notify/index.ts')));
  const feat = harness(r, 'integrate', 'feature', 'F01');
  assert.equal(feat.code, 1); assert.match(feat.out, /not materialized[\s\S]*audit/);
  const r2 = tmpRepo(); fs.rmSync(path.join(r2, 'src'), { recursive: true }); g(r2, 'add', '-A'); g(r2, 'commit', '-qm', 'empty');
  harness(r2, 'init'); writeManifest(r2, { ...MANIFEST(), checker: { command: 'node -e "process.exit(1)"' } });
  const c = harness(r2, 'adapter', 'check');
  assert.equal(c.code, 0); assert.match(c.out, /greenfield/);
});

test('scenario 20 (ts): ownership is a binding, not a word — local `payments` is green, importing the table is red, dynamic supabase target is red, unknown kind skipped', () => {
  const r = tmpRepo();
  fs.writeFileSync(path.join(r, 'src/modules/billing/schema.ts'), "export const payments = 'payments';\n");
  const m = MANIFEST();
  m.resources = {
    payments: { owner: 'billing', kind: 'drizzle-table', definition: ['src/modules/billing/schema.ts'], symbol: 'payments' },
    profiles: { owner: 'identity', kind: 'supabase-table', definition: ['supabase/migrations/**'], symbol: 'profiles' },
    ledger: { owner: 'billing', kind: 'prisma-model', definition: ['prisma/schema.prisma'], symbol: 'Ledger' },
  };
  writeManifest(r, m);
  const run = () => spawnSync(process.execPath, [path.join(PLUGIN, 'adapters/ts/check_ownership.mjs'), r], { encoding: 'utf8' });
  const put = (f, s) => fs.writeFileSync(path.join(r, f), s);
  put('src/modules/identity/a.ts', 'const payments = [];\nexport const total = payments.length;\nconst Ledger = 1; export const l = Ledger;\n');
  put('src/modules/billing/e.ts', "export const xs = Array.from(new Set([1]));\nexport const b = Buffer.from('x');\n");
  let res = run(); assert.equal(res.status, 0, res.stdout);
  put('src/modules/identity/b.ts', "import { payments } from '../billing/schema';\nexport const p = payments;\n");
  res = run(); assert.equal(res.status, 1); assert.match(res.stdout, /identity\/b\.ts:1: identity accesses resource payments owned by billing/);
  fs.rmSync(path.join(r, 'src/modules/identity/b.ts'));
  put('src/modules/identity/c.ts', "import { payments as p } from '@/modules/billing/schema';\nexport const q = p;\n");
  res = run(); assert.equal(res.status, 1, res.stdout); fs.rmSync(path.join(r, 'src/modules/identity/c.ts'));
  put('src/modules/billing/d.ts', "const t = 'profiles';\nexport const q = (sb) => sb.from(t).select();\n");
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
    stack: 'python', app_shell: ['pkg/app/**'],
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
  res = run(); assert.ok(res.status >= 1); assert.match(res.stdout, /identity\/b\.py:1: identity accesses resource invoices owned by billing/);
  fs.rmSync(path.join(r, 'pkg/identity/b.py'));
  put('pkg/billing/c.py', 'def q(c, name):\n    return c.table(name).select("*")\n');
  res = run(); assert.equal(res.status, 1); assert.match(res.stdout, /non-literal target/);
});

test('scenario 23: the session dies after attach + partial edit — harness recover: diff saved, issue re-queued, no deadlock, no identical-retry refusal', { timeout: 120000 }, () => {
  const r = tmpRepo(); workReady(r);
  writeIssue(r, 'ready', ISSUE());
  const wt = workerDoes(r, 'F01-I01', (w) => fs.writeFileSync(path.join(w, 'src/modules/identity/half.ts'), 'export const half = 1; // unfinished\n'));
  // same session: nothing to recover, the lease stays
  userTyped(r, 'still here', 's1'); assert.match(harness(r, 'recover').out, /nothing to recover/);
  assert.ok(fs.existsSync(path.join(r, '.harness/runtime/leases/F01-I01.json')));
  // new session
  userTyped(r, 'hi', 's2');
  const w = harness(r, 'recover');
  assert.equal(w.code, 0, w.err); assert.match(w.out, /recovered F01-I01.*partial diff saved/);
  assert.ok(fs.existsSync(path.join(r, '.work/ready/F01-I01.md')));
  assert.ok(!fs.existsSync(path.join(r, '.harness/runtime/leases/F01-I01.json')));
  assert.ok(!fs.existsSync(wt), 'worktree discarded');
  const logs = fs.readdirSync(path.join(r, '.harness/runtime/logs')).filter((f) => /recovered/.test(f));
  assert.equal(logs.length, 1);
  assert.match(fs.readFileSync(path.join(r, '.harness/runtime/logs', logs[0]), 'utf8'), /half\.ts/);
  assert.equal(JSON.parse(harness(r, 'queue', 'next').out).claimable[0], 'F01-I01');
  assert.equal(harness(r, 'claim', 'F01-I01').code, 0, 'a lost session is not a blocked issue');
  const wt2 = path.join(r, '.claude/worktrees/F01-I01'); g(r, 'worktree', 'add', '-q', '-b', 'wt-2', wt2); harness(wt2, 'attach', 'F01-I01');
  assert.equal(harness(r, 'release', 'F01-I01').code, 0);
  assert.ok(!fs.existsSync(wt2));
});

test('scenario 24: a privileged command runs once, by the worker; finish re-runs only verify', { timeout: 120000 }, () => {
  const r = tmpRepo(); workReady(r);
  const marker = path.join(os.tmpdir(), `harness-priv-${Date.now()}.txt`).replace(/\\/g, '/');
  const priv = `node -e "require('fs').appendFileSync('${marker}','x')"`;
  writeIssue(r, 'ready', ISSUE({ verify: ['npm test'], privileged: [priv] }));
  workerDoes(r, 'F01-I01', (wt) => {
    fs.writeFileSync(path.join(wt, 'src/modules/identity/gen.ts'), 'export const gen = 1;\n');
    assert.equal(B(wt, priv, { agent_id: 'a1', agent_type: 'harness:worker' }).denied, false);
    spawnSync(priv, { cwd: wt, shell: true });
  });
  assert.equal(fs.readFileSync(marker, 'utf8'), 'x');
  const fin = harness(r, 'finish', 'F01-I01');
  assert.equal(fin.code, 0, fin.out);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'x', 'finish did not re-run the generator');
  assert.ok(JSON.parse(fin.out).steps.some((s) => s.step === 'verify: npm test'));
  fs.rmSync(marker);
});

test('scenario 25: a planner review is a receipt for the exact head — a later commit invalidates it', { timeout: 120000 }, () => {
  const r = tmpRepo(); workReady(r);
  writeIssue(r, 'ready', ISSUE({ interface_change: true, review: 'planner' }));
  const wt = workerDoes(r, 'F01-I01', (w) => fs.writeFileSync(path.join(w, 'src/modules/identity/api.ts'), 'export const api = 1;\n'));
  assert.equal(harness(r, 'review', 'F01-I01', 'approve').code, 1, 'nothing to approve before finish');
  assert.equal(harness(r, 'finish', 'F01-I01').code, 0);
  let m = harness(r, 'merge', 'F01-I01'); assert.equal(m.code, 1); assert.match(m.err, /needs planner review/);
  const rv = harness(r, 'review', 'F01-I01', 'approve'); assert.equal(rv.code, 0, rv.err); assert.match(rv.out, /review recorded/);
  fs.writeFileSync(path.join(wt, 'src/modules/identity/api.ts'), 'export const api = 2;\n');
  assert.equal(harness(r, 'finish', 'F01-I01').code, 0);
  m = harness(r, 'merge', 'F01-I01'); assert.equal(m.code, 1); assert.match(m.err, /review receipt is for/);
  assert.equal(harness(r, 'review', 'F01-I01', 'approve').code, 0);
  assert.equal(harness(r, 'merge', 'F01-I01').code, 0);
});

test('scenario 26: smoke that passes but writes a cache file leaves the main tree clean; acceptance commands that dirty it are red', { timeout: 120000 }, () => {
  const r = tmpRepo(); workReady(r, { verify: { test: 'npm test', smoke: `node -e "require('fs').writeFileSync('smoke.cache','x')"` } });
  writeIssue(r, 'ready', ISSUE({ verify: ['npm test'] }));
  workerDoes(r, 'F01-I01', (wt) => fs.writeFileSync(path.join(wt, 'src/modules/identity/s.ts'), 'export const s = 1;\n'));
  assert.equal(harness(r, 'finish', 'F01-I01').code, 0);
  const m = harness(r, 'merge', 'F01-I01'); assert.equal(m.code, 0, m.err + m.out);
  assert.ok(!fs.existsSync(path.join(r, 'smoke.cache')), 'smoke ran in the worktree, not the main tree');
  assert.deepEqual(clean(r), []);
  writeFeature(r, { runtime: [`node -e "require('fs').writeFileSync('shot.png','x')"`] });
  const it = harness(r, 'integrate', 'feature', 'F01');
  assert.equal(it.code, 1); assert.match(it.out, /dirtied the main tree: shot\.png|smoke\.cache/);
  for (const f of ['shot.png', 'smoke.cache']) fs.rmSync(path.join(r, f), { force: true });
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
  assert.deepEqual(envCommands(d, 'ts').cmds, ['yarn install --frozen-lockfile']);
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
  fs.mkdirSync(path.join(d, 'frontend')); fs.writeFileSync(path.join(d, 'frontend/package.json'), '{}');
  fs.writeFileSync(path.join(d, 'frontend/package-lock.json'), '{}');
  fs.mkdirSync(path.join(d, 'docs'));
  assert.deepEqual(envCommands(d, 'python').cmds, ['uv sync --frozen', 'cd frontend && npm ci']);
  fs.rmSync(path.join(d, 'frontend/package-lock.json'));
  assert.deepEqual(envCommands(d, 'python').cmds, ['uv sync --frozen']);
});

test('dependency issues: planner-reviewed, named in deps, scheduled alone — no ticket approval ledger', () => {
  const r = tmpRepo(); workReady(r);
  writeIssue(r, 'ready', ISSUE({ touch: ['package.json', 'src/modules/identity/**'], review: 'planner' }));
  let v = harness(r, 'validate'); assert.equal(v.code, 1); assert.match(v.out, /requires deps:/);
  writeIssue(r, 'ready', ISSUE({ touch: ['package.json', 'src/modules/identity/**'], review: 'planner', deps: ['zod'] }));
  assert.equal(harness(r, 'validate').code, 0, harness(r, 'validate').out);
  writeIssue(r, 'ready', ISSUE({ id: 'F01-I02', touch: ['src/modules/billing/**'], do_not_touch: [] }));
  const q = JSON.parse(harness(r, 'queue', 'next').out);
  assert.deepEqual(q.claimable, ['F01-I01']);
  assert.match(q.waiting['F01-I02'], /dependency-changing issue is queued first/);
});
