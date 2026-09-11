// Pay for assurance only where it can catch something: lazy env, docs-only fast path, checker skipped when absent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpRepo, harness, hook, writeIssue, ISSUE, workReady, workerDoes } from './helpers.mjs';

const g = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
const B = (cwd, command, extra = {}) => hook('gate', { cwd, tool_name: 'Bash', tool_input: { command }, tool_use_id: extra.tool_use_id || 'b1', ...extra }, cwd);
const WORKER = { agent_id: 'a1', agent_type: 'harness:worker' };
// A fake `npm` first on PATH that only counts its invocations: the tests assert when the install did and did not run.
function stubNpm() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'npm-stub-'));
  const marker = path.join(dir, 'calls.txt').replace(/\\/g, '/');
  fs.writeFileSync(path.join(dir, 'npm.cmd'), `@echo x>> "${marker}"\r\n@exit /b 0\r\n`);
  fs.writeFileSync(path.join(dir, 'npm'), `#!/bin/sh\necho x >> "${marker}"\nexit 0\n`, { mode: 0o755 });
  const prev = process.env.PATH;
  process.env.PATH = dir + path.delimiter + prev;
  return { calls: () => (fs.existsSync(marker) ? (fs.readFileSync(marker, 'utf8').match(/x/g) || []).length : 0), restore: () => { process.env.PATH = prev; } };
}

test('scenario 37: a copy-only issue never installs dependencies — attach, worker Bash, finish, merge all stay cold', { timeout: 120000 }, () => {
  const npm = stubNpm();
  try {
    const r = tmpRepo(); workReady(r);
    fs.mkdirSync(path.join(r, 'docs'), { recursive: true }); fs.writeFileSync(path.join(r, 'docs/a.md'), 'buy now\n'); g(r, 'add', '-A'); g(r, 'commit', '-qm', 'docs');
    const verify = 'git grep -q "buy today" -- docs/a.md';
    writeIssue(r, 'ready', ISSUE({ touch: ['docs/**'], do_not_touch: [], verify: [verify] }));
    const wt = workerDoes(r, 'F01-I01', (w) => fs.writeFileSync(path.join(w, 'docs/a.md'), 'buy today\n'));
    assert.equal(npm.calls(), 0, 'attach must not install');
    assert.equal(B(wt, verify, WORKER).denied, false);
    assert.equal(npm.calls(), 0, 'a git command needs no runtime');
    const fin = harness(r, 'finish', 'F01-I01'); assert.equal(fin.code, 0, fin.out + fin.err);
    assert.ok(JSON.parse(fin.out).steps.some((s) => s.step === 'container checker' && s.skipped));
    const m = harness(r, 'merge', 'F01-I01'); assert.equal(m.code, 0, m.err); assert.match(JSON.parse(m.out).skipped, /docs-only/);
    assert.equal(npm.calls(), 0, 'finish/merge on a docs-only diff never installed');
    assert.match(fs.readFileSync(path.join(r, 'docs/a.md'), 'utf8'), /buy today/);
  } finally { npm.restore(); }
});

test('scenario 39: a docs-only diff skips typecheck/build/smoke; the same issue touching code runs them', { timeout: 120000 }, () => {
  const marker = path.join(os.tmpdir(), `harness-tc-${Date.now()}.txt`).replace(/\\/g, '/');
  const touchMarker = `node -e "require('fs').appendFileSync('${marker}','x')"`;
  const r = tmpRepo(); workReady(r, { verify: { test: 'npm test', typecheck: touchMarker, smoke: touchMarker } });
  fs.mkdirSync(path.join(r, 'docs'), { recursive: true }); fs.writeFileSync(path.join(r, 'docs/a.md'), 'a\n'); g(r, 'add', '-A'); g(r, 'commit', '-qm', 'docs');
  writeIssue(r, 'ready', ISSUE({ touch: ['docs/**', 'src/modules/identity/**'], do_not_touch: [], verify: ['git status'] }));
  workerDoes(r, 'F01-I01', (w) => fs.writeFileSync(path.join(w, 'docs/a.md'), 'b\n'));
  let fin = JSON.parse(harness(r, 'finish', 'F01-I01').out);
  assert.equal(fin.ok, true); assert.ok(fin.steps.some((s) => s.step === 'typecheck' && s.skipped === 'docs-only diff'));
  assert.equal(harness(r, 'merge', 'F01-I01').code, 0);
  assert.ok(!fs.existsSync(marker), 'typecheck and smoke never ran for prose');
  writeIssue(r, 'ready', ISSUE({ id: 'F01-I02', touch: ['docs/**', 'src/modules/identity/**'], do_not_touch: [], verify: ['git status'] }));
  workerDoes(r, 'F01-I02', (w) => { fs.writeFileSync(path.join(w, 'docs/a.md'), 'c\n'); fs.writeFileSync(path.join(w, 'src/modules/identity/y.ts'), 'export const y = 1;\n'); });
  fin = JSON.parse(harness(r, 'finish', 'F01-I02').out);
  assert.equal(fin.ok, true, JSON.stringify(fin)); assert.ok(fin.steps.some((s) => s.step.startsWith('typecheck:') && s.ok));
  assert.equal(harness(r, 'merge', 'F01-I02').code, 0);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'xx', 'typecheck at finish + smoke at merge');
  fs.rmSync(marker);
});

test('scenario 38: the first runtime command installs exactly once; the second command and finish reuse it', { timeout: 120000 }, () => {
  const npm = stubNpm();
  try {
    const r = tmpRepo(); workReady(r);
    writeIssue(r, 'ready', ISSUE({ verify: ['npm test'] }));
    const wt = workerDoes(r, 'F01-I01', (w) => fs.writeFileSync(path.join(w, 'src/modules/identity/x.ts'), 'export const x = 1;\n'));
    assert.equal(npm.calls(), 0);
    assert.equal(B(wt, 'npm test', WORKER).denied, false);
    assert.equal(npm.calls(), 1, 'install ran once before the first runtime command');
    assert.equal(JSON.parse(fs.readFileSync(path.join(r, '.harness/runtime/leases/F01-I01.json'), 'utf8')).env_ready, true);
    assert.equal(B(wt, 'npm test', { ...WORKER, tool_use_id: 'b2' }).denied, false);
    assert.equal(npm.calls(), 1, 'no duplicate setup');
    const fin = harness(r, 'finish', 'F01-I01'); assert.equal(fin.code, 0, fin.out + fin.err);
    assert.equal(npm.calls(), 2, 'finish ran `npm test` (stub) but not the install again');
    assert.ok(!JSON.parse(fin.out).steps.some((s) => s.step === 'environment'));
  } finally { npm.restore(); }
});

test('no ARCHITECTURE.md: the whole chain runs with the architecture container off — checker skipped, scope and verify still enforced', { timeout: 120000 }, () => {
  const r = tmpRepo(); workReady(r, null);
  assert.match(harness(r, 'validate').out, /architecture checks off/);
  assert.match(harness(r, 'adapter', 'check').out, /skipped: no ARCHITECTURE\.md/);
  writeIssue(r, 'ready', ISSUE({ verify: ['npm test'] }));
  workerDoes(r, 'F01-I01', (w) => fs.writeFileSync(path.join(w, 'src/modules/identity/x.ts'), 'export const x = 1;\n'));
  const fin = JSON.parse(harness(r, 'finish', 'F01-I01').out);
  assert.equal(fin.ok, true, JSON.stringify(fin));
  assert.ok(fin.steps.some((s) => s.step === 'container checker' && s.skipped === 'no ARCHITECTURE.md'));
  assert.equal(harness(r, 'merge', 'F01-I01').code, 0);
  // scope is still a hard line
  writeIssue(r, 'ready', ISSUE({ id: 'F01-I02', verify: ['npm test'] }));
  workerDoes(r, 'F01-I02', (w) => fs.writeFileSync(path.join(w, 'src/app/main.ts'), 'escaped'));
  const bad = harness(r, 'finish', 'F01-I02'); assert.equal(bad.code, 1); assert.match(bad.out, /scope post-diff/);
});

test('a stack without an adapter, or a resource kind without an analyzer, is skipped — never a reason to stop', () => {
  const r = tmpRepo(); harness(r, 'init');
  writeManifestGo(r);
  const plan = harness(r, 'adapter', 'plan'); assert.equal(plan.code, 0, plan.err); assert.match(plan.out, /no checker adapter for this stack/);
  assert.equal(harness(r, 'adapter', 'apply', '--approved').code, 1); // nothing to apply, says so
  const chk = harness(r, 'adapter', 'check'); assert.equal(chk.code, 0); assert.match(chk.out, /skipped: no checker wired for stack go/);
  assert.equal(harness(r, 'validate').code, 0, harness(r, 'validate').out);
});
function writeManifestGo(r) {
  fs.writeFileSync(path.join(r, 'ARCHITECTURE.md'), `---\n${JSON.stringify({
    stack: 'go', app_shell: ['cmd/**'],
    modules: { identity: { root: 'internal/identity', public: 'internal/identity/api.go', may_depend_on: [], owns: ['internal/identity/**'] } },
    resources: { users: { owner: 'identity', kind: 'gorm-model', definition: ['internal/identity/models.go'], symbol: 'User' } },
    verify: { test: 'go test ./...' },
  })}\n---\n# Architecture\n`);
}
