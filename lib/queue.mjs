// Queue scheduling and the /crank lifecycle scripts: next, finish, merge, block, diff, recover, feature start/integrate/close.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { QUEUE_DIRS, readLease, writeLease, listLeases, leasePath, git, tryGit, gitRaw, readJson, parseFrontmatter, stringifyFrontmatter, matchesAny, writeJsonAtomic, issueFingerprint } from './core.mjs';
import { validateIssueText, validateFeatureText, readManifest } from './validate.mjs';
import { runChecker, needsRuntime, ensureEnv } from './adapters.mjs';

const DEP_FILES = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'pyproject.toml', 'uv.lock', 'requirements.txt'];
// A diff made only of prose and static assets cannot change an import graph, a type, a build or a boot: the import
// checker, typecheck, build and smoke are skipped for it. CSS and JSON stay out of this list — both can break a build.
const NON_CODE = /\.(md|txt|svg|png|jpe?g|gif|ico|webp)$/i;
export const docsOnly = (files) => files.length > 0 && files.every((f) => NON_CODE.test(f));

// ---------- issues ----------
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
export function isDone(p, id) {
  if (listIssues(p, 'done').includes(id)) return true;
  return !readFeature(p, id.slice(0, 3)); // issues of a closed feature were deleted with it
}
export function touchesDeps(issue) {
  return (issue.touch || []).some((g) => DEP_FILES.some((f) => path.posix.matchesGlob(f, g)));
}
export function overlap(a = [], b = []) {
  // conservative: two globs overlap when either literal prefix contains the other
  const prefix = (g) => g.split(/[*?[{]/)[0];
  return a.some((x) => b.some((y) => { const px = prefix(x), py = prefix(y); return px.startsWith(py) || py.startsWith(px); }));
}

// ---------- features (.work/features/F01.md) ----------
export function featureFile(p, id) { return path.join(p.root, '.work', 'features', `${id}.md`); }
export function readFeature(p, id) {
  const f = featureFile(p, id);
  if (!fs.existsSync(f)) return null;
  const { feature, body, errors } = validateFeatureText(fs.readFileSync(f, 'utf8'));
  return feature ? { data: feature, body, errors } : null;
}
export function listFeatures(p) {
  const d = path.join(p.root, '.work', 'features');
  return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort() : [];
}
export function featureIssues(p, fid) {
  const out = {};
  for (const d of QUEUE_DIRS) out[d] = listIssues(p, d).filter((i) => i.startsWith(fid + '-'));
  return out;
}
// The feature branch: created from the current branch and checked out in the main tree, so every issue worktree
// branches from it and every merge lands on it. A feature without `branch` works on whatever branch is checked out.
export function startFeature(p, fid) {
  const f = readFeature(p, fid);
  if (!f) throw new Error(`no feature ${fid} (.work/features/${fid}.md)`);
  if (f.errors.length) throw new Error(`feature ${fid} invalid:\n  ${f.errors.join('\n  ')}`);
  const current = tryGit(p.root, 'branch', '--show-current') || 'main';
  if (!f.data.branch) return { ok: true, feature: fid, branch: current, note: 'no branch declared: working on the current branch' };
  if (f.data.branch === current) return { ok: true, feature: fid, branch: current, note: 'already on the feature branch' };
  if (!f.data.base) { f.data.base = current; fs.writeFileSync(featureFile(p, fid), stringifyFrontmatter(f.data, f.body)); }
  const exists = tryGit(p.root, 'rev-parse', '--verify', '--quiet', `refs/heads/${f.data.branch}`) !== null;
  const r = spawnSync('git', exists ? ['checkout', '-q', f.data.branch] : ['checkout', '-q', '-b', f.data.branch], { cwd: p.root, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`could not check out ${f.data.branch}: ${(r.stderr || '').trim()}`);
  return { ok: true, feature: fid, branch: f.data.branch, base: f.data.base, created: !exists };
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

  const { manifest } = readManifest(wt);
  const prose = docsOnly(changed);
  // lazy env: install once, only when a gate below actually needs a runtime in this worktree
  const runtimeCmds = [...(lease.verify_commands || []), ...(prose ? [] : [manifest?.checker?.command, manifest?.verify?.typecheck, manifest?.verify?.build])];
  if (runtimeCmds.some(needsRuntime)) {
    const e = ensureEnv(p, lease);
    if (!e.ok) return red('environment setup', e.log.map((l) => JSON.stringify(l)));
    if (!e.cached) steps.push({ step: 'environment', ok: true });
  }

  // 2. architecture container (imports + ownership + legacy facades) — skipped when the project has none
  if (prose) steps.push({ step: 'container checker', skipped: 'docs-only diff' });
  else {
    const chk = runChecker(wt);
    if (!chk.ok) return red('container checker', chk.output.trim().split('\n'));
    steps.push(chk.skipped ? { step: 'container checker', skipped: chk.skipped } : { step: 'container checker', ok: true });
  }

  // 3. issue verify commands — never the privileged ones (a generator/migration runs once, by the worker)
  for (const c of lease.verify_commands || []) {
    const r = spawnSync(c, { cwd: wt, shell: true, encoding: 'utf8' });
    if (r.status !== 0) return red(`verify: ${c}`, ((r.stdout || '') + (r.stderr || '')).trim().split('\n'));
    steps.push({ step: `verify: ${c}`, ok: true });
  }
  // 4. project typecheck / build
  for (const k of ['typecheck', 'build']) {
    const c = manifest?.verify?.[k];
    if (!c) continue;
    if (prose) { steps.push({ step: k, skipped: 'docs-only diff' }); continue; }
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
  const stamp = `\n\n## Blocked (${new Date().toISOString()})\n\nObserved: ${reason}\n\nEvidence:\n${shown.map((e) => `- ${e}`).join('\n') || '- (none)'}${logRef}\n\nWhy this issue cannot decide: needs the planner (re-slice, fix dependencies, settle the contract) or the user.\n\nBoundary affected: see evidence.\n`;
  fs.writeFileSync(issueFile(p, 'blocked', id), text + stamp);
  if (where !== 'blocked') fs.unlinkSync(src);
  // no identical retry: remember what was tried
  const manifestText = fs.existsSync(path.join(p.root, 'ARCHITECTURE.md')) ? fs.readFileSync(path.join(p.root, 'ARCHITECTURE.md'), 'utf8') : '';
  writeJsonAtomic(path.join(p.harness, 'runtime', 'blocked', `${id}.json`), { fingerprint: issueFingerprint(text, manifestText), reason, at: Date.now() });
  discardLease(p, id);
  return { ok: false, id, blocked: reason, evidence: shown, log: logRef ? logRef.trim() : undefined, steps };
}

// ---------- recover: leases whose session is gone ----------
// A worker is a subagent of the session that claimed the issue; when that session died, so did the worker.
// Partial work is saved as a diff log for the planner, the worktree discarded, the issue re-queued unchanged
// (no blocked fingerprint: the issue did not fail, the session did).
export function recover(p, currentSession) {
  const out = [];
  if (!currentSession) return out;
  for (const lease of listLeases(p)) {
    if (lease.session_id === currentSession) continue;
    const id = lease.issue;
    const entry = { issue: id, session: lease.session_id || null, log: null };
    if (lease.worktree && fs.existsSync(lease.worktree)) {
      if (tryGit(lease.worktree, 'status', '--porcelain') !== '') { tryGit(lease.worktree, 'add', '-A'); tryGit(lease.worktree, 'commit', '-qm', `harness: ${id} (recovered)`); }
      const d = lease.base_sha ? (tryGit(lease.worktree, 'diff', `${lease.base_sha}..HEAD`) || '') : '';
      if (d) {
        const logFile = path.join(p.harness, 'runtime', 'logs', `${id}-recovered-${Date.now()}.diff`);
        fs.mkdirSync(path.dirname(logFile), { recursive: true });
        fs.writeFileSync(logFile, d + '\n');
        entry.log = logFile.replace(/\\/g, '/');
      }
    }
    discardLease(p, id);
    if (findIssue(p, id) === 'doing') fs.renameSync(issueFile(p, 'doing', id), issueFile(p, 'ready', id));
    try { fs.unlinkSync(path.join(p.harness, 'runtime', 'reviews', `${id}.json`)); } catch {}
    out.push(entry);
  }
  return out;
}

export function discardLease(p, id) {
  const lease = readLease(p, id);
  if (!lease) return;
  if (lease.worktree && fs.existsSync(lease.worktree)) tryGit(p.root, 'worktree', 'remove', '--force', lease.worktree);
  tryGit(p.root, 'worktree', 'prune');
  if (lease.branch) tryGit(p.root, 'branch', '-D', lease.branch);
  try { fs.unlinkSync(leasePath(p, id)); } catch {}
}

export function diff(p, id, stat = false) {
  const lease = readLease(p, id);
  if (!lease?.worktree) throw new Error(`${id} has no attached worktree`);
  return gitRaw(lease.worktree, 'diff', ...(stat ? ['--stat'] : []), `${lease.base_sha}..HEAD`);
}

// ---------- review receipt ----------
// `harness review <id> approve` records the head it approved; a later commit in the worktree invalidates it.
export function reviewReceipt(p, id) { return readJson(path.join(p.harness, 'runtime', 'reviews', `${id}.json`), null); }
export function approve(p, id) {
  const lease = readLease(p, id);
  if (!lease?.finished) throw new Error(`${id} has not passed harness finish`);
  const rc = { issue: id, verdict: 'approve', head_sha: lease.head_sha, at: Date.now() };
  writeJsonAtomic(path.join(p.harness, 'runtime', 'reviews', `${id}.json`), rc);
  return rc;
}

// ---------- merge ----------
export function merge(p, id) {
  const lease = readLease(p, id);
  if (!lease?.finished) throw new Error(`${id} has not passed harness finish`);
  if (lease.review === 'planner') {
    const rc = reviewReceipt(p, id);
    if (!rc || rc.verdict !== 'approve') throw new Error(`${id} needs planner review: dispatch harness:planner with the issue path; it runs \`harness review ${id} approve\` (or reports a block)`);
    if (rc.head_sha !== lease.head_sha) throw new Error(`${id}: review receipt is for ${rc.head_sha?.slice(0, 8)}, worktree head is ${lease.head_sha.slice(0, 8)}; review again`);
  }
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
  // what the merge actually brought in (ORIG_HEAD is the base before the merge commit); prose cannot break imports or a boot
  const merged = (tryGit(p.root, 'diff', '--name-only', 'ORIG_HEAD..HEAD') || '').split('\n').filter(Boolean);
  const prose = docsOnly(merged);
  if (!prose) {
    const chk = runChecker(p.root);
    if (!chk.ok) {
      git(p.root, 'reset', '--hard', 'ORIG_HEAD');
      return blockIssue(p, id, 'integration gate red after merge', chk.output.trim().split('\n'));
    }
  }
  // runtime smoke: unit/typecheck/build green but the app does not boot is a failure only this layer can see.
  // It runs in the issue's worktree checked out at the merge commit (env installed lazily), never in the main tree:
  // a smoke that passes but writes caches/screenshots must not dirty the governed tree.
  const smoke = readManifest(p.root).manifest?.verify?.smoke;
  if (smoke && !prose) {
    const mergeSha = git(p.root, 'rev-parse', 'HEAD');
    tryGit(lease.worktree, 'checkout', '-q', '--detach', mergeSha);
    if (needsRuntime(smoke)) {
      const e = ensureEnv(p, lease);
      if (!e.ok) { git(p.root, 'reset', '--hard', 'ORIG_HEAD'); return blockIssue(p, id, 'environment setup failed before smoke', e.log.map((l) => JSON.stringify(l))); }
    }
    const r = spawnSync(smoke, { cwd: lease.worktree, shell: true, encoding: 'utf8' });
    if (r.status !== 0) {
      git(p.root, 'reset', '--hard', 'ORIG_HEAD');
      return blockIssue(p, id, `runtime smoke red after merge: ${smoke}`, ((r.stdout || '') + (r.stderr || '')).trim().split('\n'));
    }
  }
  fs.renameSync(issueFile(p, 'doing', id), issueFile(p, 'done', id));
  git(p.root, 'add', '-A', '.work'); git(p.root, 'commit', '-qm', `harness: ${id} done`);
  discardLease(p, id);
  try { fs.unlinkSync(path.join(p.harness, 'runtime', 'reviews', `${id}.json`)); } catch {}
  return { ok: true, id, merged: lease.head_sha, ...(prose ? { skipped: 'docs-only diff: integration checker, smoke' } : {}) };
}

// ---------- feature integration / close ----------
// ponytail: pollution is detected, not prevented — feature acceptance runs in the main tree because it needs the merged base plus an installed env.
export function dirtyOutsideWork(p) {
  let raw = ''; try { raw = gitRaw(p.root, 'status', '--porcelain'); } catch {} // untrimmed: the leading status column is significant
  return raw.split('\n').filter(Boolean).map((l) => l.slice(3)).filter((f) => !f.startsWith('.work/'));
}
export function integrateFeature(p, fid) {
  const f = readFeature(p, fid);
  if (!f) return { ok: false, reason: `no feature ${fid}` };
  const q = featureIssues(p, fid);
  const open = [...q.ready, ...q.doing, ...q.blocked];
  if (open.length) return { ok: false, reason: `open issues: ${open.join(', ')}` };
  if (!q.done.length) return { ok: false, reason: 'no done issues for this feature' };
  // the desired topology must be real by now: every declared module root/public exists
  const { manifest, errors } = readManifest(p.root, { materialized: true });
  if (errors.length) return { ok: false, reason: `architecture not materialized: ${errors.join('; ')}` };
  // acceptance contract: machine (checker, project verify, feature verify) → runtime (boot/click/observe) → human (surfaced, never auto-closed)
  const steps = [];
  const run = (kind, c) => {
    const r = spawnSync(c, { cwd: p.root, shell: true, encoding: 'utf8' });
    const out = ((r.stdout || '') + (r.stderr || '')).trim().split('\n');
    steps.push({ slot: kind, step: c, ok: r.status === 0, tail: out.slice(-20) });
    if (r.status !== 0 && out.length > 40) {
      const logFile = path.join(p.harness, 'runtime', 'logs', `${fid}-${kind}-${Date.now()}.log`);
      fs.mkdirSync(path.dirname(logFile), { recursive: true });
      fs.writeFileSync(logFile, out.join('\n') + '\n');
      steps[steps.length - 1].log = logFile.replace(/\\/g, '/') + ' — dispatch harness:utility to triage';
    }
    return r.status === 0;
  };
  const chk = runChecker(p.root);
  steps.push({ slot: 'machine', step: 'container checker', ok: chk.ok, ...(chk.skipped ? { skipped: chk.skipped } : {}) });
  if (!chk.ok) return { ok: false, reason: 'container checker red', steps, output: chk.output };
  for (const k of ['test', 'build']) if (manifest?.verify?.[k] && !run('machine', manifest.verify[k])) return { ok: false, reason: `${k} red`, steps };
  for (const c of f.data.verify || []) if (!run('machine', c)) return { ok: false, reason: `feature verify red: ${c}`, steps };
  if (manifest?.verify?.smoke && !run('runtime', manifest.verify.smoke)) return { ok: false, reason: 'smoke red', steps };
  for (const c of f.data.runtime || []) if (!run('runtime', c)) return { ok: false, reason: `runtime acceptance red: ${c}`, steps };
  const dirt = dirtyOutsideWork(p);
  if (dirt.length) return { ok: false, reason: `acceptance commands dirtied the main tree: ${dirt.join(', ')} — point them at a sandbox/temp dir, then revert these files`, steps };
  const human = f.data.human || [];
  return { ok: true, feature: fid, done: q.done, steps, human, next: human.length
    ? `planner integration review, then show the user the human acceptance items and the outcome, then harness close feature ${fid}`
    : `planner integration review, then show the user the outcome, then harness close feature ${fid}` };
}
// Close = the feature branch lands on its base, and everything the feature carried is gone: issue bodies, the feature
// file, the branch, scratch, stray worktrees. ARCHITECTURE.md stays; git keeps the history.
export function closeFeature(p, fid) {
  const f = readFeature(p, fid);
  if (!f) throw new Error(`no feature ${fid}`);
  const q = featureIssues(p, fid);
  const open = [...q.ready, ...q.doing, ...q.blocked];
  if (open.length) throw new Error(`open issues: ${open.join(', ')}`);
  if (listLeases(p).length) throw new Error(`active leases: ${listLeases(p).map((l) => l.issue).join(', ')}`);
  for (const i of q.done) fs.unlinkSync(issueFile(p, 'done', i));
  fs.unlinkSync(featureFile(p, fid));
  const scratch = path.join(p.harness, 'scratch');
  if (fs.existsSync(scratch)) for (const x of fs.readdirSync(scratch)) fs.rmSync(path.join(scratch, x), { recursive: true, force: true });
  if (tryGit(p.root, 'status', '--porcelain') !== '') { git(p.root, 'add', '-A', '.work'); git(p.root, 'commit', '-qm', `harness: close ${fid}`); }
  const result = { ok: true, feature: fid };
  const branch = f.data.branch, base = f.data.base;
  if (branch && base && tryGit(p.root, 'branch', '--show-current') === branch) {
    const foreign = dirtyOutsideWork(p);
    if (foreign.length) throw new Error(`main tree is dirty outside .work/: ${foreign.join(', ')} — commit or stash before closing`);
    const co = spawnSync('git', ['checkout', '-q', base], { cwd: p.root, encoding: 'utf8' });
    if (co.status !== 0) throw new Error(`could not check out ${base}: ${(co.stderr || '').trim()}`);
    const m = spawnSync('git', ['merge', '--no-ff', '-m', `harness: feature ${fid} (${f.data.title})`, branch], { cwd: p.root, encoding: 'utf8' });
    if (m.status !== 0) { tryGit(p.root, 'merge', '--abort'); tryGit(p.root, 'checkout', '-q', branch); throw new Error(`merge of ${branch} into ${base} conflicts:\n${(m.stdout + m.stderr).trim().split('\n').slice(-20).join('\n')}`); }
    tryGit(p.root, 'branch', '-d', branch);
    Object.assign(result, { merged: `${branch} → ${base}` });
  }
  tryGit(p.root, 'worktree', 'prune');
  return result;
}
