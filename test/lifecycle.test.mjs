// Full chain on real temp projects: adapters (ts + python), prove-red, feature branch → claim → worktree → attach → finish → merge → integrate → close.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpRepo, harness, hook, userTyped, writeIssue, writeFeature, ISSUE, writeManifest, MANIFEST } from './helpers.mjs';

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
    stack: 'python', app_shell: ['pkg/app/**'],
    modules: {
      identity: { root: 'pkg/identity', public: 'pkg/identity/__init__.py', may_depend_on: [], owns: ['pkg/identity/**'] },
      billing: { root: 'pkg/billing', public: 'pkg/billing/__init__.py', may_depend_on: ['identity'], owns: ['pkg/billing/**'] },
    },
    resources: {
      payments: { owner: 'billing', kind: 'supabase-table', definition: ['supabase/migrations/**'], symbol: 'payments' },
      ledger: { owner: 'billing', kind: 'custom-orm', definition: ['pkg/billing/ledger.py'], symbol: 'Ledger' }, // no analyzer: skipped, never red
    },
    verify: { test: 'python -c 0' },
  });
  return r;
}
function applyAdapter(r) {
  assert.equal(harness(r, 'adapter', 'plan').code, 0);
  assert.equal(harness(r, 'adapter', 'apply').code, 1, 'apply without --approved must refuse');
  const a = harness(r, 'adapter', 'apply', '--approved');
  assert.equal(a.code, 0, a.err + a.out);
  return a;
}

test('python adapter: apply, green, prove red on deep import + ownership, scenario 5/6/7; unknown resource kind skipped', { timeout: 120000 }, () => {
  const r = pyProject();
  assert.match(harness(r, 'adapter', 'check').out, /skipped: no checker wired/); // before apply: off, not red
  assert.doesNotMatch(harness(r, 'adapter', 'plan').out, /up to date/);
  applyAdapter(r);
  assert.equal(harness(r, 'adapter', 'check').code, 0, harness(r, 'adapter', 'check').out);
  // scenario 41: an already wired checker is reported up to date — no approval, no re-apply, no re-prove
  assert.match(harness(r, 'adapter', 'plan').out, /up to date/);
  fs.writeFileSync(path.join(r, 'tools/check_architecture.py'), '# hand-edited\n' + fs.readFileSync(path.join(r, 'tools/check_architecture.py'), 'utf8'));
  assert.doesNotMatch(harness(r, 'adapter', 'plan').out, /up to date/);
  applyAdapter(r);
  const prove = harness(r, 'adapter', 'prove');
  assert.equal(prove.code, 0, prove.out + prove.err);
  const res = JSON.parse(prove.out);
  assert.ok(res.results.every((x) => x.red), JSON.stringify(res));
  fs.writeFileSync(path.join(r, 'pkg/billing/deep.py'), 'from pkg.identity.repo import get_user\n');
  let c = harness(r, 'adapter', 'check'); assert.equal(c.code, 1); assert.match(c.out, /internals/);
  fs.rmSync(path.join(r, 'pkg/billing/deep.py'));
  fs.writeFileSync(path.join(r, 'pkg/identity/cyc.py'), 'from pkg.billing import get_user\n');
  c = harness(r, 'adapter', 'check'); assert.equal(c.code, 1); assert.match(c.out, /cycle/); assert.match(c.out, /may not depend/);
  fs.rmSync(path.join(r, 'pkg/identity/cyc.py'));
  fs.writeFileSync(path.join(r, 'pkg/identity/leak.py'), 'def f(c):\n    return c.table("payments").select("*")\n');
  c = harness(r, 'adapter', 'check'); assert.equal(c.code, 1); assert.match(c.out, /accesses resource payments owned by billing/);
  fs.rmSync(path.join(r, 'pkg/identity/leak.py'));
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

test('ts adapter: dependency-cruiser wired, prove red, scenario 2/5/6/7, then the full feature lifecycle', { timeout: 300000 }, () => {
  const r = tsProject();
  const a = applyAdapter(r);
  assert.match(a.out, /checker: green/);
  const pkg = JSON.parse(fs.readFileSync(path.join(r, 'package.json'), 'utf8'));
  assert.ok(pkg.devDependencies['dependency-cruiser']);
  assert.match(pkg.scripts['check:architecture'], /depcruise/);
  const prove = harness(r, 'adapter', 'prove');
  assert.equal(prove.code, 0, prove.out + prove.err);
  assert.ok(JSON.parse(prove.out).results.every((x) => x.red));
  fs.writeFileSync(path.join(r, 'src/modules/billing/deep.ts'), "import { secret } from '../identity/internal';\nexport const s = secret;\n");
  let c = harness(r, 'adapter', 'check'); assert.equal(c.code, 1); assert.match(c.out, /identity-public-entry-only/);
  fs.rmSync(path.join(r, 'src/modules/billing/deep.ts'));
  fs.writeFileSync(path.join(r, 'src/modules/identity/index.ts'), "import { b } from '../billing/index';\nexport const a = b;\n");
  fs.writeFileSync(path.join(r, 'src/modules/billing/index.ts'), "import { a } from '../identity/index';\nexport const b = 1; export const c = a;\n");
  c = harness(r, 'adapter', 'check'); assert.equal(c.code, 1); assert.match(c.out, /no-circular|identity-may-depend-on/);
  g(r, 'checkout', '--', 'src');
  fs.writeFileSync(path.join(r, 'src/modules/identity/leak.ts'), "import { payments } from '../billing/schema';\nexport const p = payments;\n");
  c = harness(r, 'adapter', 'check'); assert.equal(c.code, 1); assert.match(c.out, /payments owned by billing|billing-public-entry-only/);
  fs.rmSync(path.join(r, 'src/modules/identity/leak.ts'));
  fs.mkdirSync(path.join(r, 'src/shared'), { recursive: true });
  fs.writeFileSync(path.join(r, 'src/shared/store.ts'), 'export const store = new Map();\n');
  fs.writeFileSync(path.join(r, 'src/modules/billing/side.ts'), "import { store } from '../../shared/store';\nexport const s = store;\n");
  c = harness(r, 'adapter', 'check'); assert.equal(c.code, 1); assert.match(c.out, /closed-world-local/);
  fs.rmSync(path.join(r, 'src/modules/billing/side.ts')); fs.rmSync(path.join(r, 'src/shared'), { recursive: true });
  assert.equal(harness(r, 'adapter', 'check').code, 0);
  g(r, 'add', '-A'); g(r, 'commit', '-qm', 'adapter');
  lifecycle(r);
});

function lifecycle(r) {
  // carve: feature file on its own branch + two issues
  writeFeature(r, { branch: 'feature/identity-read', verify: ['npm test'], human: ['label reads naturally in zh-TW'] });
  writeIssue(r, 'ready', ISSUE({ verify: ['npm test'] }));
  writeIssue(r, 'ready', ISSUE({ id: 'F01-I02', after: ['F01-I01'], touch: ['src/modules/identity/**'], do_not_touch: [], verify: ['npm test'] }));
  assert.equal(harness(r, 'validate').code, 0, harness(r, 'validate').out);
  const fs0 = harness(r, 'feature', 'start', 'F01'); assert.equal(fs0.code, 0, fs0.err);
  assert.equal(g(r, 'branch', '--show-current'), 'feature/identity-read');
  assert.equal(JSON.parse(fs.readFileSync(path.join(r, '.work/features/F01.md'), 'utf8').split('---')[1]).base, 'main');
  g(r, 'add', '-A'); g(r, 'commit', '-qm', 'plan');
  userTyped(r, 'go');
  let q = JSON.parse(harness(r, 'queue', 'next').out);
  assert.deepEqual(q.claimable, ['F01-I01']);
  assert.equal(harness(r, 'claim', 'F01-I01').code, 0);
  q = JSON.parse(harness(r, 'queue', 'next').out);
  assert.deepEqual(q.claimable, []);
  // worker in its worktree, branched from the feature branch
  const wt = path.join(r, '.claude/worktrees/agent-1');
  g(r, 'worktree', 'add', '-q', '-b', 'worktree-agent-1', wt);
  const at = harness(wt, 'attach', 'F01-I01');
  assert.equal(at.code, 0, at.err); assert.match(at.out, /environment: lazy/);
  assert.match(at.out, /Bash: anything non-destructive/);
  // scenario 42: the worker's context pack names the module contract it works inside, not the ARCHITECTURE prose
  assert.match(at.out, /identity: root src\/modules\/identity · public src\/modules\/identity\/index\.ts/);
  assert.doesNotMatch(at.out, /billing: root/);
  // the worker never saw the discussion: attach hands it the feature's outcome and decisions next to the issue
  assert.match(at.out, /outcome: identity read model works\ndecisions \(settled; implement within them, never against them\):\n  - identity owns users/);
  const agent = { agent_id: 'a1', agent_type: 'harness:worker' };
  assert.equal(W(wt, 'src/modules/identity/read.ts', agent).denied, false);
  fs.writeFileSync(path.join(wt, 'src/modules/identity/read.ts'), 'export const read = () => 1;\n');
  let fin = harness(r, 'finish', 'F01-I01');
  assert.equal(fin.code, 0, fin.out + fin.err);
  const res = JSON.parse(fin.out);
  assert.equal(res.ok, true); assert.equal(res.review, 'none');
  assert.match(harness(r, 'diff', 'F01-I01', '--stat').out, /read\.ts \|/);
  assert.ok(fs.readFileSync(path.join(r, '.harness/runtime/metrics.jsonl'), 'utf8').split('\n').some((l) => l.includes('"cmd":"finish"')));
  assert.equal(harness(r, 'merge', 'F01-I01').code, 0);
  assert.equal(g(r, 'branch', '--show-current'), 'feature/identity-read', 'merged into the feature branch');
  assert.ok(fs.existsSync(path.join(r, '.work/done/F01-I01.md')));
  assert.ok(fs.existsSync(path.join(r, 'src/modules/identity/read.ts')));
  assert.ok(!fs.existsSync(wt));
  assert.equal(g(r, 'worktree', 'list').split('\n').length, 1);
  // second issue now claimable
  q = JSON.parse(harness(r, 'queue', 'next').out);
  assert.deepEqual(q.claimable, ['F01-I02']);
  assert.equal(harness(r, 'claim', 'F01-I02').code, 0);
  const wt2 = path.join(r, '.claude/worktrees/agent-2');
  g(r, 'worktree', 'add', '-q', '-b', 'worktree-agent-2', wt2);
  assert.equal(harness(wt2, 'attach', 'F01-I02').code, 0);
  // scenario 2 at finish time: worker bypasses a public entry → checker red → blocked
  fs.writeFileSync(path.join(wt2, 'src/modules/identity/bad.ts'), "import { payments } from '../billing/schema';\nexport const p = payments;\n");
  fin = harness(r, 'finish', 'F01-I02');
  assert.equal(fin.code, 1);
  assert.ok(fs.existsSync(path.join(r, '.work/blocked/F01-I02.md')));
  assert.match(fs.readFileSync(path.join(r, '.work/blocked/F01-I02.md'), 'utf8'), /## Blocked[\s\S]*container checker/);
  assert.ok(!fs.existsSync(wt2), 'worktree discarded');
  assert.ok(!fs.existsSync(path.join(r, '.harness/runtime/leases/F01-I02.json')));
  // scenario 15: moving the unchanged issue back to ready is an identical retry → claim refuses
  fs.rmSync(path.join(r, '.work/blocked/F01-I02.md'));
  writeIssue(r, 'ready', ISSUE({ id: 'F01-I02', after: ['F01-I01'], touch: ['src/modules/identity/**'], do_not_touch: [], verify: ['npm test'] }));
  const retry = harness(r, 'claim', 'F01-I02');
  assert.equal(retry.code, 1); assert.match(retry.err, /identical retry refused/);
  writeIssue(r, 'ready', ISSUE({ id: 'F01-I02', after: ['F01-I01'], touch: ['src/modules/identity/**'], do_not_touch: [], verify: ['npm test'] }),
    '# Objective\nadd read2 via the public entry only\n# Done\ny\n# Verify\nnpm test\n# Blocked if\nw\n');
  assert.equal(harness(r, 'claim', 'F01-I02').code, 0);
  const wt3 = path.join(r, '.claude/worktrees/agent-3');
  g(r, 'worktree', 'add', '-q', '-b', 'worktree-agent-3', wt3);
  assert.equal(harness(wt3, 'attach', 'F01-I02').code, 0);
  fs.writeFileSync(path.join(wt3, 'src/modules/identity/read2.ts'), 'export const read2 = () => 2;\n');
  assert.equal(harness(r, 'finish', 'F01-I02').code, 0);
  assert.equal(harness(r, 'merge', 'F01-I02').code, 0);
  // feature integration → human items surfaced → close: issues + feature file gone, branch merged into main and removed
  const it = harness(r, 'integrate', 'feature', 'F01');
  assert.equal(it.code, 0, it.out + it.err);
  const ir = JSON.parse(it.out);
  assert.deepEqual(ir.human, ['label reads naturally in zh-TW']);
  assert.ok(ir.steps.some((s) => s.step === 'npm test' && s.ok));
  const cl = harness(r, 'close', 'feature', 'F01');
  assert.equal(cl.code, 0, cl.err); assert.match(JSON.parse(cl.out).merged, /feature\/identity-read → main/);
  assert.equal(g(r, 'branch', '--show-current'), 'main');
  assert.equal(g(r, 'branch', '--list', 'feature/identity-read'), '');
  assert.equal(fs.readdirSync(path.join(r, '.work/done')).length, 0);
  assert.equal(fs.readdirSync(path.join(r, '.work/features')).length, 0);
  assert.ok(fs.existsSync(path.join(r, 'src/modules/identity/read2.ts')), 'feature work landed on main');
  assert.match(hook('session', { cwd: r }, r).out, /no open feature/);
}
