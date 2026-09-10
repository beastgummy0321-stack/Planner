#!/usr/bin/env node
// harness CLI — deterministic control-plane scripts. The LLM routes; this schedules.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  MODES, QUEUE_DIRS, findProject, readState, writeState, readJson, writeJsonAtomic,
  readLease, writeLease, listLeases, leasePath, tryGit, git, norm, worktreeRoot, isInside, parseFrontmatter, planHash,
} from '../lib/core.mjs';
import { readManifest, validateIssueFile, validateIssueText, validateTicketFile } from '../lib/validate.mjs';
import { issueFingerprint, pruneViolations } from '../lib/core.mjs';
import { statusText, queue } from '../lib/status.mjs';
import { planAdapter, applyAdapter, runChecker, proveChecker, setupEnv, detectStack } from '../lib/adapters.mjs';
import * as Q from '../lib/queue.mjs';

const [cmd, ...args] = process.argv.slice(2);
const cwd = process.cwd();

const commands = { init, status, mode, validate, claim, attach, release, adapter, env, queue: queueCmd, finish, review, challenge, merge, block, diff, integrate, close, 'plan-sync': planSync, help };
// metrics: one line per CLI call in .harness/runtime/metrics.jsonl (gitignored, never injected into any context) —
// the only way to see where wall time goes before deciding what else to make conditional
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
function fileHash(f) { try { return crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex'); } catch { return null; } }
function die(msg) { throw new Error(msg); }
function project() { return findProject(cwd) || die('no .harness/ here — run `harness init` in the project root'); }

async function help() {
  out(`harness <command>
  init                 create .harness/ (mode grill) and .work/ in this git repo
  status               mode, queue, leases, violations
  mode <grill|plan|work>   switch mode — only after the user typed the matching skill
  validate             check ARCHITECTURE.md manifest and every .work issue file
  claim <id>           ready/ → doing/ atomically and create the lease
  attach <id>          (worker, inside its worktree) bind cwd/branch/base_sha to the lease; env stays cold until needed
  release <id>         doing/ → ready/, drop the lease (orchestrator only)
  adapter plan|apply --approved|check|prove   container checker for the stack (ts, python)
  env                  (worker, inside worktree) frozen dependency install now (normally lazy)
  queue next           claimable issues (deps done, no overlap, dependency changes alone)
  finish <id>          scope post-diff · checker · ownership · verify · typecheck/build → green or blocked/
  review <id> approve  (planner agent only) record the review receipt for the current worktree head
  challenge <CLEAR|CHALLENGE>   (challenger agent only) record the Independent Challenge verdict for the plan it read
  merge <id>           merge the issue branch into base, integration gate, smoke in the worktree, → done/
  block <id> "<reason>"     doing/ → blocked/ with reason; worktree discarded
  diff <id> [--stat]   diff of the issue branch against its base (reviewers: --stat first, then read the files)
  integrate ticket <F01-T01> | feature <F01>
  close ticket <F01-T01> | feature <F01>     after the planner/user accepted the integration
  plan-sync            regenerate .work/PLAN.md from ticket files`);
}

async function init() {
  const top = worktreeRoot(cwd) || die('not a git repository — the harness needs git for worktrees and baseline diffs');
  const root = norm(top);
  const harness = path.join(root, '.harness');
  if (fs.existsSync(path.join(harness, 'state.json'))) { out(`already initialised: ${harness}`); return; }
  for (const d of ['scratch', 'runtime/leases', 'runtime/baselines']) fs.mkdirSync(path.join(harness, d), { recursive: true });
  writeJsonAtomic(path.join(harness, 'state.json'), { mode: 'grill', violations: [], plan_allow: [] });
  for (const d of ['tickets', ...QUEUE_DIRS]) fs.mkdirSync(path.join(root, '.work', d), { recursive: true });
  const gi = path.join(root, '.gitignore');
  const cur = fs.existsSync(gi) ? fs.readFileSync(gi, 'utf8') : '';
  let add = '';
  if (!/^\.harness\/?$/m.test(cur)) add += '.harness/\n';
  if (!/^\.claude\/worktrees\/?$/m.test(cur)) add += '.claude/worktrees/\n';
  if (add) fs.writeFileSync(gi, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + add);
  out(`initialised ${root}: mode grill. Type /dig to start.`);
}

async function status() { const p = project(); pruneViolations(p, readState(p)); out(statusText(p)); }

async function mode(next) {
  const p = project();
  if (!MODES.includes(next)) die(`mode must be one of ${MODES.join(', ')}`);
  const state = pruneViolations(p, readState(p));
  const last = readJson(path.join(p.harness, 'runtime', 'last-prompt.json'), null);
  const skill = { grill: 'dig', plan: 'carve', work: 'crank' }[next];
  const re = new RegExp(`^\\s*/(harness:)?${skill}(\\s|$)`, 'i'); // the prompt IS the command; "先不要 /carve" is not
  if (!last || !re.test(last.prompt)) {
    die(`refused: the last user prompt did not invoke /${skill}. Only the user changes mode by typing /${skill}; a model may not self-approve.`);
  }
  if (state.violations?.length) die(`refused: unresolved violations in main tree: ${state.violations.map((v) => v.file).join(', ')}. Revert them first.`);
  const challengeFile = path.join(p.harness, 'runtime', 'challenge.json');
  if (next === 'work') {
    const { errors } = readManifest(p.root);
    if (errors.length) die(`refused: ARCHITECTURE.md invalid:\n  ${errors.join('\n  ')}`);
    // the planner is never the only validator of its own assumptions: an independent challenger must have been dispatched
    // this planning round AND come back; a CLEAR covers exactly the plan it read
    // (gates the plan → work transition only; once in work mode the queue itself rewrites .work/, and /crank re-runs this command to recover)
    const ch = readJson(challengeFile, null);
    const archHash = fileHash(path.join(p.root, 'ARCHITECTURE.md'));
    if (state.mode !== 'work') {
      // machine floor: the challenge is mandatory when the architecture changed since the last plan→work transition,
      // when any open issue carries review: planner, or when more than one ticket is open. Below that floor a bounded
      // plan enters work without it (the planner may still ask for one); above it the rules are unchanged.
      const why = [];
      if (state.arch_hash !== archHash) why.push(state.arch_hash ? 'ARCHITECTURE.md changed' : 'first plan');
      if (QUEUE_DIRS.some((d) => Q.listIssues(p, d).some((i) => Q.readIssue(p, d, i).issue?.review === 'planner'))) why.push('an issue needs planner review');
      if (Q.listTickets(p).filter((t) => !Q.readTicket(p, t).data.closed).length > 1) why.push('more than one open ticket');
      if (!ch) {
        if (why.length) die(`refused: Independent Challenge needed — none this planning round (${why.join(', ')}). Mode stays plan: dispatch Agent(subagent_type: "harness:challenger") on the draft on disk, then run mode work again.`);
        out('challenge: not required (architecture unchanged, one ticket, no planner-reviewed issue)');
      } else {
        if (!ch.completed || !ch.verdict) die('refused: Independent Challenge needed — the last one never returned a verdict (timeout/crash, or the challenger did not run `harness challenge <CLEAR|CHALLENGE>`). A dispatch is not a review. Mode stays plan: dispatch the challenger again on the draft on disk, then run mode work again.');
        if (ch.verdict === 'CLEAR' && ch.plan_hash !== planHash(p.root)) die('refused: Independent Challenge needed — the plan changed after the challenger said CLEAR; its review covers the old draft. Mode stays plan: dispatch the challenger again on the draft on disk, then run mode work again.');
      }
    }
    state.arch_hash = archHash;
    // orphan leases from a dead session: save partial work, re-queue, free the touch prefix
    for (const r of Q.recover(p, last.session_id)) out(`recovered ${r.issue}: session ${r.session || '?'} is gone; re-queued${r.log ? ', partial diff saved to ' + r.log : ''}`);
  }
  if (next === 'plan') {
    // a new planning round: the previous challenge no longer covers it; disposable probes never survive into planning
    try { fs.unlinkSync(challengeFile); } catch {}
    fs.rmSync(path.join(p.harness, 'scratch', 'probes'), { recursive: true, force: true });
  }
  state.mode = next;
  writeState(p, state);
  out(`mode → ${next}`);
}

async function validate() {
  const p = project();
  const { errors } = readManifest(p.root);
  const all = errors.map((e) => `ARCHITECTURE.md: ${e}`);
  const tdir = path.join(p.root, '.work', 'tickets');
  if (fs.existsSync(tdir)) for (const f of fs.readdirSync(tdir).filter((f) => f.endsWith('.md'))) {
    for (const e of validateTicketFile(path.join(tdir, f))) all.push(`.work/tickets/${f}: ${e}`);
  }
  for (const d of QUEUE_DIRS) {
    const dir = path.join(p.root, '.work', d);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      for (const e of validateIssueFile(path.join(dir, f), p.root)) all.push(`.work/${d}/${f}: ${e}`);
    }
  }
  if (all.length) { out(all.join('\n')); process.exit(1); }
  out('valid');
}

function issueFile(p, dir, id) { return path.join(p.root, '.work', dir, `${id}.md`); }
function findIssue(p, id) {
  for (const d of QUEUE_DIRS) if (fs.existsSync(issueFile(p, d, id))) return d;
  return null;
}

async function claim(id) {
  const p = project();
  id || die('claim <id>');
  const state = readState(p);
  if (state.mode !== 'work') die('claim only in work mode');
  const where = findIssue(p, id);
  if (where !== 'ready') die(`issue ${id} is not in ready/ (found: ${where || 'nowhere'})`);
  const text = fs.readFileSync(issueFile(p, 'ready', id), 'utf8');
  const { issue, errors } = validateIssueText(text, { manifest: readManifest(p.root).manifest, ticket: Q.readTicket(p, id.slice(0, 7))?.data });
  if (errors.length) die(`issue invalid:\n  ${errors.join('\n  ')}`);
  // no identical retry: a blocked issue re-enters only after the planner changed it, its dependencies, or the architecture
  const prev = readJson(path.join(p.harness, 'runtime', 'blocked', `${id}.json`), null);
  if (prev) {
    const manifestText = fs.existsSync(path.join(p.root, 'ARCHITECTURE.md')) ? fs.readFileSync(path.join(p.root, 'ARCHITECTURE.md'), 'utf8') : '';
    if (issueFingerprint(text, manifestText) === prev.fingerprint) die(`identical retry refused: ${id} was blocked (${prev.reason}) and neither the issue, its dependencies nor ARCHITECTURE.md changed since. Re-dispatching the same input to another worker only burns tokens; the planner must change something first.`);
  }
  const q = queue(p.root);
  const missing = (issue.after || []).filter((a) => !Q.isDone(p, a));
  if (missing.length) die(`dependencies not done: ${missing.join(', ')}`);
  for (const l of listLeases(p)) {
    if (overlap(l.touch, issue.touch)) die(`touch overlaps with active issue ${l.issue}; run sequentially`);
  }
  // atomic claim: rename fails if another process moved it first
  try { fs.renameSync(issueFile(p, 'ready', id), issueFile(p, 'doing', id)); } catch (e) { die(`claim failed (already claimed?): ${e.message}`); }
  const session = readJson(path.join(p.harness, 'runtime', 'last-prompt.json'), null)?.session_id || null;
  const lease = {
    issue: id, claimed_at: Date.now(), session_id: session, agent_id: null, worktree: null, branch: null, base_sha: null,
    touch: issue.touch, do_not_touch: issue.do_not_touch,
    verify_commands: issue.verify, allowed_commands: [...issue.verify, ...issue.privileged], // worker may run both; finish re-runs only verify
    review: issue.review, interface_change: issue.interface_change, violations: [],
  };
  if (fs.existsSync(leasePath(p, id))) die(`lease for ${id} already exists`);
  writeLease(p, lease);
  out(`claimed ${id}: ready/ → doing/. Dispatch Agent(subagent_type: "harness:worker", isolation: "worktree") with the issue; the worker must run attach first.`);
}

function isIntegrated(p, id) {
  // an issue whose ticket already closed has its file deleted; treat as done if the ticket file lists it as done
  const t = path.join(p.root, '.work', 'tickets', `${id.slice(0, 7)}.md`);
  if (!fs.existsSync(t)) return false;
  return new RegExp(`\\b${id}\\b.*\\bdone\\b`, 'i').test(fs.readFileSync(t, 'utf8'));
}
function overlap(a = [], b = []) {
  // conservative: two globs overlap when either literal prefix contains the other
  const prefix = (g) => g.split(/[*?[{]/)[0];
  return a.some((x) => b.some((y) => { const px = prefix(x), py = prefix(y); return px.startsWith(py) || py.startsWith(px); }));
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
  // the worker's context pack: the issue plus the contract of the modules its touch globs reach — not the ARCHITECTURE prose
  const { manifest } = readManifest(p.root);
  const prefix = (g) => g.split(/[*?[{]/)[0];
  const slice = Object.entries(manifest?.modules || {})
    .filter(([, m]) => (lease.touch || []).some((g) => prefix(g).startsWith(m.root) || m.root.startsWith(prefix(g))))
    .map(([n, m]) => `  ${n}: root ${m.root} · public ${m.public} · may_depend_on [${(m.may_depend_on || []).join(', ')}] · owns ${JSON.stringify(m.owns)}`);
  out(`attached ${id} to ${lease.worktree} (branch ${lease.branch}, base ${lease.base_sha.slice(0, 8)})\n` +
      `environment: lazy (dependencies install once, before the first runtime command)\n` +
      `touch: ${JSON.stringify(lease.touch)}\nallowed Bash (exact): ${JSON.stringify(lease.allowed_commands)}\n` +
      `modules touched (other modules only through their public entry):\n${slice.join('\n') || '  (none declared — app_shell or legacy)'}\n\n${issue}`);
}

async function release(id) {
  const p = project();
  id || die('release <id>');
  if (findIssue(p, id) !== 'doing') die(`${id} is not in doing/`);
  fs.renameSync(issueFile(p, 'doing', id), issueFile(p, 'ready', id));
  Q.discardLease(p, id); // lease, worktree and branch go together
  out(`released ${id}: doing/ → ready/`);
}

async function adapter(sub, flag) {
  const p = project();
  if (sub === 'plan') {
    const plan = planAdapter(p.root);
    if (plan.unchanged) { out(`stack: ${plan.stack}\nup to date — the checker is already wired for this manifest; skip apply and prove, run: harness adapter check`); return; }
    out(`stack: ${plan.stack}
install: ${plan.install.length ? plan.install.join('; ') : '(nothing)'}
add: ${plan.add.join(', ')}
modify: ${plan.modify.join(', ')}
checker command: ${plan.checker}${plan.reuse ? '\nreuse: ' + plan.reuse : ''}

Ask the user to approve this once, then run: harness adapter apply --approved`);
  } else if (sub === 'apply') {
    if (flag !== '--approved') die('apply needs --approved: show `harness adapter plan` to the user first');
    if (readState(p).mode !== 'plan') die('adapter apply only in plan mode');
    const plan = applyAdapter(p);
    out(`applied: ${plan.add.join(', ')}; checker = ${plan.checker}`);
    const r = runChecker(p.root);
    out(r.ok ? 'checker: green' : `checker: RED
${r.output}`);
    if (!r.ok) process.exit(1);
  } else if (sub === 'check') {
    const r = runChecker(p.root);
    out(r.ok ? (r.greenfield ? r.output : `green (${r.command})`) : r.output);
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
  const r = Q.next(p);
  out(JSON.stringify(r, null, 2));
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
  // the receipt itself is written by the PreToolUse hook when the planner agent runs this command; here we only confirm it
  const rc = Q.reviewReceipt(p, id);
  const lease = readLease(p, id) || die(`no lease for ${id}`);
  if (!rc || rc.head_sha !== lease.head_sha) die(`no review receipt for ${id} at ${lease.head_sha?.slice(0, 8)}: this command counts only when the harness:planner agent runs it (the hook records it); the control plane cannot approve`);
  out(`review recorded: ${id} approve at ${rc.head_sha.slice(0, 8)} by ${rc.agent_type}`);
}
async function challenge(verdict) {
  const p = project();
  if (!['CLEAR', 'CHALLENGE'].includes(verdict)) die('challenge <CLEAR|CHALLENGE>');
  // the receipt itself is written by the PreToolUse hook when the challenger agent runs this command; here we only confirm it
  const ch = readJson(path.join(p.harness, 'runtime', 'challenge.json'), null) || die('no Independent Challenge dispatched this planning round');
  if (!ch.completed || ch.verdict !== verdict) die('verdict not recorded: this command counts only when the harness:challenger agent runs it (the hook signs it); the control plane cannot record a verdict');
  out(`challenge recorded: ${verdict} for plan ${String(ch.plan_hash).slice(0, 8)} by ${ch.agent_type || 'agent'}`);
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
  const r = kind === 'ticket' ? Q.integrateTicket(p, id) : kind === 'feature' ? Q.integrateFeature(p, id) : die('integrate ticket <id> | feature <id>');
  out(JSON.stringify(r, null, 2));
  if (!r.ok) process.exit(1);
}
async function close(kind, id) {
  const p = project();
  const r = kind === 'ticket' ? Q.closeTicket(p, id) : kind === 'feature' ? Q.closeFeature(p, id) : die('close ticket <id> | feature <id>');
  out(JSON.stringify(r, null, 2));
}
async function planSync() { Q.syncPlan(project()); out('PLAN.md regenerated'); }
