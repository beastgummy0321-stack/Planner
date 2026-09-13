// The execution container: the only thing the hooks gate. Everything else is free.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpRepo, harness, hook, userTyped, writeIssue, writeFeature, ISSUE, writeManifest, MANIFEST, addWorktree, workReady, PLUGIN } from './helpers.mjs';

const W = (cwd, file, extra = {}) => hook('gate', { cwd, tool_name: 'Write', tool_input: { file_path: file, content: 'x' }, tool_use_id: 't1', ...extra }, cwd);
const B = (cwd, command, extra = {}) => hook('gate', { cwd, tool_name: 'Bash', tool_input: { command }, tool_use_id: extra.tool_use_id || 'b1', ...extra }, cwd);
const AGENT = (cwd, subagent_type, prompt = 'x') => hook('gate', { cwd, tool_name: 'Agent', tool_input: { subagent_type, prompt } }, cwd);
const WORKER = { agent_id: 'a1', agent_type: 'harness:worker' };

test('inert without .harness', () => {
  const r = tmpRepo();
  assert.equal(W(r, 'src/app/main.ts').denied, false);
});

test('init refuses outside git; creates .harness and .work/features in git', () => {
  const nogit = fs.mkdtempSync(path.join(process.env.TEMP || '/tmp', 'nogit-'));
  assert.equal(harness(nogit, 'init').code, 1);
  const r = tmpRepo();
  assert.equal(harness(r, 'init').code, 0);
  assert.ok(fs.existsSync(path.join(r, '.harness/state.json')));
  assert.ok(fs.existsSync(path.join(r, '.work/features')));
  assert.match(fs.readFileSync(path.join(r, '.gitignore'), 'utf8'), /^\.harness\/$/m);
});

test('the frontier is never locked: source, ARCHITECTURE.md, .work and scratch are all writable; planner and challenger dispatch is free', () => {
  const r = tmpRepo(); harness(r, 'init');
  for (const f of ['src/modules/identity/index.ts', 'ARCHITECTURE.md', '.work/ready/F01-I01.md', '.harness/scratch/discovery.md', path.join(process.env.TEMP || '/tmp', 'outside.txt')]) {
    assert.equal(W(r, f).denied, false, f);
  }
  assert.equal(AGENT(r, 'harness:planner').denied, false);
  assert.equal(AGENT(r, 'harness:challenger', 'Here is my reasoning and rationale…').denied, false); // a skill rule, not a gate
  assert.equal(AGENT(r, 'harness:utility').denied, false);
  assert.equal(AGENT(r, 'Explore').denied, false);
  // main-conversation Bash is free too: no baseline, no violation
  assert.equal(B(r, 'npm test').denied, false);
  assert.equal(B(r, 'echo hacked > src/app/main.ts').denied, false);
  fs.writeFileSync(path.join(r, 'src/app/main.ts'), 'hacked');
  assert.equal(hook('post', { cwd: r, tool_name: 'Bash', tool_input: { command: 'echo' }, tool_use_id: 'b1' }, r).code, 0);
  assert.ok(!fs.existsSync(path.join(r, '.harness/runtime/baselines/b1.json')));
});

test('destructive reflex: resets, cleans, rm -rf, force push are denied for everyone before they run; package installs and single-file reverts are not', () => {
  const r = tmpRepo(); harness(r, 'init');
  for (const cmd of ['git reset --hard HEAD~1', 'git clean -fd', 'rm -rf src', 'git push --force origin main', 'git branch -D main']) {
    const d = B(r, cmd); assert.equal(d.denied, true, cmd); assert.match(d.reason, /destructive/);
    assert.equal(B(r, cmd, { agent_type: 'harness:utility', agent_id: 'u1' }).denied, true, cmd);
  }
  for (const cmd of ['npm install zod', 'git checkout -- src/app/main.ts', 'git restore src/app/main.ts', 'git log --oneline -5', 'node .harness/scratch/probes/bench/run.mjs']) {
    assert.equal(B(r, cmd).denied, false, cmd);
  }
  assert.ok(fs.existsSync(path.join(r, 'src/modules/identity/index.ts')), 'nothing was destroyed');
});

test('worker dispatch needs a claimed issue; claim is atomic and needs deps', () => {
  const r = tmpRepo(); workReady(r);
  assert.equal(AGENT(r, 'harness:worker').denied, true);
  writeIssue(r, 'ready', ISSUE());
  writeIssue(r, 'ready', ISSUE({ id: 'F01-I02', after: ['F01-I01'], touch: ['src/modules/billing/**'], do_not_touch: [] }));
  userTyped(r, 'go');
  assert.equal(harness(r, 'claim', 'F01-I02').code, 1); // dep not done
  assert.equal(harness(r, 'claim', 'F01-I01').code, 0);
  assert.equal(harness(r, 'claim', 'F01-I01').code, 1); // already claimed
  assert.ok(fs.existsSync(path.join(r, '.work/doing/F01-I01.md')));
  assert.equal(AGENT(r, 'harness:worker').denied, false);
});

test('scenario 3+4: worker scope gate — touch allowed, do_not_touch / main tree / .work denied; Bash open but diffed; a change outside touch is a violation', () => {
  const r = tmpRepo(); workReady(r);
  writeIssue(r, 'ready', ISSUE()); userTyped(r, 'go');
  assert.equal(harness(r, 'claim', 'F01-I01').code, 0);
  const wt = addWorktree(r, 'F01-I01');
  // before attach: writes and commands denied, the attach call itself allowed
  assert.equal(W(wt, 'src/modules/identity/x.ts', WORKER).denied, true);
  assert.equal(B(wt, 'npm test', WORKER).denied, true);
  const attachCmd = `node "${path.join(PLUGIN, 'bin/harness.mjs')}" attach F01-I01`;
  assert.equal(B(wt, attachCmd, WORKER).denied, false);
  assert.equal(harness(wt, 'attach', 'F01-I01').code, 0);
  // after attach
  assert.equal(W(wt, 'src/modules/identity/x.ts', WORKER).denied, false);
  assert.equal(W(wt, 'src/modules/billing/index.ts', WORKER).denied, true);
  assert.equal(W(wt, 'src/app/main.ts', WORKER).denied, true);
  assert.equal(W(wt, path.join(r, 'src/modules/identity/x.ts'), WORKER).denied, true); // main tree via absolute path
  assert.equal(W(wt, 'ARCHITECTURE.md', WORKER).denied, true);
  assert.equal(W(wt, '.work/ready/F01-I02.md', WORKER).denied, true);
  // Bash is open (not exact-match any more) except destructive
  assert.equal(B(wt, 'npm test', WORKER).denied, false);
  assert.equal(B(wt, 'git grep -n foo src', WORKER).denied, false);
  assert.equal(B(wt, 'sed -i s/a/b/ src/modules/identity/index.ts', WORKER).denied, false);
  assert.equal(B(wt, 'npm test && rm -rf src', WORKER).denied, true);
  // …but every call is diffed: a change outside touch → violation, Bash disabled, finish blocks
  B(wt, 'sed -i s/a/b/ src/app/main.ts', { ...WORKER, tool_use_id: 'b9' });
  fs.writeFileSync(path.join(wt, 'src/app/main.ts'), 'escaped');
  const post = hook('post', { cwd: wt, tool_name: 'Bash', tool_input: { command: 'sed' }, tool_use_id: 'b9', ...WORKER }, wt);
  assert.equal(post.code, 2); assert.match(post.err, /src\/app\/main\.ts \(outside touch\)/);
  assert.match(B(wt, 'npm test', WORKER).reason, /violated/);
  const fin = harness(r, 'finish', 'F01-I01'); assert.equal(fin.code, 1); assert.match(fin.out, /scope violated/);
  assert.ok(fs.existsSync(path.join(r, '.work/blocked/F01-I01.md')));
  assert.ok(!fs.existsSync(wt), 'worktree discarded');
});

test('a worker Bash call that changes the main tree is a violation too', () => {
  const r = tmpRepo(); workReady(r);
  writeIssue(r, 'ready', ISSUE()); userTyped(r, 'go');
  assert.equal(harness(r, 'claim', 'F01-I01').code, 0);
  const wt = addWorktree(r, 'F01-I01');
  assert.equal(harness(wt, 'attach', 'F01-I01').code, 0);
  B(wt, 'echo x', { ...WORKER, tool_use_id: 'b2' });
  fs.writeFileSync(path.join(r, 'src/modules/identity/index.ts'), 'export const a = 2;\n'); // main tree, inside touch globs but wrong tree
  const post = hook('post', { cwd: wt, tool_name: 'Bash', tool_input: { command: 'echo x' }, tool_use_id: 'b2', ...WORKER }, wt);
  assert.equal(post.code, 2); assert.match(post.err, /index\.ts \(main tree\)/);
});

test('a control-plane move of .work/ files in the main tree during a worker Bash call is not a violation', () => {
  const r = tmpRepo(); workReady(r);
  writeIssue(r, 'ready', ISSUE()); userTyped(r, 'go');
  assert.equal(harness(r, 'claim', 'F01-I01').code, 0);
  const wt = addWorktree(r, 'F01-I01');
  assert.equal(harness(wt, 'attach', 'F01-I01').code, 0);
  B(wt, 'echo x', { ...WORKER, tool_use_id: 'b3' });
  fs.mkdirSync(path.join(r, '.work/ready'), { recursive: true });
  fs.writeFileSync(path.join(r, '.work/ready/F01-I02.md'), '# another issue claimed by the control plane\n'); // main tree, .work/
  fs.mkdirSync(path.join(r, '.harness/runtime'), { recursive: true });
  fs.writeFileSync(path.join(r, '.harness/runtime/note.json'), '{}\n');
  const post = hook('post', { cwd: wt, tool_name: 'Bash', tool_input: { command: 'echo x' }, tool_use_id: 'b3', ...WORKER }, wt);
  assert.equal(post.code, 0, post.err);
});

test('issue and feature validation after a write: unsafe shapes are reported, not denied', () => {
  const r = tmpRepo(); harness(r, 'init');
  const f = writeIssue(r, 'ready', ISSUE({ interface_change: true, review: 'none' }));
  let post = hook('post', { cwd: r, tool_name: 'Write', tool_input: { file_path: f } }, r);
  assert.equal(post.code, 2); assert.match(post.err, /interface_change requires review: planner/);
  writeIssue(r, 'ready', ISSUE({ touch: ['package.json'] }));
  post = hook('post', { cwd: r, tool_name: 'Write', tool_input: { file_path: f } }, r);
  assert.match(post.err, /dependency files requires review: planner/);
  const old = writeIssue(r, 'ready', ISSUE({ id: 'F01-T01-I01' })); // v1 id shape
  assert.match(hook('post', { cwd: r, tool_name: 'Write', tool_input: { file_path: old } }, r).err, /id must look like F01-I01/);
  fs.rmSync(old);
  writeIssue(r, 'ready', ISSUE({ group: 'auth-backend', deps: ['zod'] }));
  assert.equal(hook('post', { cwd: r, tool_name: 'Write', tool_input: { file_path: f } }, r).code, 0);
  const ff = writeFeature(r, {}, '# Outcome\nx\n');
  assert.match(hook('post', { cwd: r, tool_name: 'Write', tool_input: { file_path: ff } }, r).err, /missing section # Decisions/);
  writeFeature(r);
  assert.equal(hook('post', { cwd: r, tool_name: 'Write', tool_input: { file_path: ff } }, r).code, 0);
  // manifest: a cycle is reported; an unknown stack and an unknown resource kind are legal (uncheckered / unanalyzed)
  const bad = MANIFEST(); bad.modules.identity.may_depend_on = ['billing'];
  writeManifest(r, bad);
  post = hook('post', { cwd: r, tool_name: 'Write', tool_input: { file_path: 'ARCHITECTURE.md' } }, r);
  assert.equal(post.code, 2); assert.match(post.err, /cycle/);
  const odd = MANIFEST(); odd.stack = 'go'; delete odd.checker; odd.resources = { users: { owner: 'identity', kind: 'gorm-model', definition: ['internal/models.go'], symbol: 'User' } };
  writeManifest(r, odd);
  assert.equal(hook('post', { cwd: r, tool_name: 'Write', tool_input: { file_path: 'ARCHITECTURE.md' } }, r).code, 0);
  assert.equal(harness(r, 'validate').code, 0, harness(r, 'validate').out);
});

test('review: planner issues cannot be merged without a receipt for the current head', () => {
  const r = tmpRepo(); workReady(r);
  writeIssue(r, 'ready', ISSUE({ interface_change: true, review: 'planner' })); userTyped(r, 'go');
  assert.equal(harness(r, 'claim', 'F01-I01').code, 0);
  const lease = JSON.parse(fs.readFileSync(path.join(r, '.harness/runtime/leases/F01-I01.json')));
  lease.finished = true; lease.head_sha = 'HEAD'; lease.worktree = r;
  fs.writeFileSync(path.join(r, '.harness/runtime/leases/F01-I01.json'), JSON.stringify(lease));
  const m = harness(r, 'merge', 'F01-I01');
  assert.equal(m.code, 1); assert.match(m.err, /needs planner review/);
});

test('session status: feature, outcome, decisions, queue, last interruption — no rules, no history', () => {
  const r = tmpRepo(); harness(r, 'init');
  let s = hook('session', { cwd: r, session_start_reason: 'startup' }, r);
  assert.match(s.out, /no open feature/);
  assert.match(s.out, /Uncommitted in main tree: \.gitignore/);
  fs.writeFileSync(path.join(r, '.harness/scratch/discovery.md'), '- open: who approves refunds\n');
  writeFeature(r, { branch: 'feature/identity-read' });
  writeIssue(r, 'ready', ISSUE()); writeIssue(r, 'ready', ISSUE({ id: 'F01-I02', after: ['F01-I01'] }));
  assert.equal(harness(r, 'claim', 'F01-I01').code, 0);
  s = hook('session', { cwd: r, session_start_reason: 'resume' }, r);
  assert.match(s.out, /Feature: F01 — Identity read model \(branch feature\/identity-read, main tree is on main\)/);
  assert.match(s.out, /Stored state is context, not authority: the newest user message overrides/);
  assert.match(s.out, /Outcome: identity read model works/);
  assert.match(s.out, /Decisions:\n- identity owns users/);
  assert.match(s.out, /Queue: doing F01-I01 · ready F01-I02 · blocked none · done 0/);
  assert.match(s.out, /Last interruption: F01-I01: claimed, worker never attached/);
  assert.match(s.out, /Discovery in progress: \.harness\/scratch\/discovery\.md/);
  assert.doesNotMatch(s.out, /mode=|No-Build|only the user/);
  assert.ok(s.out.split('\n').length <= 12);
});

test('handoff check: every third automatic compaction of one session, injected once — manual and other sessions stay silent, the prompt is never stored', () => {
  const r = tmpRepo(); harness(r, 'init');
  const compact = (trigger = 'auto') => hook('compact', { cwd: r, session_id: 's1', trigger }, r);
  const start = (session_id = 's1') => hook('session', { cwd: r, session_id, source: 'compact' }, r).out;
  userTyped(r, 'PRIVATE-SENTINEL');
  compact(); compact(); compact('manual');
  assert.equal(userTyped(r, 'next').out, '');
  compact();
  assert.match(userTyped(r, 'next').out, /Handoff check: 3 automatic compactions/);
  assert.equal(userTyped(r, 'next').out, '', 'injected once, not every prompt');
  compact(); compact();
  assert.doesNotMatch(start(), /Handoff check/);
  compact();
  assert.match(start(), /Handoff check: 6 automatic compactions/);
  assert.equal(userTyped(r, 'next').out, '');
  assert.equal(userTyped(r, 'hi', 's2').out, '');
  assert.doesNotMatch(start('s2'), /Handoff check/);
  assert.doesNotMatch(fs.readFileSync(path.join(r, '.harness/runtime/session.json'), 'utf8'), /PRIVATE-SENTINEL/);
});

test('one stop, not a mode: a feature\'s first claim waits for the user to answer the plan; once started, added issues claim freely', () => {
  const r = tmpRepo(); harness(r, 'init'); writeFeature(r);
  userTyped(r, 'do it');
  writeIssue(r, 'ready', ISSUE());
  writeIssue(r, 'ready', ISSUE({ id: 'F01-I02', touch: ['src/modules/billing/**'], do_not_touch: [] }));
  const c = harness(r, 'claim', 'F01-I01');
  assert.equal(c.code, 1); assert.match(c.err, /show the user the plan/);
  hook('compact', { cwd: r, session_id: 's1', trigger: 'auto' }, r);
  assert.equal(harness(r, 'claim', 'F01-I01').code, 1, 'a compaction is not the user answering');
  userTyped(r, 'looks right, run it');
  assert.equal(harness(r, 'claim', 'F01-I01').code, 0);
  writeIssue(r, 'ready', ISSUE({ id: 'F01-I03', touch: ['src/app/**'], do_not_touch: [] })); // inserted mid-run
  assert.equal(harness(r, 'claim', 'F01-I02').code, 0);
  assert.equal(harness(r, 'claim', 'F01-I03').code, 0);
});

test('paths are canonical: a hook cwd through a junction/short name still resolves to the attached worktree lease', () => {
  const r = tmpRepo(); workReady(r);
  writeIssue(r, 'ready', ISSUE()); userTyped(r, 'go');
  assert.equal(harness(r, 'claim', 'F01-I01').code, 0);
  const wt = addWorktree(r, 'F01-I01');
  assert.equal(harness(wt, 'attach', 'F01-I01').code, 0);
  const alias = path.join(process.env.TEMP || '/tmp', `harness-alias-${Date.now()}`);
  fs.symlinkSync(wt, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(W(alias, 'src/modules/identity/x.ts', WORKER).denied, false);
  assert.equal(W(alias, 'src/app/main.ts', WORKER).denied, true);
  fs.rmSync(alias, { recursive: false, force: true });
});
