// Legacy surface, evidence router, runtime-only defect, acceptance contract, disposable probes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpRepo, harness, hook, writeIssue, writeFeature, ISSUE, writeManifest, workReady, workerDoes } from './helpers.mjs';

const g = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();

test('scenario 12: legacy adoption — managed surface starts without cleaning the repo; legacy shrinks, never grows', { timeout: 120000 }, () => {
  const r = tmpRepo();
  fs.rmSync(path.join(r, 'package.json'));
  for (const d of ['pkg/identity', 'pkg/old', 'pkg/app']) fs.mkdirSync(path.join(r, d), { recursive: true });
  fs.writeFileSync(path.join(r, 'pkg/__init__.py'), '');
  fs.writeFileSync(path.join(r, 'pkg/identity/__init__.py'), 'from pkg.old.facade import legacy_users\n');
  fs.writeFileSync(path.join(r, 'pkg/old/__init__.py'), '');
  fs.writeFileSync(path.join(r, 'pkg/old/facade.py'), 'from .internal import users as legacy_users\n');
  fs.writeFileSync(path.join(r, 'pkg/old/internal.py'), 'import os, sys, json\nusers = []\nfrom pkg.app.main import x\n');
  fs.writeFileSync(path.join(r, 'pkg/app/__init__.py'), '');
  fs.writeFileSync(path.join(r, 'pkg/app/main.py'), 'x = 1\n');
  fs.writeFileSync(path.join(r, 'pyproject.toml'), '[project]\nname="t"\nversion="0"\n');
  g(r, 'add', '.'); g(r, 'commit', '-qm', 'legacy');
  harness(r, 'init');
  const m = {
    stack: 'python', app_shell: ['pkg/app/**'],
    modules: { identity: { root: 'pkg/identity', public: 'pkg/identity/__init__.py', may_depend_on: [], owns: ['pkg/identity/**'] } },
    resources: {}, verify: { test: 'python -c 0' },
    legacy: ['pkg/old/**'], legacy_facades: ['pkg/old/facade.py'],
  };
  writeManifest(r, m);
  assert.equal(harness(r, 'adapter', 'apply', '--approved').code, 0);
  assert.equal(harness(r, 'adapter', 'check').code, 0, harness(r, 'adapter', 'check').out);
  fs.writeFileSync(path.join(r, 'pkg/identity/leak.py'), 'from pkg.old.internal import users\n');
  const c = harness(r, 'adapter', 'check');
  assert.equal(c.code, 1); assert.match(c.out, /legacy internals/);
  fs.rmSync(path.join(r, 'pkg/identity/leak.py'));
  writeFeature(r);
  writeIssue(r, 'ready', ISSUE({ touch: ['pkg/old/**'], do_not_touch: [], verify: ['python -c 0'] }));
  let v = harness(r, 'validate'); assert.equal(v.code, 1); assert.match(v.out, /legacy_migration/);
  writeIssue(r, 'ready', ISSUE({ touch: ['pkg/old/**'], do_not_touch: [], verify: ['python -c 0'], legacy_migration: true, review: 'planner' }));
  assert.equal(harness(r, 'validate').code, 0, harness(r, 'validate').out);
  m.modules.oldy = { root: 'pkg/old', public: 'pkg/old/__init__.py', may_depend_on: [], owns: ['pkg/old/**'] };
  writeManifest(r, m);
  assert.match(harness(r, 'validate').out, /inside a legacy glob/);
});

test('scenario 13: utility routing — long red output goes to a log file, the blocked body stays short', { timeout: 120000 }, () => {
  const r = tmpRepo(); workReady(r);
  const noisy = 'node -e "for(let i=0;i<60;i++)console.log(\'line \'+i);process.exit(1)"';
  writeIssue(r, 'ready', ISSUE({ verify: [noisy] }));
  workerDoes(r, 'F01-I01', (wt) => fs.writeFileSync(path.join(wt, 'src/modules/identity/a.ts'), 'export const a2 = 2;\n'));
  const fin = harness(r, 'finish', 'F01-I01');
  assert.equal(fin.code, 1);
  const res = JSON.parse(fin.out);
  assert.ok(res.log && /harness:utility/.test(res.log), JSON.stringify(res));
  const body = fs.readFileSync(path.join(r, '.work/blocked/F01-I01.md'), 'utf8');
  assert.ok((body.match(/^- line/gm) || []).length <= 8, 'blocked body carries only a tail');
  const logs = fs.readdirSync(path.join(r, '.harness/runtime/logs'));
  assert.equal(logs.length, 1);
  assert.ok(fs.readFileSync(path.join(r, '.harness/runtime/logs', logs[0]), 'utf8').includes('line 0'));
});

test('scenario 14: runtime-only defect — unit/typecheck/build green but smoke red: the issue cannot complete', { timeout: 120000 }, () => {
  const r = tmpRepo(); workReady(r, { verify: { test: 'npm test', smoke: 'node -e "process.exit(1)"' } });
  writeIssue(r, 'ready', ISSUE({ verify: ['npm test'] }));
  workerDoes(r, 'F01-I01', (wt) => fs.writeFileSync(path.join(wt, 'src/modules/identity/b.ts'), 'export const b2 = 2;\n'));
  assert.equal(harness(r, 'finish', 'F01-I01').code, 0);
  const m = harness(r, 'merge', 'F01-I01');
  assert.equal(m.code, 1); assert.match(m.out, /runtime smoke red/);
  assert.ok(fs.existsSync(path.join(r, '.work/blocked/F01-I01.md')));
  assert.ok(!fs.existsSync(path.join(r, 'src/modules/identity/b.ts')), 'merge was rolled back');
  assert.equal(g(r, 'status', '--porcelain').split('\n').filter((l) => !l.includes('.work/')).filter(Boolean).length, 0);
});

test('acceptance contract: feature runtime slot runs at integration, human items are surfaced, never auto-closed', { timeout: 120000 }, () => {
  const r = tmpRepo(); workReady(r, {}, { runtime: ['node -e "process.exit(2)"'], human: ['label reads naturally in zh-TW'] });
  writeIssue(r, 'ready', ISSUE({ verify: ['npm test'] }));
  workerDoes(r, 'F01-I01', (wt) => fs.writeFileSync(path.join(wt, 'src/modules/identity/c.ts'), 'export const c2 = 2;\n'));
  assert.equal(harness(r, 'finish', 'F01-I01').code, 0);
  assert.equal(harness(r, 'merge', 'F01-I01').code, 0);
  let it = harness(r, 'integrate', 'feature', 'F01');
  assert.equal(it.code, 1); assert.match(it.out, /runtime acceptance red/);
  writeFeature(r, { runtime: ['node -e 0'], human: ['label reads naturally in zh-TW'] });
  it = harness(r, 'integrate', 'feature', 'F01');
  assert.equal(it.code, 0, it.out); assert.match(it.out, /label reads naturally/); assert.match(it.out, /human acceptance/);
  assert.ok(fs.existsSync(path.join(r, '.work/features/F01.md')), 'integration never closes');
});

test('scenario 16: a disposable probe lives in scratch and is gone once the feature closes; a feature with no branch works in place', { timeout: 120000 }, () => {
  const r = tmpRepo(); workReady(r);
  const probe = path.join(r, '.harness/scratch/probes/perf/bench.mjs');
  fs.mkdirSync(path.dirname(probe), { recursive: true }); fs.writeFileSync(probe, 'x');
  assert.equal(hook('gate', { cwd: r, tool_name: 'Write', tool_input: { file_path: probe, content: 'x' } }, r).denied, false);
  assert.equal(g(r, 'status', '--porcelain').includes('probes'), false, 'a probe is never a tracked file');
  const proto = path.join(r, '.harness/scratch/prototype/dash/index.html');
  fs.mkdirSync(path.dirname(proto), { recursive: true }); fs.writeFileSync(proto, '<h1>x</h1>');
  assert.equal(hook('gate', { cwd: r, tool_name: 'Write', tool_input: { file_path: proto, content: 'x' }, agent_type: 'prototyper' }, r).denied, false, 'the prototyper is not a worker');
  assert.equal(hook('gate', { cwd: r, tool_name: 'Agent', tool_input: { subagent_type: 'harness:prototyper' } }, r).denied, false, 'prototyper dispatch needs no lease');
  assert.match(harness(r, 'feature', 'start', 'F01').out, /no branch declared/);
  writeIssue(r, 'ready', ISSUE({ verify: ['npm test'] }));
  const wt = workerDoes(r, 'F01-I01', (wt) => fs.writeFileSync(path.join(wt, 'src/modules/identity/d.ts'), 'export const d = 1;\n'));
  assert.match(harness(wt, 'attach', 'F01-I01').out, /prototype \(visual reference, read only\): \S*scratch\/prototype\/dash/, 'attach hands the worker the prototype path');
  assert.equal(harness(r, 'finish', 'F01-I01').code, 0);
  assert.equal(harness(r, 'merge', 'F01-I01').code, 0);
  assert.equal(harness(r, 'integrate', 'feature', 'F01').code, 0);
  const cl = harness(r, 'close', 'feature', 'F01'); assert.equal(cl.code, 0, cl.err);
  assert.equal(JSON.parse(cl.out).merged, undefined);
  assert.equal(g(r, 'branch', '--show-current'), 'main');
  assert.ok(!fs.existsSync(path.join(r, '.harness/scratch/probes')), 'scratch cleared at close');
  assert.ok(!fs.existsSync(path.join(r, '.harness/scratch/prototype')), 'prototype cleared at close');
});
