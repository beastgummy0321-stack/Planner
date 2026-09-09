// Full chain on real temp projects: adapters (ts + python), prove-red, claim → worktree → attach → finish → merge → integrate → close.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpRepo, harness, hook, setMode, writeIssue, ISSUE, writeManifest, MANIFEST, PLUGIN } from './helpers.mjs';

const g = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
const W = (cwd, file, extra = {}) => hook('gate', { cwd, tool_name: 'Write', tool_input: { file_path: file, content: 'x' }, tool_use_id: 't1', ...extra }, cwd);

function tsProject() {
  const r = tmpRepo();
  fs.writeFileSync(path.join(r, 'src/modules/identity/internal.ts'), 'export const secret = 1;\n');
  fs.writeFileSync(path.join(r, 'src/modules/billing/schema.ts'), "export const payments = 'payments';\n");
  fs.writeFileSync(path.join(r, 'tsconfig.json'), '{"compilerOptions":{"module":"esnext","moduleResolution":"bundler","target":"es2022","strict":true,"noEmit":true},"include":["src"]}\n');
  g(r, 'add', '.'); g(r, 'commit', '-qm', 'ts');
  harness(r, 'init');
  const m = MANIFEST();
  m.resources = { payments: { owner: 'billing', kind: 'drizzle-table', definition: ['src/modules/billing/schema.ts'], symbol: 'payments' } };
  writeManifest(r, m);
  return r;
}
function pyProject() {
  const r = tmpRepo();
  fs.mkdirSync(path.join(r, 'pkg/identity'), { recursive: true });
  fs.mkdirSync(path.join(r, 'pkg/billing'), { recursive: true });
  fs.mkdirSync(path.join(r, 'pkg/app'), { recursive: true });
  fs.mkdirSync(path.join(r, 'supabase/migrations'), { recursive: true });
  fs.writeFileSync(path.join(r, 'pkg/__init__.py'), '');
  fs.writeFileSync(path.join(r, 'pkg/identity/__init__.py'), 'from .repo import get_user\n');
  fs.writeFileSync(path.join(r, 'pkg/identity/repo.py'), 'def get_user():\n    return 1\n');
  fs.writeFileSync(path.join(r, 'pkg/billing/__init__.py'), 'from pkg.identity import get_user\n');
  fs.writeFileSync(path.join(r, 'pkg/app/__init__.py'), '');
  fs.writeFileSync(path.join(r, 'pkg/app/main.py'), 'from pkg.identity import get_user\n');
  fs.writeFileSync(path.join(r, 'supabase/migrations/001.sql'), 'create table payments();\n');
  fs.writeFileSync(path.join(r, 'pyproject.toml'), '[project]\nname="t"\nversion="0"\n');
  fs.rmSync(path.join(r, 'package.json'));
  g(r, 'add', '.'); g(r, 'commit', '-qm', 'py');
  harness(r, 'init');
  writeManifest(r, {
    harness: 1, stack: 'python', app_shell: ['pkg/app/**'],
    modules: {
      identity: { root: 'pkg/identity', public: 'pkg/identity/__init__.py', may_depend_on: [], owns: ['pkg/identity/**'] },
      billing: { root: 'pkg/billing', public: 'pkg/billing/__init__.py', may_depend_on: ['identity'], owns: ['pkg/billing/**'] },
    },
    resources: { payments: { owner: 'billing', kind: 'supabase-table', definition: ['supabase/migrations/**'], symbol: 'payments' } },
    verify: { test: 'python -c 0' }, checker: { command: 'pending' },
  });
  return r;
}
function applyAdapter(r) {
  setMode(r, 'plan');
  assert.equal(harness(r, 'adapter', 'plan').code, 0);
  assert.equal(harness(r, 'adapter', 'apply').code, 1, 'apply without --approved must refuse');
  const a = harness(r, 'adapter', 'apply', '--approved');
  assert.equal(a.code, 0, a.err + a.out);
  return a;
}

test('python adapter: apply, green, prove red on deep import + ownership, scenario 5/6/7', { timeout: 120000 }, () => {
  const r = pyProject();
  applyAdapter(r);
  assert.equal(harness(r, 'adapter', 'check').code, 0);
  const prove = harness(r, 'adapter', 'prove');
  assert.equal(prove.code, 0, prove.out + prove.err);
  const res = JSON.parse(prove.out);
  assert.ok(res.results.every((x) => x.red), JSON.stringify(res));
  // scenario 5: deep import
  fs.writeFileSync(path.join(r, 'pkg/billing/deep.py'), 'from pkg.identity.repo import get_user\n');
  let c = harness(r, 'adapter', 'check'); assert.equal(c.code, 1); assert.match(c.out, /internals/);
  fs.rmSync(path.join(r, 'pkg/billing/deep.py'));
  // scenario 6: cycle (identity imports billing) — also may_depend_on violation
  fs.writeFileSync(path.join(r, 'pkg/identity/cyc.py'), 'from pkg.billing import get_user\n');
  c = harness(r, 'adapter', 'check'); assert.equal(c.code, 1); assert.match(c.out, /cycle/); assert.match(c.out, /may not depend/);
  fs.rmSync(path.join(r, 'pkg/identity/cyc.py'));
  // scenario 7: ownership
  fs.writeFileSync(path.join(r, 'pkg/identity/leak.py'), 'def f(c):\n    return c.table("payments").select("*")\n');
  c = harness(r, 'adapter', 'check'); assert.equal(c.code, 1); assert.match(c.out, /accesses resource payments owned by billing/);
  fs.rmSync(path.join(r, 'pkg/identity/leak.py'));
  // app shell importing internals is also red; migrations dir may mention the table
  fs.writeFileSync(path.join(r, 'pkg/app/bad.py'), 'from pkg.identity.repo import get_user\n');
  c = harness(r, 'adapter', 'check'); assert.equal(c.code, 1);
  fs.rmSync(path.join(r, 'pkg/app/bad.py'));
  // scenario 19 (python): an unclassified local file is a side door — a module may not import it
  fs.writeFileSync(path.join(r, 'pkg/shared.py'), 'store = {}\n');
  fs.writeFileSync(path.join(r, 'pkg/identity/side.py'), 'from pkg.shared import store\n');
  c = harness(r, 'adapter', 'check'); assert.equal(c.code, 1); assert.match(c.out, /unclassified local file pkg\/shared\.py/);
  fs.rmSync(path.join(r, 'pkg/identity/side.py')); fs.rmSync(path.join(r, 'pkg/shared.py'));
  assert.equal(harness(r, 'adapter', 'check').code, 0);
});

test('ts adapter: dependency-cruiser wired, prove red, scenario 2/5/6/7', { timeout: 300000 }, () => {
  const r = tsProject();
  const a = applyAdapter(r);
  assert.match(a.out, /checker: green/);
  const pkg = JSON.parse(fs.readFileSync(path.join(r, 'package.json'), 'utf8'));
  assert.ok(pkg.devDependencies['dependency-cruiser']);
  assert.match(pkg.scripts['check:architecture'], /depcruise/);
  const prove = harness(r, 'adapter', 'prove');
  assert.equal(prove.code, 0, prove.out + prove.err);
  assert.ok(JSON.parse(prove.out).results.every((x) => x.red));
  // scenario 2/5: bypass public entry
  fs.writeFileSync(path.join(r, 'src/modules/billing/deep.ts'), "import { secret } from '../identity/internal';\nexport const s = secret;\n");
  let c = harness(r, 'adapter', 'check'); assert.equal(c.code, 1); assert.match(c.out, /identity-public-entry-only/);
  fs.rmSync(path.join(r, 'src/modules/billing/deep.ts'));
  // scenario 6: cycle via public entries
  fs.writeFileSync(path.join(r, 'src/modules/identity/index.ts'), "import { b } from '../billing/index';\nexport const a = b;\n");
  fs.writeFileSync(path.join(r, 'src/modules/billing/index.ts'), "import { a } from '../identity/index';\nexport const b = 1; export const c = a;\n");
  c = harness(r, 'adapter', 'check'); assert.equal(c.code, 1); assert.match(c.out, /no-circular|identity-may-depend-on/);
  g(r, 'checkout', '--', 'src');
  // scenario 7: non-owner uses the drizzle table symbol
  fs.writeFileSync(path.join(r, 'src/modules/identity/leak.ts'), "import { payments } from '../billing/schema';\nexport const p = payments;\n");
  c = harness(r, 'adapter', 'check'); assert.equal(c.code, 1); assert.match(c.out, /payments owned by billing|billing-public-entry-only/);
  fs.rmSync(path.join(r, 'src/modules/identity/leak.ts'));
  // scenario 19 (ts): an unclassified local file is a side door — a module may not import it
  fs.mkdirSync(path.join(r, 'src/shared'), { recursive: true });
  fs.writeFileSync(path.join(r, 'src/shared/store.ts'), 'export const store = new Map();\n');
  fs.writeFileSync(path.join(r, 'src/modules/billing/side.ts'), "import { store } from '../../shared/store';\nexport const s = store;\n");
  c = harness(r, 'adapter', 'check'); assert.equal(c.code, 1); assert.match(c.out, /closed-world-local/);
  fs.rmSync(path.join(r, 'src/modules/billing/side.ts')); fs.rmSync(path.join(r, 'src/shared'), { recursive: true });
  assert.equal(harness(r, 'adapter', 'check').code, 0);
  // git state for the lifecycle test below
  g(r, 'add', '-A'); g(r, 'commit', '-qm', 'adapter');
  fs.writeFileSync(path.join(r, '.harness', 'READY'), '1');
  lifecycle(r);
});

function lifecycle(r) {
  // plan: ticket + issues
  fs.mkdirSync(path.join(r, '.work/tickets'), { recursive: true });
  fs.writeFileSync(path.join(r, '.work/tickets/F01-T01.md'), `---\n${JSON.stringify({ id: 'F01-T01', feature: 'F01', title: 'Identity read model', verify: ['npm test'], closed: false })}\n---\n# Outcome\nx\n# Architecture scope\nidentity\n# Issues\nF01-T01-I01, F01-T01-I02\n# Integration verify\nnpm test\n# Acceptance\nx\n`);
  writeIssue(r, 'ready', ISSUE({ verify: ['npm test'] }));
  writeIssue(r, 'ready', ISSUE({ id: 'F01-T01-I02', after: ['F01-T01-I01'], touch: ['src/modules/identity/**'], do_not_touch: [], verify: ['npm test'] }));
  assert.equal(harness(r, 'validate').code, 0, harness(r, 'validate').out);
  g(r, 'add', '-A'); g(r, 'commit', '-qm', 'plan');
  setMode(r, 'work');
  let q = JSON.parse(harness(r, 'queue', 'next').out);
  assert.deepEqual(q.claimable, ['F01-T01-I01']);
  assert.equal(harness(r, 'claim', 'F01-T01-I01').code, 0);
  q = JSON.parse(harness(r, 'queue', 'next').out);
  assert.deepEqual(q.claimable, []);
  // worker in its worktree
  const wt = path.join(r, '.claude/worktrees/agent-1');
  g(r, 'worktree', 'add', '-q', '-b', 'worktree-agent-1', wt);
  const at = harness(wt, 'attach', 'F01-T01-I01');
  assert.equal(at.code, 0, at.err); assert.match(at.out, /environment: lazy/);
  const agent = { agent_id: 'a1', agent_type: 'harness:worker' };
  assert.equal(W(wt, 'src/modules/identity/read.ts', agent).denied, false);
  fs.writeFileSync(path.join(wt, 'src/modules/identity/read.ts'), 'export const read = () => 1;\n');
  // scenario 1: an issue whose verify cannot pass → blocked, worktree discarded, no retry
  let fin = harness(r, 'finish', 'F01-T01-I01');
  assert.equal(fin.code, 0, fin.out + fin.err);
  const res = JSON.parse(fin.out);
  assert.equal(res.ok, true); assert.equal(res.review, 'none');
  assert.equal(harness(r, 'merge', 'F01-T01-I01').code, 0);
  assert.ok(fs.existsSync(path.join(r, '.work/done/F01-T01-I01.md')));
  assert.ok(fs.existsSync(path.join(r, 'src/modules/identity/read.ts')));
  assert.ok(!fs.existsSync(wt));
  assert.equal(g(r, 'worktree', 'list').split('\n').length, 1);
  // second issue now claimable
  q = JSON.parse(harness(r, 'queue', 'next').out);
  assert.deepEqual(q.claimable, ['F01-T01-I02']);
  assert.equal(harness(r, 'claim', 'F01-T01-I02').code, 0);
  const wt2 = path.join(r, '.claude/worktrees/agent-2');
  g(r, 'worktree', 'add', '-q', '-b', 'worktree-agent-2', wt2);
  assert.equal(harness(wt2, 'attach', 'F01-T01-I02').code, 0);
  // scenario 2 at finish time: worker bypasses a public entry → checker red → blocked
  fs.writeFileSync(path.join(wt2, 'src/modules/identity/bad.ts'), "import { payments } from '../billing/schema';\nexport const p = payments;\n");
  fin = harness(r, 'finish', 'F01-T01-I02');
  assert.equal(fin.code, 1);
  assert.ok(fs.existsSync(path.join(r, '.work/blocked/F01-T01-I02.md')));
  assert.match(fs.readFileSync(path.join(r, '.work/blocked/F01-T01-I02.md'), 'utf8'), /## Blocked[\s\S]*container checker/);
  assert.ok(!fs.existsSync(wt2), 'worktree discarded');
  assert.ok(!fs.existsSync(path.join(r, '.harness/runtime/leases/F01-T01-I02.json')));
  // scenario 15: moving the unchanged issue back to ready is an identical retry → claim refuses
  fs.rmSync(path.join(r, '.work/blocked/F01-T01-I02.md'));
  writeIssue(r, 'ready', ISSUE({ id: 'F01-T01-I02', after: ['F01-T01-I01'], touch: ['src/modules/identity/**'], do_not_touch: [], verify: ['npm test'] }));
  const retry = harness(r, 'claim', 'F01-T01-I02');
  assert.equal(retry.code, 1); assert.match(retry.err, /identical retry refused/);
  // the planner changes the issue → allowed again
  writeIssue(r, 'ready', ISSUE({ id: 'F01-T01-I02', after: ['F01-T01-I01'], touch: ['src/modules/identity/**'], do_not_touch: [], verify: ['npm test'] }),
    '# Objective\nadd read2 via the public entry only\n# Done\ny\n# Verify\nnpm test\n# Blocked if\nw\n');
  assert.equal(harness(r, 'claim', 'F01-T01-I02').code, 0);
  const wt3 = path.join(r, '.claude/worktrees/agent-3');
  g(r, 'worktree', 'add', '-q', '-b', 'worktree-agent-3', wt3);
  assert.equal(harness(wt3, 'attach', 'F01-T01-I02').code, 0);
  fs.writeFileSync(path.join(wt3, 'src/modules/identity/read2.ts'), 'export const read2 = () => 2;\n');
  assert.equal(harness(r, 'finish', 'F01-T01-I02').code, 0);
  assert.equal(harness(r, 'merge', 'F01-T01-I02').code, 0);
  // ticket integration → close → feature integration → close → GC
  let it = harness(r, 'integrate', 'ticket', 'F01-T01');
  assert.equal(it.code, 0, it.out + it.err);
  assert.equal(harness(r, 'close', 'ticket', 'F01-T01').code, 0);
  assert.equal(fs.readdirSync(path.join(r, '.work/done')).length, 0);
  assert.match(fs.readFileSync(path.join(r, '.work/PLAN.md'), 'utf8'), /F01-T01.*\[closed\]/);
  it = harness(r, 'integrate', 'feature', 'F01');
  assert.equal(it.code, 0, it.out + it.err);
  assert.equal(harness(r, 'close', 'feature', 'F01').code, 0);
  assert.equal(fs.readdirSync(path.join(r, '.work/tickets')).length, 0);
  assert.doesNotMatch(fs.readFileSync(path.join(r, '.work/PLAN.md'), 'utf8'), /F01/);
}
