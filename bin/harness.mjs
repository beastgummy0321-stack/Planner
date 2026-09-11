#!/usr/bin/env node
// harness CLI — deterministic control-plane scripts. The LLM routes; this schedules.
import fs from 'node:fs';
import path from 'node:path';
import {
  QUEUE_DIRS, findProject, readJson, writeJsonAtomic, readLease, writeLease, listLeases, leasePath, tryGit, norm, worktreeRoot, isInside, issueFingerprint,
} from '../lib/core.mjs';
import { readManifest, validateIssueFile, validateIssueText, validateFeatureFile } from '../lib/validate.mjs';
import { statusText, section } from '../lib/status.mjs';
import { planAdapter, applyAdapter, runChecker, proveChecker, setupEnv, detectStack } from '../lib/adapters.mjs';
import * as Q from '../lib/queue.mjs';

const [cmd, ...args] = process.argv.slice(2);
const cwd = process.cwd();

const commands = { init, status, validate, feature, recover, claim, attach, release, adapter, env, queue: queueCmd, finish, review, merge, block, diff, integrate, close, help };
// metrics: one line per CLI call in .harness/runtime/metrics.jsonl (gitignored, never injected into any context)
const t0 = Date.now();
process.on('exit', (code) => {
  try { const p = findProject(cwd); if (p && cmd !== 'help') { fs.mkdirSync(path.join(p.harness, 'runtime'), { recursive: true }); fs.appendFileSync(path.join(p.harness, 'runtime', 'metrics.jsonl'), JSON.stringify({ cmd, arg: args[0] || null, ms: Date.now() - t0, ok: code === 0, ts: t0 }) + '\n'); } } catch {}
});
try {
  await (commands[cmd] || help)(...args);
} catch (e) {
  process.stderr.write(`harness ${cmd}: ${e.message}\n`);
  process.exit(1);
}

function out(s) { process.stdout.write(s + '\n'); }
function die(msg) { throw new Error(msg); }
function project() { return findProject(cwd) || die('no .harness/ here — run `harness init` in the project root'); }
function session() { return readJson(path.join(findProject(cwd).harness, 'runtime', 'session.json'), null)?.session_id || null; }

async function help() {
  out(`harness <command>
  init                 create .harness/ and .work/ in this git repo
  status               open feature, outcome, decisions, queue, interrupted work (what SessionStart injects)
  validate             check ARCHITECTURE.md (if any), every feature file and every issue file
  feature start <F01>  check out the feature's branch (from its frontmatter); issues branch from and merge into it
  recover              re-queue issues whose session died (partial diff saved under .harness/runtime/logs/)
  claim <id>           ready/ → doing/ atomically and create the lease
  attach <id>          (worker, inside its worktree) bind cwd/branch/base_sha to the lease; env stays cold until needed
  release <id>         doing/ → ready/, drop the lease and its worktree
  adapter plan|apply --approved|check|prove   import/ownership checker for the stack (ts, python); other stacks: skipped
  env                  (worker, inside worktree) frozen dependency install now (normally lazy)
  queue next           claimable issues (deps done, no overlap, dependency changes alone)
  finish <id>          scope post-diff · checker · issue verify · typecheck/build → green or blocked/
  review <id> approve  record the planner's approval for the current worktree head (needed when review: planner)
  merge <id>           merge the issue branch into the feature branch, integration checker, smoke in the worktree, → done/
  block <id> "<reason>"     doing/ → blocked/ with reason; worktree discarded
  diff <id> [--stat]   diff of the issue branch against its base (reviewers: --stat first, then read the files)
  integrate feature <F01>   checker · project test/build · feature verify · smoke · runtime acceptance; lists human items
  close feature <F01>       delete done issues + feature file, merge the feature branch into its base, clean up`);
}

async function init() {
  const top = worktreeRoot(cwd) || die('not a git repository — the harness needs git for worktrees and scope diffs');
  const root = norm(top);
  const harness = path.join(root, '.harness');
  if (fs.existsSync(path.join(harness, 'state.json'))) { out(`already initialised: ${harness}`); return; }
  for (const d of ['scratch', 'runtime/leases', 'runtime/baselines']) fs.mkdirSync(path.join(harness, d), { recursive: true });
  writeJsonAtomic(path.join(harness, 'state.json'), { harness: 2 });
  for (const d of ['features', ...QUEUE_DIRS]) fs.mkdirSync(path.join(root, '.work', d), { recursive: true });
  const gi = path.join(root, '.gitignore');
  const cur = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  let add = '';
  if (!/^\.harness\/?$/m.test(cur)) add += '.harness/\n';
  if (!/^\.claude\/worktrees\/?$/m.test(cur)) add += '.claude/worktrees/\n';
  if (add) fs.writeFileSync(gi, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + add);
  out(`initialised ${root}. Talk it through (/dig), cut a feature (/carve), or run the queue (/crank).`);
}

async function status() { out(statusText(project())); }

async function validate() {
  const p = project();
  const { manifest, errors } = readManifest(p.root);
  const all = errors.map((e) => `ARCHITECTURE.md: ${e}`);
  const fdir = path.join(p.root, '.work', 'features');
  if (fs.existsSync(fdir)) for (const f of fs.readdirSync(fdir).filter((f) => f.endsWith('.md'))) {
    for (const e of validateFeatureFile(path.join(fdir, f))) all.push(`.work/features/${f}: ${e}`);
  }
  for (const d of QUEUE_DIRS) {
    const dir = path.join(p.root, '.work', d);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      for (const e of validateIssueFile(path.join(dir, f), p.root)) all.push(`.work/${d}/${f}: ${e}`);
    }
  }
  if (all.length) { out(all.join('\n')); process.exit(1); }
  out(manifest ? 'valid' : 'valid (no ARCHITECTURE.md: architecture checks off)');
}

async function feature(sub, id) {
  const p = project();
  if (sub !== 'start') die('feature start <F01>');
  out(JSON.stringify(Q.startFeature(p, id || die('feature start <F01>')), null, 2));
}

async function recover() {
  const p = project();
  const r = Q.recover(p, session());
  for (const x of r) out(`recovered ${x.issue}: session ${x.session || '?'} is gone; re-queued${x.log ? ', partial diff saved to ' + x.log : ''}`);
  if (!r.length) out('nothing to recover');
}

function issueFile(p, dir, id) { return path.join(p.root, '.work', dir, `${id}.md`); }

async function claim(id) {
  const p = project();
  id || die('claim <id>');
  const where = Q.findIssue(p, id);
  if (where !== 'ready') die(`issue ${id} is not in ready/ (found: ${where || 'nowhere'})`);
  const text = fs.readFileSync(issueFile(p, 'ready', id), 'utf8');
  const { issue, errors } = validateIssueText(text, { manifest: readManifest(p.root).manifest });
  if (errors.length) die(`issue invalid:\n  ${errors.join('\n  ')}`);
  // no identical retry: a blocked issue re-enters only after the planner changed it, its dependencies, or the architecture
  const prev = readJson(path.join(p.harness, 'runtime', 'blocked', `${id}.json`), null);
  if (prev) {
    const manifestText = fs.existsSync(path.join(p.root, 'ARCHITECTURE.md')) ? fs.readFileSync(path.join(p.root, 'ARCHITECTURE.md'), 'utf8') : '';
    if (issueFingerprint(text, manifestText) === prev.fingerprint) die(`identical retry refused: ${id} was blocked (${prev.reason}) and neither the issue, its dependencies nor ARCHITECTURE.md changed since. Re-dispatching the same input to another worker only burns tokens; the planner must change something first.`);
  }
  const missing = (issue.after || []).filter((a) => !Q.isDone(p, a));
  if (missing.length) die(`dependencies not done: ${missing.join(', ')}`);
  for (const l of listLeases(p)) {
    if (Q.overlap(l.touch, issue.touch)) die(`touch overlaps with active issue ${l.issue}; run sequentially`);
  }
  // atomic claim: rename fails if another process moved it first
  try { fs.renameSync(issueFile(p, 'ready', id), issueFile(p, 'doing', id)); } catch (e) { die(`claim failed (already claimed?): ${e.message}`); }
  const lease = {
    issue: id, claimed_at: Date.now(), session_id: session(), agent_id: null, worktree: null, branch: null, base_sha: null,
    touch: issue.touch, do_not_touch: issue.do_not_touch,
    verify_commands: issue.verify, privileged_commands: issue.privileged,
    review: issue.review, interface_change: issue.interface_change, violations: [],
  };
  if (fs.existsSync(leasePath(p, id))) die(`lease for ${id} already exists`);
  writeLease(p, lease);
  out(`claimed ${id}: ready/ → doing/. Dispatch Agent(subagent_type: "harness:worker", isolation: "worktree") with the issue; the worker must run attach first.`);
}

async function attach(id) {
  const p = project();
  id || die('attach <id>');
  const lease = readLease(p, id) || die(`no lease for ${id}: the orchestrator must claim it first`);
  const top = worktreeRoot(cwd) || die('attach must run inside the issue worktree');
  if (isInside(top, p.root) && norm(top) === p.root) die('attach must run inside a linked worktree, not the main tree');
  if (lease.worktree && lease.worktree !== norm(top)) die(`lease ${id} is already attached to ${lease.worktree}`);
  lease.worktree = norm(top);
  lease.branch = tryGit(top, 'branch', '--show-current') || null;
  lease.base_sha = tryGit(top, 'rev-parse', 'HEAD');
  lease.base = tryGit(p.root, 'branch', '--show-current') || 'main';
  lease.attached_at = Date.now();
  writeLease(p, lease);
  const issue = fs.readFileSync(issueFile(p, 'doing', id), 'utf8');
  // the feature's outcome and decisions travel with the issue: the worker never saw the discussion, this is what survived it
  const fid = validateIssueText(issue).issue?.feature;
  const feat = fid ? Q.readFeature(p, fid) : null;
  const decisions = feat ? section(feat.body, 'Decisions').map((d) => (d.startsWith('-') ? `  ${d}` : `  - ${d}`)).join('\n') : '';
  const featureBlock = feat ? `feature ${fid} — ${feat.data.title}\noutcome: ${section(feat.body, 'Outcome').join(' ')}\ndecisions (settled; implement within them, never against them):\n${decisions || '  (none)'}\n` : '';
  // the worker's context pack: the issue plus the contract of the modules its touch globs reach — not the ARCHITECTURE prose
  const { manifest } = readManifest(p.root);
  const prefix = (g) => g.split(/[*?[{]/)[0];
  const slice = Object.entries(manifest?.modules || {})
    .filter(([, m]) => (lease.touch || []).some((g) => prefix(g).startsWith(m.root) || m.root.startsWith(prefix(g))))
    .map(([n, m]) => `  ${n}: root ${m.root} · public ${m.public} · may_depend_on [${(m.may_depend_on || []).join(', ')}] · owns ${JSON.stringify(m.owns)}`);
  // an approved prototype lives in the main tree's scratch (gitignored, so absent from the worktree): hand the worker its absolute path
  const protoDir = path.join(p.harness, 'scratch', 'prototype');
  const protos = fs.existsSync(protoDir) ? fs.readdirSync(protoDir).map((d) => path.join(protoDir, d).replace(/\\/g, '/')) : [];
  out(`attached ${id} to ${lease.worktree} (branch ${lease.branch}, base ${lease.base_sha.slice(0, 8)})\n` +
      (protos.length ? `prototype (visual reference, read only): ${protos.join(', ')}\n` : '') +
      `environment: lazy (dependencies install once, before the first runtime command)\n` +
      `touch: ${JSON.stringify(lease.touch)}${lease.do_not_touch?.length ? `\ndo_not_touch: ${JSON.stringify(lease.do_not_touch)}` : ''}\n` +
      `verify (finish re-runs these): ${JSON.stringify(lease.verify_commands)}${lease.privileged_commands?.length ? `\nprivileged (run once, by you): ${JSON.stringify(lease.privileged_commands)}` : ''}\n` +
      `Bash: anything non-destructive; every call is diffed — a change outside touch blocks the issue\n` +
      `modules touched (other modules only through their public entry):\n${slice.join('\n') || '  (none declared)'}\n${featureBlock}\n${issue}`);
}

async function release(id) {
  const p = project();
  id || die('release <id>');
  if (Q.findIssue(p, id) !== 'doing') die(`${id} is not in doing/`);
  fs.renameSync(issueFile(p, 'doing', id), issueFile(p, 'ready', id));
  Q.discardLease(p, id); // lease, worktree and branch go together
  out(`released ${id}: doing/ → ready/`);
}

async function adapter(sub, flag) {
  const p = project();
  if (sub === 'plan') {
    const plan = planAdapter(p.root);
    if (plan.unsupported) { out(`stack: ${plan.stack}\nno checker adapter for this stack — architecture boundaries are planner-reviewed by hand; nothing to install`); return; }
    if (plan.unchanged) { out(`stack: ${plan.stack}\nup to date — the checker is already wired for this manifest; skip apply and prove, run: harness adapter check`); return; }
    out(`stack: ${plan.stack}
install: ${plan.install.length ? plan.install.join('; ') : '(nothing)'}
add: ${plan.add.join(', ')}
modify: ${plan.modify.join(', ')}
checker command: ${plan.checker}${plan.reuse ? '\nreuse: ' + plan.reuse : ''}

Ask the user to approve this once, then run: harness adapter apply --approved`);
  } else if (sub === 'apply') {
    if (flag !== '--approved') die('apply needs --approved: show `harness adapter plan` to the user first');
    const plan = applyAdapter(p);
    out(`applied: ${plan.add.join(', ')}; checker = ${plan.checker}`);
    const r = runChecker(p.root);
    out(r.ok ? 'checker: green' : `checker: RED\n${r.output}`);
    if (!r.ok) process.exit(1);
  } else if (sub === 'check') {
    const r = runChecker(p.root);
    out(r.ok ? (r.greenfield || r.skipped ? r.output : `green (${r.command})`) : r.output);
    if (!r.ok) process.exit(1);
  } else if (sub === 'prove') {
    const r = proveChecker(p.root);
    out(JSON.stringify(r, null, 2));
    if (!r.ok) process.exit(1);
  } else die('adapter plan|apply --approved|check|prove');
}
async function env() {
  const p = project();
  const top = worktreeRoot(cwd) || die('not in a git tree');
  const { manifest } = readManifest(p.root);
  const r = setupEnv(top, manifest?.stack || detectStack(top));
  out(JSON.stringify(r, null, 2));
  if (!r.ok) process.exit(1);
}
async function queueCmd(sub) {
  const p = project();
  if (sub !== 'next') die('queue next');
  out(JSON.stringify(Q.next(p), null, 2));
}
async function finish(id) {
  const p = project(); id || die('finish <id>');
  const r = Q.finish(p, id);
  out(JSON.stringify(r, null, 2));
  if (!r.ok) process.exit(1);
}
async function review(id, verdict) {
  const p = project(); id || die('review <id> approve');
  if (verdict !== 'approve') die('review <id> approve — a block goes through harness block <id> "<reason>"');
  const rc = Q.approve(p, id);
  out(`review recorded: ${id} approve at ${rc.head_sha.slice(0, 8)}`);
}
async function merge(id) {
  const p = project(); id || die('merge <id>');
  const r = Q.merge(p, id);
  out(JSON.stringify(r, null, 2));
  if (!r.ok) process.exit(1);
}
async function block(id, ...reason) {
  const p = project(); id || die('block <id> "<reason>"');
  if (!Q.findIssue(p, id)) die(`no issue ${id}`);
  out(JSON.stringify(Q.blockIssue(p, id, reason.join(' ') || 'blocked by orchestrator'), null, 2));
}
async function diff(id, flag) { out(Q.diff(project(), id || die('diff <id> [--stat]'), flag === '--stat')); }
async function integrate(kind, id) {
  const p = project();
  if (kind !== 'feature') die('integrate feature <F01>');
  const r = Q.integrateFeature(p, id || die('integrate feature <F01>'));
  out(JSON.stringify(r, null, 2));
  if (!r.ok) process.exit(1);
}
async function close(kind, id) {
  const p = project();
  if (kind !== 'feature') die('close feature <F01>');
  out(JSON.stringify(Q.closeFeature(p, id || die('close feature <F01>')), null, 2));
}
