#!/usr/bin/env node
// harness CLI — deterministic control-plane scripts. The LLM routes; this schedules.
import fs from 'node:fs';
import path from 'node:path';
import {
  MODES, QUEUE_DIRS, findProject, readState, writeState, readJson, writeJsonAtomic,
  readLease, writeLease, listLeases, leasePath, tryGit, git, norm, worktreeRoot, isInside, parseFrontmatter,
} from '../lib/core.mjs';
import { readManifest, validateIssueFile, validateIssueText } from '../lib/validate.mjs';
import { statusText, queue } from '../lib/status.mjs';

const [cmd, ...args] = process.argv.slice(2);
const cwd = process.cwd();

const commands = { init, status, mode, validate, claim, attach, release, help };
try {
  await (commands[cmd] || help)(...args);
} catch (e) {
  process.stderr.write(`harness ${cmd}: ${e.message}\n`);
  process.exit(1);
}

function out(s) { process.stdout.write(s + '\n'); }
function die(msg) { throw new Error(msg); }
function project() { return findProject(cwd) || die('no .harness/ here — run `harness init` in the project root'); }

async function help() {
  out(`harness <command>
  init                 create .harness/ (mode grill) and .work/ in this git repo
  status               mode, queue, leases, violations
  mode <grill|plan|work>   switch mode — only after the user typed the matching skill
  validate             check ARCHITECTURE.md manifest and every .work issue file
  claim <id>           ready/ → doing/ atomically and create the lease
  attach <id>          (worker, inside its worktree) bind cwd/branch/base_sha to the lease
  release <id>         doing/ → ready/, drop the lease (orchestrator only)`);
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
  if (!/^\.harness\/?$/m.test(cur)) fs.writeFileSync(gi, cur + (cur && !cur.endsWith('\n') ? '\n' : '') + '.harness/\n');
  out(`initialised ${root}: mode grill. Type /grill to start.`);
}

async function status() { out(statusText(project())); }

async function mode(next) {
  const p = project();
  if (!MODES.includes(next)) die(`mode must be one of ${MODES.join(', ')}`);
  const state = readState(p);
  const last = readJson(path.join(p.harness, 'runtime', 'last-prompt.json'), null);
  const re = new RegExp(`(^|\\s)/(harness:)?${next}(\\s|$)`, 'i');
  if (!last || !re.test(last.prompt)) {
    die(`refused: the last user prompt did not invoke /${next}. Only the user changes mode by typing /${next}; a model may not self-approve.`);
  }
  if (state.violations?.length) die(`refused: unresolved violations in main tree: ${state.violations.map((v) => v.file).join(', ')}. Revert them first.`);
  if (next === 'work') {
    const { errors } = readManifest(p.root);
    if (errors.length) die(`refused: ARCHITECTURE.md invalid:\n  ${errors.join('\n  ')}`);
  }
  if (next === 'plan' && state.mode === 'grill') {
    // discovery scratch survives until /plan produces output; the plan skill deletes it.
  }
  state.mode = next;
  writeState(p, state);
  out(`mode → ${next}`);
}

async function validate() {
  const p = project();
  const { errors } = readManifest(p.root);
  const all = errors.map((e) => `ARCHITECTURE.md: ${e}`);
  for (const d of QUEUE_DIRS) {
    const dir = path.join(p.root, '.work', d);
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.md'))) {
      for (const e of validateIssueFile(path.join(dir, f))) all.push(`.work/${d}/${f}: ${e}`);
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
  const { issue, errors } = validateIssueText(text);
  if (errors.length) die(`issue invalid:\n  ${errors.join('\n  ')}`);
  const q = queue(p.root);
  const missing = (issue.after || []).filter((a) => !q.done.includes(a) && !isIntegrated(p, a));
  if (missing.length) die(`dependencies not done: ${missing.join(', ')}`);
  for (const l of listLeases(p)) {
    if (overlap(l.touch, issue.touch)) die(`touch overlaps with active issue ${l.issue}; run sequentially`);
  }
  // atomic claim: rename fails if another process moved it first
  try { fs.renameSync(issueFile(p, 'ready', id), issueFile(p, 'doing', id)); } catch (e) { die(`claim failed (already claimed?): ${e.message}`); }
  const lease = {
    issue: id, claimed_at: Date.now(), agent_id: null, worktree: null, branch: null, base_sha: null,
    touch: issue.touch, do_not_touch: issue.do_not_touch, allowed_commands: [...issue.verify, ...issue.privileged],
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
  out(`attached ${id} to ${lease.worktree} (branch ${lease.branch}, base ${lease.base_sha.slice(0, 8)})\n` +
      `touch: ${JSON.stringify(lease.touch)}\nallowed Bash (exact): ${JSON.stringify(lease.allowed_commands)}\n\n${issue}`);
}

async function release(id) {
  const p = project();
  id || die('release <id>');
  if (findIssue(p, id) !== 'doing') die(`${id} is not in doing/`);
  fs.renameSync(issueFile(p, 'doing', id), issueFile(p, 'ready', id));
  try { fs.unlinkSync(leasePath(p, id)); } catch {}
  out(`released ${id}: doing/ → ready/`);
}
