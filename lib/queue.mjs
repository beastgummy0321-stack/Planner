// Queue scheduling and the /crank lifecycle scripts: next, finish, merge, block, diff, integrate, plan-sync.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { QUEUE_DIRS, readLease, writeLease, listLeases, leasePath, git, tryGit, gitRaw, parseFrontmatter, stringifyFrontmatter, matchesAny, norm, readState, writeState, writeJsonAtomic, issueFingerprint } from './core.mjs';
import { validateIssueText, readManifest } from './validate.mjs';
import { runChecker } from './adapters.mjs';

const DEP_FILES = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'pyproject.toml', 'uv.lock', 'requirements.txt'];

export function issueFile(p, dir, id) { return path.join(p.root, '.work', dir, `${id}.md`); }
export function findIssue(p, id) { return QUEUE_DIRS.find((d) => fs.existsSync(issueFile(p, d, id))) || null; }
export function readIssue(p, dir, id) {
  const text = fs.readFileSync(issueFile(p, dir, id), 'utf8');
  const { issue, body, errors } = validateIssueText(text);
  return { issue, body, errors, text };
}
export function listIssues(p, dir) {
  const d = path.join(p.root, '.work', dir);
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort() : [];
}
export function ticketFile(p, id) { return path.join(p.root, '.work', 'tickets', `${id}.md`); }
export function readTicket(p, id) {
  const f = ticketFile(p, id);
  if (!fs.existsSync(f)) return null;
  const { data, body } = parseFrontmatter(fs.readFileSync(f, 'utf8'));
  return { data, body };
}
export function listTickets(p) {
  const d = path.join(p.root, '.work', 'tickets');
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort() : [];
}
export function isDone(p, id) {
  if (listIssues(p, 'done').includes(id)) return true;
  const t = readTicket(p, id.slice(0, 7));
  return !!t?.data?.closed; // issues of a closed ticket were deleted after integration
}
export function touchesDeps(issue) {
  return (issue.touch || []).some((g) => DEP_FILES.some((f) => path.posix.matchesGlob(f, g)));
}
export function overlap(a = [], b = []) {
  const prefix = (g) => g.split(/[*?[{]/)[0];
  return a.some((x) => b.some((y) => { const px = prefix(x), py = prefix(y); return px.startsWith(py) || py.startsWith(px); }));
}

// ---------- next: claimable issues, in a set that can run in parallel ----------
export function next(p) {
  const active = listLeases(p);
  const activeTouch = active.flatMap((l) => l.touch || []);
  const chosen = [];
  const reasons = {};
  for (const id of listIssues(p, 'ready')) {
    const { issue, errors } = readIssue(p, 'ready', id);
    if (errors.length) { reasons[id] = `invalid: ${errors[0]}`; continue; }
    const missing = (issue.after || []).filter((a) => !isDone(p, a));
    if (missing.length) { reasons[id] = `after ${missing.join(', ')}`; continue; }
    if (overlap(issue.touch, activeTouch)) { reasons[id] = 'touch overlaps an active lease'; continue; }
    if (chosen.some((c) => overlap(c.touch, issue.touch) || c.interface_change || issue.interface_change)) { reasons[id] = 'conflicts with another candidate; run after it'; continue; }
    if (touchesDeps(issue) && (active.length || chosen.length)) { reasons[id] = 'dependency-changing issues run alone'; continue; }
    if (chosen.some((c) => touchesDeps(c))) { reasons[id] = 'a dependency-changing issue is queued first'; continue; }
    chosen.push(issue);
  }
  return { claimable: chosen.map((i) => i.id), waiting: reasons, active: active.map((l) => l.issue) };
}

// ---------- finish: all machine gates for one issue ----------
export function finish(p, id) {
  const lease = readLease(p, id);
  if (!lease) throw new Error(`no lease for ${id}`);
  if (findIssue(p, id) !== 'doing') throw new Error(`${id} is not in doing/`);
  if (!lease.worktree) return blockIssue(p, id, 'worker never attached', []);
  if (lease.violations?.length) return blockIssue(p, id, 'scope violated during execution', lease.violations.map((v) => `${v.file} via ${v.command}`));
  const wt = lease.worktree;
  const steps = [];
  const red = (step, evidence) => { steps.push({ step, ok: false }); return blockIssue(p, id, `machine gate red: ${step}`, evidence, steps); };

  // 1. commit the worktree and diff against base
  if (tryGit(wt, 'status', '--porcelain') !== '') { git(wt, 'add', '-A'); git(wt, 'commit', '-qm', `harness: ${id}`); }
  const changed = (tryGit(wt, 'diff', '--name-only', `${lease.base_sha}..HEAD`) || '').split('\n').filter(Boolean);
  const outside = changed.filter((f) => matchesAny(f, lease.do_not_touch || []) || !matchesAny(f, lease.touch || []));
  if (outside.length) return red('scope post-diff', outside.map((f) => `${f} is outside touch`));
  if (!changed.length) return red('empty result', ['the worker changed nothing']);
  steps.push({ step: 'scope post-diff', ok: true, files: changed });

  // 2. container checker (imports + ownership)
  const chk = runChecker(wt);
  if (!chk.ok) return red('container checker', chk.output.trim().split('\n'));
  steps.push({ step: 'container checker', ok: true });

  // 3. issue verify commands, exact strings
  for (const c of lease.allowed_commands || []) {
    const r = spawnSync(c, { cwd: wt, shell: true, encoding: 'utf8' });
    if (r.status !== 0) return red(`verify: ${c}`, ((r.stdout || '') + (r.stderr || '')).trim().split('\n'));
    steps.push({ step: `verify: ${c}`, ok: true });
  }
  // 4. project typecheck / build
  const { manifest } = readManifest(wt);
  for (const k of ['typecheck', 'build']) {
    const c = manifest?.verify?.[k];
    if (!c) continue;
    const r = spawnSync(c, { cwd: wt, shell: true, encoding: 'utf8' });
    if (r.status !== 0) return red(`${k}: ${c}`, ((r.stdout || '') + (r.stderr || '')).trim().split('\n'));
    steps.push({ step: `${k}: ${c}`, ok: true });
  }
  lease.finished = true;
  lease.head_sha = git(wt, 'rev-parse', 'HEAD');
  writeLease(p, lease);
  return { ok: true, id, review: lease.review, steps, changed };
}

// ---------- block ----------
export function blockIssue(p, id, reason, evidence = [], steps = []) {
  const where = findIssue(p, id);
  const src = issueFile(p, where, id);
  const text = fs.readFileSync(src, 'utf8');
  // evidence router: long evidence goes to a log file for utility triage; the blocked body stays short for the planner
  let shown = evidence, logRef = '';
  if (evidence.length > 20 || evidence.join('\n').length > 2000) {
    const logFile = path.join(p.harness, 'runtime', 'logs', `${id}-${Date.now()}.log`);
    fs.mkdirSync(path.dirname(logFile), { recursive: true });
    fs.writeFileSync(logFile, evidence.join('\n') + '\n');
    shown = evidence.slice(-8);
    logRef = `\n\nFull log (${evidence.length} lines): ${logFile.replace(/\\/g, '/')} — dispatch harness:utility to triage it before the planner reads anything.`;
  }
  const stamp = `\n\n## Blocked (${new Date().toISOString()})\n\nObserved: ${reason}\n\nEvidence:\n${shown.map((e) => `- ${e}`).join('\n') || '- (none)'}${logRef}\n\nWhy this issue cannot decide: needs the planner (re-slice, fix dependencies, settle the contract) or /dig.\n\nBoundary affected: see evidence.\n`;
  fs.writeFileSync(issueFile(p, 'blocked', id), text + stamp);
  if (where !== 'blocked') fs.unlinkSync(src);
  // no identical retry: remember what was tried
  const manifestText = fs.existsSync(path.join(p.root, 'ARCHITECTURE.md')) ? fs.readFileSync(path.join(p.root, 'ARCHITECTURE.md'), 'utf8') : '';
  writeJsonAtomic(path.join(p.harness, 'runtime', 'blocked', `${id}.json`), { fingerprint: issueFingerprint(text, manifestText), reason, at: Date.now() });
  discardLease(p, id);
  return { ok: false, id, blocked: reason, evidence: shown, log: logRef ? logRef.trim() : undefined, steps };
}

export function discardLease(p, id) {
  const lease = readLease(p, id);
  if (!lease) return;
  if (lease.worktree && fs.existsSync(lease.worktree)) tryGit(p.root, 'worktree', 'remove', '--force', lease.worktree);
  tryGit(p.root, 'worktree', 'prune');
  if (lease.branch) tryGit(p.root, 'branch', '-D', lease.branch);
  try { fs.unlinkSync(leasePath(p, id)); } catch {}
}

export function diff(p, id) {
  const lease = readLease(p, id);
  if (!lease?.worktree) throw new Error(`${id} has no attached worktree`);
  return gitRaw(lease.worktree, 'diff', `${lease.base_sha}..HEAD`);
}

// ---------- merge ----------
export function merge(p, id, { approved = false } = {}) {
  const lease = readLease(p, id);
  if (!lease?.finished) throw new Error(`${id} has not passed harness finish`);
  if (lease.review === 'planner' && !approved) throw new Error(`${id} needs planner review: run harness merge ${id} --approved after the planner approves`);
  const state = readState(p);
  if (state.violations?.length) throw new Error(`main tree has unresolved violations: ${state.violations.map((v) => v.file).join(', ')}`);
  const dirty = (tryGit(p.root, 'status', '--porcelain') || '').split('\n').filter(Boolean).map((l) => l.slice(l.indexOf(' ', 1) + 1)); // tolerant of the trimmed first line
  const foreign = dirty.filter((f) => !f.startsWith('.work/'));
  if (foreign.length) throw new Error(`main tree is dirty outside .work/: ${foreign.join(', ')} — commit or stash before merging`);
  if (dirty.length) { git(p.root, 'add', '-A', '.work'); git(p.root, 'commit', '-qm', 'harness: queue state'); }
  const base = lease.base || 'main';
  if (tryGit(p.root, 'branch', '--show-current') !== base) throw new Error(`main tree is not on ${base}`);
  const m = spawnSync('git', ['merge', '--no-ff', '-m', `harness: merge ${id}`, lease.head_sha], { cwd: p.root, encoding: 'utf8' });
  if (m.status !== 0) {
    tryGit(p.root, 'merge', '--abort');
    return blockIssue(p, id, 'merge conflict with base', (m.stdout + m.stderr).trim().split('\n').slice(-20));
  }
  const chk = runChecker(p.root);
  if (!chk.ok) {
    git(p.root, 'reset', '--hard', 'ORIG_HEAD');
    return blockIssue(p, id, 'integration gate red after merge', chk.output.trim().split('\n'));
  }
  // runtime smoke: unit/typecheck/build green but the app does not boot is a failure only this layer can see
  const smoke = readManifest(p.root).manifest?.verify?.smoke;
  if (smoke) {
    const r = spawnSync(smoke, { cwd: p.root, shell: true, encoding: 'utf8' });
    if (r.status !== 0) {
      git(p.root, 'reset', '--hard', 'ORIG_HEAD');
      return blockIssue(p, id, `runtime smoke red after merge: ${smoke}`, ((r.stdout || '') + (r.stderr || '')).trim().split('\n'));
    }
  }
  fs.renameSync(issueFile(p, 'doing', id), issueFile(p, 'done', id));
  git(p.root, 'add', '-A', '.work'); git(p.root, 'commit', '-qm', `harness: ${id} done`);
  discardLease(p, id);
  return { ok: true, id, merged: lease.head_sha };
}

// ---------- integrate ----------
export function integrateTicket(p, tid) {
  const t = readTicket(p, tid);
  if (!t) throw new Error(`no ticket ${tid}`);
  const mine = (dir) => listIssues(p, dir).filter((i) => i.startsWith(tid + '-'));
  const open = [...mine('ready'), ...mine('doing'), ...mine('blocked')];
  if (open.length) return { ok: false, reason: `open issues: ${open.join(', ')}` };
  const done = mine('done');
  if (!done.length && !t.data.closed) return { ok: false, reason: 'no done issues for this ticket' };
  // acceptance contract: machine (verify) → runtime (boot/click/observe) → human (only what needs a person)
  const steps = [];
  const run = (kind, c) => {
    const r = spawnSync(c, { cwd: p.root, shell: true, encoding: 'utf8' });
    const out = ((r.stdout || '') + (r.stderr || '')).trim().split('\n');
    steps.push({ slot: kind, step: c, ok: r.status === 0, tail: out.slice(-20) });
    if (r.status !== 0 && out.length > 40) {
      const logFile = path.join(p.harness, 'runtime', 'logs', `${tid}-${kind}-${Date.now()}.log`);
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.writeFileSync(logFile, out.join('\n') + '\n');
      steps[steps.length - 1].log = logFile.replace(/\\/g, '/') + ' — dispatch harness:utility to triage';
    }
    return r.status === 0;
  };
  for (const c of t.data.verify || []) if (!run('machine', c)) return { ok: false, reason: `integration verify red: ${c}`, steps };
  const chk = runChecker(p.root);
  steps.push({ slot: 'machine', step: 'container checker', ok: chk.ok });
  if (!chk.ok) return { ok: false, reason: 'container checker red', steps, output: chk.output };
  for (const c of t.data.runtime || []) if (!run('runtime', c)) return { ok: false, reason: `runtime acceptance red: ${c}`, steps };
  return { ok: true, ticket: tid, done, steps, human: t.data.human || [], next: (t.data.human || []).length
    ? `planner integration review, then show the user the human acceptance items, then harness close ticket ${tid}`
    : `planner integration review, then harness close ticket ${tid}` };
}
export function closeTicket(p, tid) {
  const t = readTicket(p, tid);
  if (!t) throw new Error(`no ticket ${tid}`);
  for (const i of listIssues(p, 'done').filter((i) => i.startsWith(tid + '-'))) fs.unlinkSync(issueFile(p, 'done', i));
  t.data.closed = true;
  fs.writeFileSync(ticketFile(p, tid), stringifyFrontmatter(t.data, t.body));
  syncPlan(p);
  return { ok: true, ticket: tid };
}
export function integrateFeature(p, fid) {
  const tickets = listTickets(p).filter((t) => t.startsWith(fid + '-'));
  if (!tickets.length) return { ok: false, reason: `no tickets for ${fid}` };
  const openT = tickets.filter((t) => !readTicket(p, t).data.closed);
  if (openT.length) return { ok: false, reason: `tickets not closed: ${openT.join(', ')}` };
  const { manifest } = readManifest(p.root);
  const steps = [];
  const chk = runChecker(p.root);
  steps.push({ step: 'container checker', ok: chk.ok });
  if (!chk.ok) return { ok: false, reason: 'container checker red', steps, output: chk.output };
  for (const k of ['test', 'build', 'smoke']) {
    const c = manifest?.verify?.[k];
    if (!c) continue;
    const r = spawnSync(c, { cwd: p.root, shell: true, encoding: 'utf8' });
    steps.push({ step: `${k}: ${c}`, ok: r.status === 0, tail: ((r.stdout || '') + (r.stderr || '')).trim().split('\n').slice(-20) });
    if (r.status !== 0) return { ok: false, reason: `${k} red`, steps };
  }
  const human = tickets.flatMap((t) => (readTicket(p, t).data.human || []).map((h) => `${t}: ${h}`));
  return { ok: true, feature: fid, tickets, steps, human, next: `acceptance against the confirmed direction (human items above), then harness close feature ${fid}` };
}
export function closeFeature(p, fid) {
  for (const t of listTickets(p).filter((t) => t.startsWith(fid + '-'))) fs.unlinkSync(ticketFile(p, t));
  syncPlan(p);
  const scratch = path.join(p.harness, 'scratch');
  if (fs.existsSync(scratch)) for (const f of fs.readdirSync(scratch)) fs.rmSync(path.join(scratch, f), { recursive: true, force: true });
  tryGit(p.root, 'worktree', 'prune');
  return { ok: true, feature: fid };
}

// PLAN.md is generated from ticket files: active work only, no history.
export function syncPlan(p) {
  const tickets = listTickets(p).map((id) => ({ id, ...readTicket(p, id).data }));
  const features = {};
  for (const t of tickets) (features[t.feature || t.id.slice(0, 3)] ||= []).push(t);
  const lines = ['# PLAN — active work (generated by harness, do not edit)', ''];
  const q = { ready: listIssues(p, 'ready'), doing: listIssues(p, 'doing'), blocked: listIssues(p, 'blocked'), done: listIssues(p, 'done') };
  for (const [f, ts] of Object.entries(features)) {
    lines.push(`- ${f} ${ts[0].feature_title || ''}`.trimEnd());
    for (const t of ts) {
      const st = t.closed ? 'closed' : 'open';
      const issues = QUEUE_DIRS.flatMap((d) => q[d].filter((i) => i.startsWith(t.id + '-')).map((i) => `${i}:${d}`));
      lines.push(`  - ${t.id} ${t.title || ''} [${st}]${issues.length ? ' ' + issues.join(' ') : ''}`.replace(/\s+\[/, ' ['));
    }
  }
  fs.mkdirSync(path.join(p.root, '.work'), { recursive: true });
  fs.writeFileSync(path.join(p.root, '.work', 'PLAN.md'), lines.join('\n') + '\n');
}
