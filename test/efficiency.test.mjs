// v1.3 efficiency scenarios: the harness pays for assurance only where it can catch something.
// 37/38 lazy env, 39 docs-only diff, 40 challenge floor, 41 adapter idempotence, 42 attach context + diff --stat + metrics.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpRepo, harness, hook, userTyped, setMode, challengerDispatched, writeIssue, ISSUE, writeManifest, MANIFEST } from './helpers.mjs';

const g = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe', encoding: 'utf8' }).trim();
const B = (cwd, command, extra = {}) => hook('gate', { cwd, tool_name: 'Bash', tool_input: { command }, tool_use_id: extra.tool_use_id || 'b1', ...extra }, cwd);
const WORKER = { agent_id: 'a1', agent_type: 'harness:worker' };
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
    const wt = workerDoes(r, 'F01-T01-I01', (w) => fs.writeFileSync(path.join(w, 'docs/a.md'), 'buy today\n'));
    assert.equal(npm.calls(), 0, 'attach must not install');
    assert.equal(B(wt, verify, WORKER).denied, false);
    assert.equal(npm.calls(), 0, 'a git command needs no runtime');
    const fin = harness(r, 'finish', 'F01-T01-I01'); assert.equal(fin.code, 0, fin.out + fin.err);
    assert.equal(harness(r, 'merge', 'F01-T01-I01').code, 0);
    assert.equal(npm.calls(), 1, 'finish installed once because the checker needs node (ticket 02 skips it for docs-only diffs)');
    assert.match(fs.readFileSync(path.join(r, 'docs/a.md'), 'utf8'), /buy today/);
  } finally { npm.restore(); }
});

test('scenario 38: the first runtime command installs exactly once; the second command and finish reuse it', { timeout: 120000 }, () => {
  const npm = stubNpm();
  try {
    const r = tmpRepo(); workReady(r);
    writeIssue(r, 'ready', ISSUE({ verify: ['npm test'] }));
    const wt = workerDoes(r, 'F01-T01-I01', (w) => fs.writeFileSync(path.join(w, 'src/modules/identity/x.ts'), 'export const x = 1;\n'));
    assert.equal(npm.calls(), 0);
    assert.equal(B(wt, 'npm test', WORKER).denied, false);
    assert.equal(npm.calls(), 1, 'install ran once before the first runtime command');
    assert.equal(JSON.parse(fs.readFileSync(path.join(r, '.harness/runtime/leases/F01-T01-I01.json'), 'utf8')).env_ready, true);
    assert.equal(B(wt, 'npm test', { ...WORKER, tool_use_id: 'b2' }).denied, false);
    assert.equal(npm.calls(), 1, 'no duplicate setup');
    const fin = harness(r, 'finish', 'F01-T01-I01'); assert.equal(fin.code, 0, fin.out + fin.err);
    assert.equal(npm.calls(), 2, 'finish ran `npm test` (stub) but not the install again');
    assert.ok(!JSON.parse(fin.out).steps.some((s) => s.step === 'environment'));
  } finally { npm.restore(); }
});
