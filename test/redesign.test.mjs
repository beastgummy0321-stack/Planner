// Scenarios 11–16 from the second-round redesign: reuse/dependency approval, legacy surface, evidence router,
// runtime-only defect, disposable probes. (10 lives in gates.test, 15 in lifecycle.test.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpRepo, harness, hook, setMode, writeIssue, ISSUE, writeManifest, MANIFEST } from './helpers.mjs';

const g = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
const ticket = (r, data, body = '# Outcome\nx\n# Acceptance\ny\n') => {
  fs.mkdirSync(path.join(r, '.work/tickets'), { recursive: true });
  fs.writeFileSync(path.join(r, `.work/tickets/${data.id}.md`), `---\n${JSON.stringify({ feature: data.id.slice(0, 3), title: 't', verify: [], closed: false, ...data })}\n---\n${body}`);
};

test('scenario 11: closed-door building — a new package enters only through a user-approved ticket', () => {
  const r = tmpRepo(); harness(r, 'init'); writeManifest(r); setMode(r, 'plan');
  ticket(r, { id: 'F01-T01' });
  const f = writeIssue(r, 'ready', ISSUE({ touch: ['package.json', 'src/modules/identity/**'], review: 'planner' }));
  let v = harness(r, 'validate');
  assert.equal(v.code, 1); assert.match(v.out, /requires deps:/);
  writeIssue(r, 'ready', ISSUE({ touch: ['package.json', 'src/modules/identity/**'], review: 'planner', deps: ['zod'] }));
  v = harness(r, 'validate');
  assert.equal(v.code, 1); assert.match(v.out, /zod is not in the ticket's deps_approved/);
  ticket(r, { id: 'F01-T01', deps_approved: ['zod'] });
  assert.equal(harness(r, 'validate').code, 0, harness(r, 'validate').out);
  // the post-write hook reports the same
  ticket(r, { id: 'F01-T01' });
  assert.equal(hook('post', { cwd: r, tool_name: 'Write', tool_input: { file_path: f } }, r).code, 2);
});

test('scenario 12: legacy adoption — managed surface starts without cleaning the repo; legacy shrinks, never grows', { timeout: 120000 }, () => {
  const r = tmpRepo();
  fs.rmSync(path.join(r, 'package.json'));
  for (const d of ['pkg/identity', 'pkg/old', 'pkg/app']) fs.mkdirSync(path.join(r, d), { recursive: true });
  fs.writeFileSync(path.join(r, 'pkg/__init__.py'), '');
  fs.writeFileSync(path.join(r, 'pkg/identity/__init__.py'), 'from pkg.old.facade import legacy_users\n');
  fs.writeFileSync(path.join(r, 'pkg/old/__init__.py'), '');
  fs.writeFileSync(path.join(r, 'pkg/old/facade.py'), 'from .internal import users as legacy_users\n');
  fs.writeFileSync(path.join(r, 'pkg/old/internal.py'), 'import os, sys, json\nusers = []\nfrom pkg.app.main import x\n'); // legacy is a mess and may stay one
  fs.writeFileSync(path.join(r, 'pkg/app/__init__.py'), '');
  fs.writeFileSync(path.join(r, 'pkg/app/main.py'), 'x = 1\n');
  fs.writeFileSync(path.join(r, 'pyproject.toml'), '[project]\nname="t"\nversion="0"\n');
  g(r, 'add', '.'); g(r, 'commit', '-qm', 'legacy');
  harness(r, 'init');
  const m = {
    harness: 1, stack: 'python', app_shell: ['pkg/app/**'],
    modules: { identity: { root: 'pkg/identity', public: 'pkg/identity/__init__.py', may_depend_on: [], owns: ['pkg/identity/**'] } },
    resources: {}, verify: { test: 'python -c 0' }, checker: { command: 'pending' },
    legacy: ['pkg/old/**'], legacy_facades: ['pkg/old/facade.py'],
  };
  writeManifest(r, m);
  setMode(r, 'plan');
  assert.equal(harness(r, 'adapter', 'apply', '--approved').code, 0);
  assert.equal(harness(r, 'adapter', 'check').code, 0, harness(r, 'adapter', 'check').out); // legacy mess is tolerated, facade use is fine
  fs.writeFileSync(path.join(r, 'pkg/identity/leak.py'), 'from pkg.old.internal import users\n');
  const c = harness(r, 'adapter', 'check');
  assert.equal(c.code, 1); assert.match(c.out, /legacy internals/);
  fs.rmSync(path.join(r, 'pkg/identity/leak.py'));
  // issues: new capability may not grow into legacy; a declared migration may, with planner review
  ticket(r, { id: 'F01-T01' });
  writeIssue(r, 'ready', ISSUE({ touch: ['pkg/old/**'], do_not_touch: [], verify: ['python -c 0'] }));
  let v = harness(r, 'validate'); assert.equal(v.code, 1); assert.match(v.out, /legacy_migration/);
  writeIssue(r, 'ready', ISSUE({ touch: ['pkg/old/**'], do_not_touch: [], verify: ['python -c 0'], legacy_migration: true, review: 'planner' }));
  assert.equal(harness(r, 'validate').code, 0, harness(r, 'validate').out);
  // a module root inside legacy is rejected: managed and legacy are disjoint
  m.modules.oldy = { root: 'pkg/old', public: 'pkg/old/__init__.py', may_depend_on: [], owns: ['pkg/old/**'] };
  writeManifest(r, m);
  assert.match(harness(r, 'validate').out, /inside a legacy glob/);
});

function workReady(r, extraManifest = {}) {
  harness(r, 'init');
  const m = { ...MANIFEST(), checker: { command: 'node -e 0' }, ...extraManifest };
  writeManifest(r, m);
  g(r, 'add', '-A'); g(r, 'commit', '-qm', 'arch');
  setMode(r, 'plan'); ticket(r, { id: 'F01-T01' }); setMode(r, 'work');
}
function workerDoes(r, id, edit) {
  assert.equal(harness(r, 'claim', id).code, 0);
  const wt = path.join(r, '.claude/worktrees', id);
  g(r, 'worktree', 'add', '-q', '-b', `wt-${id}`, wt);
  assert.equal(harness(wt, 'attach', id).code, 0);
  edit(wt);
  return wt;
}

test('scenario 13: utility routing — long red output goes to a log file, the blocked body stays short', { timeout: 120000 }, () => {
  const r = tmpRepo(); workReady(r);
  const noisy = 'node -e "for(let i=0;i<60;i++)console.log(\'line \'+i);process.exit(1)"';
  writeIssue(r, 'ready', ISSUE({ verify: [noisy] }));
  workerDoes(r, 'F01-T01-I01', (wt) => fs.writeFileSync(path.join(wt, 'src/modules/identity/a.ts'), 'export const a2 = 2;\n'));
  const fin = harness(r, 'finish', 'F01-T01-I01');
  assert.equal(fin.code, 1);
  const res = JSON.parse(fin.out);
  assert.ok(res.log && /harness:utility/.test(res.log), JSON.stringify(res));
  const body = fs.readFileSync(path.join(r, '.work/blocked/F01-T01-I01.md'), 'utf8');
  assert.ok((body.match(/^- line/gm) || []).length <= 8, 'blocked body carries only a tail');
  const logs = fs.readdirSync(path.join(r, '.harness/runtime/logs'));
  assert.equal(logs.length, 1);
  assert.ok(fs.readFileSync(path.join(r, '.harness/runtime/logs', logs[0]), 'utf8').includes('line 0'));
});

test('scenario 14: runtime-only defect — unit/typecheck/build green but smoke red: the issue cannot complete', { timeout: 120000 }, () => {
  const r = tmpRepo(); workReady(r, { verify: { test: 'npm test', smoke: 'node -e "process.exit(1)"' } });
  writeIssue(r, 'ready', ISSUE({ verify: ['npm test'] }));
  workerDoes(r, 'F01-T01-I01', (wt) => fs.writeFileSync(path.join(wt, 'src/modules/identity/b.ts'), 'export const b2 = 2;\n'));
  assert.equal(harness(r, 'finish', 'F01-T01-I01').code, 0);
  const m = harness(r, 'merge', 'F01-T01-I01');
  assert.equal(m.code, 1); assert.match(m.out, /runtime smoke red/);
  assert.ok(fs.existsSync(path.join(r, '.work/blocked/F01-T01-I01.md')));
  assert.ok(!fs.existsSync(path.join(r, 'src/modules/identity/b.ts')), 'merge was rolled back');
  assert.equal(g(r, 'status', '--porcelain').split('\n').filter((l) => !l.includes('.work/')).filter(Boolean).length, 0);
});

test('acceptance contract: ticket runtime slot runs at integration, human items are surfaced, never auto-closed', { timeout: 120000 }, () => {
  const r = tmpRepo(); workReady(r);
  ticket(r, { id: 'F01-T01', runtime: ['node -e "process.exit(2)"'], human: ['label reads naturally in zh-TW'] });
  writeIssue(r, 'ready', ISSUE({ verify: ['npm test'] }));
  workerDoes(r, 'F01-T01-I01', (wt) => fs.writeFileSync(path.join(wt, 'src/modules/identity/c.ts'), 'export const c2 = 2;\n'));
  assert.equal(harness(r, 'finish', 'F01-T01-I01').code, 0);
  assert.equal(harness(r, 'merge', 'F01-T01-I01').code, 0);
  let it = harness(r, 'integrate', 'ticket', 'F01-T01');
  assert.equal(it.code, 1); assert.match(it.out, /runtime acceptance red/);
  ticket(r, { id: 'F01-T01', runtime: ['node -e 0'], human: ['label reads naturally in zh-TW'] });
  it = harness(r, 'integrate', 'ticket', 'F01-T01');
  assert.equal(it.code, 0); assert.match(it.out, /label reads naturally/); assert.match(it.out, /human acceptance/);
});

test('scenario 16: disposable probe lives in scratch during /dig and is wiped when /carve starts', () => {
  const r = tmpRepo(); harness(r, 'init');
  const probe = path.join(r, '.harness/scratch/probes/perf/bench.mjs');
  assert.equal(hook('gate', { cwd: r, tool_name: 'Write', tool_input: { file_path: probe, content: 'x' } }, r).denied, false);
  fs.mkdirSync(path.dirname(probe), { recursive: true }); fs.writeFileSync(probe, 'x');
  assert.equal(hook('gate', { cwd: r, tool_name: 'Write', tool_input: { file_path: 'src/modules/identity/bench.ts', content: 'x' } }, r).denied, true);
  setMode(r, 'plan');
  assert.ok(!fs.existsSync(path.join(r, '.harness/scratch/probes')), 'probes never survive into planning');
  assert.equal(g(r, 'status', '--porcelain').includes('probes'), false, 'a probe is never a tracked file');
});
