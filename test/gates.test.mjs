import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { tmpRepo, harness, hook, userTyped, setMode, challengerDispatched, writeIssue, ISSUE, writeManifest, MANIFEST, addWorktree } from './helpers.mjs';

const W = (cwd, file, extra = {}) => hook('gate', { cwd, tool_name: 'Write', tool_input: { file_path: file, content: 'x' }, tool_use_id: 't1', ...extra }, cwd);
const git = (cwd, ...a) => execFileSync('git', a, { cwd, stdio: 'pipe' });
const B = (cwd, command, extra = {}) => hook('gate', { cwd, tool_name: 'Bash', tool_input: { command }, tool_use_id: extra.tool_use_id || 'b1', ...extra }, cwd);

test('inert without .harness', () => {
  const r = tmpRepo();
  assert.equal(W(r, 'src/app/main.ts').denied, false);
});

test('init refuses outside git, creates state in git', () => {
  const nogit = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'nogit-'));
  assert.equal(harness(nogit, 'init').code, 1);
  const r = tmpRepo();
  assert.equal(harness(r, 'init').code, 0);
  assert.equal(JSON.parse(fs.readFileSync(path.join(r, '.harness/state.json'))).mode, 'grill');
  assert.match(fs.readFileSync(path.join(r, '.gitignore'), 'utf8'), /^\.harness\/$/m);
});

test('scenario 8: No-Build gate in grill mode denies source, allows scratch, denies planner/worker dispatch', () => {
  const r = tmpRepo(); harness(r, 'init');
  const d = W(r, 'src/modules/identity/index.ts');
  assert.equal(d.denied, true); assert.match(d.reason, /No-Build/);
  assert.equal(W(r, '.harness/scratch/discovery.md').denied, false);
  assert.equal(W(r, path.join(process.env.TEMP || '/tmp', 'outside.txt')).denied, false);
  const a = hook('gate', { cwd: r, tool_name: 'Agent', tool_input: { subagent_type: 'harness:worker', prompt: 'x' } }, r);
  assert.equal(a.denied, true);
  assert.equal(hook('gate', { cwd: r, tool_name: 'Agent', tool_input: { subagent_type: 'Explore', prompt: 'x' } }, r).denied, false);
});

test('only the user ends grill: mode refuses without a matching user prompt', () => {
  const r = tmpRepo(); harness(r, 'init');
  assert.equal(harness(r, 'mode', 'plan').code, 1);
  userTyped(r, 'please just start planning');
  assert.equal(harness(r, 'mode', 'plan').code, 1);
  userTyped(r, '/carve');
  assert.equal(harness(r, 'mode', 'plan').code, 0);
  userTyped(r, '/harness:crank');
  writeManifest(r);
  // scenario 10: the planner cannot be the only validator of its own draft — no challenge, no /crank
  const noCh = harness(r, 'mode', 'work');
  assert.equal(noCh.code, 1); assert.match(noCh.err, /Independent Challenge/);
  const anchored = hook('gate', { cwd: r, tool_name: 'Agent', tool_input: { subagent_type: 'harness:challenger', prompt: 'Here is my reasoning and rationale for the plan…' } }, r);
  assert.equal(anchored.denied, true); // reviewer must not read the author's defence
  assert.equal(challengerDispatched(r, 'Challenge this draft.').denied, false);
  userTyped(r, '/harness:crank');
  assert.equal(harness(r, 'mode', 'work').code, 0);
  // a new planning round invalidates the old challenge; below the machine floor (architecture unchanged, no ticket,
  // no planner-reviewed issue) work opens without one, above it (architecture edited) the challenge is demanded again
  userTyped(r, '/carve'); assert.equal(harness(r, 'mode', 'plan').code, 0);
  userTyped(r, '/crank'); const below = harness(r, 'mode', 'work'); assert.equal(below.code, 0); assert.match(below.out, /challenge: not required/);
  userTyped(r, '/carve'); assert.equal(harness(r, 'mode', 'plan').code, 0);
  writeManifest(r, undefined, '\n# Architecture\nedited\n');
  userTyped(r, '/crank'); const above = harness(r, 'mode', 'work'); assert.equal(above.code, 1); assert.match(above.err, /ARCHITECTURE\.md changed/);
});

test('grill Bash that changes source is a recorded violation and blocks mode change', () => {
  const r = tmpRepo(); harness(r, 'init');
  const pre = B(r, 'echo hacked > src/app/main.ts');
  assert.equal(pre.denied, false);
  fs.writeFileSync(path.join(r, 'src/app/main.ts'), 'hacked');
  const post = hook('post', { cwd: r, tool_name: 'Bash', tool_input: { command: 'echo' }, tool_use_id: 'b1' }, r);
  assert.equal(post.code, 2); assert.match(post.err, /src\/app\/main\.ts/);
  userTyped(r, '/carve');
  const m = harness(r, 'mode', 'plan');
  assert.equal(m.code, 1); assert.match(m.err, /violations/);
  // SPEC §3: reverting the file clears it
  git(r, 'checkout', '--', 'src/app/main.ts');
  assert.equal(harness(r, 'mode', 'plan').code, 0);
});

test('a violation is cleared by reverting the content, never by committing it', () => {
  const r = tmpRepo(); harness(r, 'init');
  B(r, 'echo hacked > src/app/main.ts');
  fs.writeFileSync(path.join(r, 'src/app/main.ts'), 'hacked');
  assert.equal(hook('post', { cwd: r, tool_name: 'Bash', tool_input: { command: 'echo' }, tool_use_id: 'b1' }, r).code, 2);
  git(r, 'add', '-A'); git(r, 'commit', '-qm', 'launder');           // tree is clean now, but the change landed
  userTyped(r, '/carve');
  const m = harness(r, 'mode', 'plan'); assert.equal(m.code, 1); assert.match(m.err, /violations/);
  git(r, 'checkout', 'HEAD~1', '--', 'src/app/main.ts'); git(r, 'commit', '-qam', 'undo'); // content back → cleared
  assert.equal(harness(r, 'mode', 'plan').code, 0);
});

test('plan mode: ARCHITECTURE.md and .work allowed, source denied; invalid manifest reported after write', () => {
  const r = tmpRepo(); harness(r, 'init'); setMode(r, 'plan');
  assert.equal(W(r, 'ARCHITECTURE.md').denied, false);
  assert.equal(W(r, '.work/ready/F01-T01-I01.md').denied, false);
  assert.equal(W(r, 'src/modules/identity/index.ts').denied, true);
  const bad = MANIFEST(); bad.modules.identity.may_depend_on = ['billing']; // cycle
  writeManifest(r, bad);
  const post = hook('post', { cwd: r, tool_name: 'Write', tool_input: { file_path: 'ARCHITECTURE.md' } }, r);
  assert.equal(post.code, 2); assert.match(post.err, /cycle/);
  writeManifest(r);
  assert.equal(hook('post', { cwd: r, tool_name: 'Write', tool_input: { file_path: 'ARCHITECTURE.md' } }, r).code, 0);
});

test('work mode: main tree is orchestration only; claim is atomic and needs deps; worker dispatch needs a lease', () => {
  const r = tmpRepo(); harness(r, 'init'); writeManifest(r); setMode(r, 'plan'); setMode(r, 'work');
  assert.equal(W(r, 'src/modules/identity/index.ts').denied, true);
  assert.equal(W(r, '.work/blocked/F01-T01-I01.md').denied, false);
  const dispatch = () => hook('gate', { cwd: r, tool_name: 'Agent', tool_input: { subagent_type: 'harness:worker', prompt: 'x' } }, r);
  assert.equal(dispatch().denied, true);
  writeIssue(r, 'ready', ISSUE());
  writeIssue(r, 'ready', ISSUE({ id: 'F01-T01-I02', after: ['F01-T01-I01'], touch: ['src/modules/billing/**'], do_not_touch: [] }));
  assert.equal(harness(r, 'claim', 'F01-T01-I02').code, 1); // dep not done
  assert.equal(harness(r, 'claim', 'F01-T01-I01').code, 0);
  assert.equal(harness(r, 'claim', 'F01-T01-I01').code, 1); // already claimed
  assert.ok(fs.existsSync(path.join(r, '.work/doing/F01-T01-I01.md')));
  assert.equal(dispatch().denied, false);
});

test('scenario 3+4: worker scope gate — touch allowed, do_not_touch denied, main tree denied, Bash exact-match only, post-diff violation', () => {
  const r = tmpRepo(); harness(r, 'init'); writeManifest(r); setMode(r, 'plan'); setMode(r, 'work');
  writeIssue(r, 'ready', ISSUE());
  assert.equal(harness(r, 'claim', 'F01-T01-I01').code, 0);
  const wt = addWorktree(r, 'F01-T01-I01');
  const agent = { agent_id: 'a1', agent_type: 'harness:worker' };
  // before attach: everything denied except the attach call
  assert.equal(W(wt, 'src/modules/identity/x.ts', agent).denied, true);
  assert.equal(B(wt, 'npm test', agent).denied, true);
  const attachCmd = `node "${path.join(process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dirname, '..'), 'bin/harness.mjs')}" attach F01-T01-I01`;
  assert.equal(B(wt, attachCmd, agent).denied, false);
  assert.equal(harness(wt, 'attach', 'F01-T01-I01').code, 0);
  // after attach
  assert.equal(W(wt, 'src/modules/identity/x.ts', agent).denied, false);
  assert.equal(W(wt, 'src/modules/billing/index.ts', agent).denied, true);
  assert.equal(W(wt, 'src/app/main.ts', agent).denied, true);
  assert.equal(W(wt, path.join(r, 'src/modules/identity/x.ts'), agent).denied, true); // main tree via absolute path
  assert.equal(W(wt, 'ARCHITECTURE.md', agent).denied, true);
  assert.equal(B(wt, 'npm test', agent).denied, false);
  assert.equal(B(wt, 'npm test && rm -rf src', agent).denied, true);
  assert.equal(B(wt, 'sed -i s/a/b/ src/app/main.ts', agent).denied, true);
  // allowed Bash that nevertheless changes a file outside touch → violation, Bash disabled
  B(wt, 'npm test', { ...agent, tool_use_id: 'b9' });
  fs.writeFileSync(path.join(wt, 'src/app/main.ts'), 'escaped');
  const post = hook('post', { cwd: wt, tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_use_id: 'b9', ...agent }, wt);
  assert.equal(post.code, 2); assert.match(post.err, /src\/app\/main\.ts/);
  assert.equal(B(wt, 'npm test', agent).denied, true);
  assert.match(B(wt, 'npm test', agent).reason, /violated/);
});

test('issue validation catches unsafe issues', () => {
  const r = tmpRepo(); harness(r, 'init'); setMode(r, 'plan');
  const f = writeIssue(r, 'ready', ISSUE({ interface_change: true, review: 'none' }));
  let post = hook('post', { cwd: r, tool_name: 'Write', tool_input: { file_path: f } }, r);
  assert.equal(post.code, 2); assert.match(post.err, /interface_change requires review: planner/);
  writeIssue(r, 'ready', ISSUE({ touch: ['package.json'] }));
  post = hook('post', { cwd: r, tool_name: 'Write', tool_input: { file_path: f } }, r);
  assert.match(post.err, /dependency files requires review: planner/);
  writeIssue(r, 'ready', ISSUE());
  assert.equal(hook('post', { cwd: r, tool_name: 'Write', tool_input: { file_path: f } }, r).code, 0);
});

test('scenario 9: a user idea in grill never reaches ARCHITECTURE.md; session hook reports state', () => {
  const r = tmpRepo(); harness(r, 'init');
  userTyped(r, 'maybe billing should own users after all, what do you think?');
  const d = W(r, 'ARCHITECTURE.md');
  assert.equal(d.denied, true); assert.match(d.reason, /No-Build/);
  const s = hook('session', { cwd: r, session_start_reason: 'startup' }, r);
  assert.match(s.out, /mode=grill/); assert.match(s.out, /only the user ends \/dig/);
});

test('review: planner issues cannot be merged without a hook-signed review receipt', () => {
  const r = tmpRepo(); harness(r, 'init'); writeManifest(r); setMode(r, 'plan'); setMode(r, 'work');
  writeIssue(r, 'ready', ISSUE({ interface_change: true, review: 'planner' }));
  assert.equal(harness(r, 'claim', 'F01-T01-I01').code, 0);
  const lease = JSON.parse(fs.readFileSync(path.join(r, '.harness/runtime/leases/F01-T01-I01.json')));
  lease.finished = true; lease.head_sha = 'HEAD'; lease.worktree = r;
  fs.writeFileSync(path.join(r, '.harness/runtime/leases/F01-T01-I01.json'), JSON.stringify(lease));
  const m = harness(r, 'merge', 'F01-T01-I01');
  assert.equal(m.code, 1); assert.match(m.err, /needs planner review/);
});

test('paths are canonical: a hook cwd through a junction/short name still resolves to the attached worktree lease', () => {
  const r = tmpRepo(); harness(r, 'init'); writeManifest(r); setMode(r, 'plan'); setMode(r, 'work');
  writeIssue(r, 'ready', ISSUE());
  assert.equal(harness(r, 'claim', 'F01-T01-I01').code, 0);
  const wt = addWorktree(r, 'F01-T01-I01');
  assert.equal(harness(wt, 'attach', 'F01-T01-I01').code, 0);
  const alias = path.join(process.env.TEMP || '/tmp', `harness-alias-${Date.now()}`);
  fs.symlinkSync(wt, alias, process.platform === 'win32' ? 'junction' : 'dir'); // CI runners hand hooks RUNNER~1-style cwds
  const agent = { agent_id: 'a1', agent_type: 'harness:worker' };
  assert.equal(W(alias, 'src/modules/identity/x.ts', agent).denied, false);
  assert.equal(W(alias, 'src/app/main.ts', agent).denied, true);
  fs.rmSync(alias, { recursive: false, force: true });
});
