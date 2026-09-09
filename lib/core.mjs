// Shared primitives for hooks and the CLI. No dependencies beyond node.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const MODES = ['grill', 'plan', 'work'];
export const QUEUE_DIRS = ['ready', 'doing', 'blocked', 'done'];

// ---------- paths ----------
// Canonical absolute path with forward slashes. Resolves symlinks and Windows 8.3 short names
// (RUNNER~1 vs runneradmin) so a hook cwd and a git-reported worktree path compare equal.
export function norm(p) {
  const abs = path.resolve(p);
  let head = abs, tail = [];
  for (;;) {
    try { return [fs.realpathSync.native(head), ...tail].join(path.sep).replace(/\\/g, '/'); } catch {}
    const up = path.dirname(head);
    if (up === head) return abs.replace(/\\/g, '/');
    tail.unshift(path.basename(head));
    head = up;
  }
}
export function samePath(a, b) {
  a = norm(a); b = norm(b);
  return process.platform === 'win32' ? a.toLowerCase() === b.toLowerCase() : a === b;
}
export function isInside(child, parent) {
  const c = norm(child), p = norm(parent).replace(/\/+$/, '');
  const cc = process.platform === 'win32' ? c.toLowerCase() : c;
  const pp = process.platform === 'win32' ? p.toLowerCase() : p;
  return cc === pp || cc.startsWith(pp + '/');
}
export function rel(root, p) {
  return path.relative(norm(root), norm(p)).replace(/\\/g, '/');
}
export function matchesAny(relPath, globs = []) {
  return globs.some((g) => path.posix.matchesGlob(relPath, g));
}

// ---------- git ----------
export function gitRaw(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
}
export function git(cwd, ...args) {
  return gitRaw(cwd, ...args).trim();
}
export function tryGit(cwd, ...args) {
  try { return git(cwd, ...args); } catch { return null; }
}
// Main repository root for cwd, even from inside a linked worktree.
export function mainRepoRoot(cwd) {
  const common = tryGit(cwd, 'rev-parse', '--path-format=absolute', '--git-common-dir');
  if (!common) return null;
  return norm(path.dirname(common));
}
export function worktreeRoot(cwd) {
  const top = tryGit(cwd, 'rev-parse', '--show-toplevel');
  return top ? norm(top) : null;
}

// ---------- project ----------
// Project = main repo root that contains .harness/. Returns null when the plugin is inert here.
export function findProject(cwd) {
  let dir = norm(cwd);
  for (;;) {
    if (fs.existsSync(path.join(dir, '.harness', 'state.json'))) return { root: dir, harness: path.join(dir, '.harness') };
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  const main = mainRepoRoot(cwd);
  if (main && fs.existsSync(path.join(main, '.harness', 'state.json'))) return { root: main, harness: path.join(main, '.harness') };
  return null;
}

export function readJson(file, fallback = undefined) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {
    if (fallback !== undefined) return fallback;
    throw e;
  }
}
export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

export function readState(project) {
  return readJson(path.join(project.harness, 'state.json'));
}
export function writeState(project, state) {
  writeJsonAtomic(path.join(project.harness, 'state.json'), state);
}

// ---------- leases ----------
export function leasesDir(project) { return path.join(project.harness, 'runtime', 'leases'); }
export function leasePath(project, id) { return path.join(leasesDir(project), `${id}.json`); }
export function readLease(project, id) { return readJson(leasePath(project, id), null); }
export function writeLease(project, lease) { writeJsonAtomic(leasePath(project, lease.issue), lease); }
export function listLeases(project) {
  const dir = leasesDir(project);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(dir, f)));
}
export function findLeaseByCwd(project, cwd) {
  return listLeases(project).find((l) => l.worktree && isInside(cwd, l.worktree)) || null;
}
export function findLeaseByAgent(project, agentId) {
  if (!agentId) return null;
  return listLeases(project).find((l) => l.agent_id === agentId) || null;
}

// ---------- frontmatter (JSON block between --- fences) ----------
export function parseFrontmatter(text) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text);
  if (!m) throw new Error('missing --- frontmatter fences');
  let data;
  try { data = JSON.parse(m[1]); } catch (e) { throw new Error(`frontmatter is not JSON: ${e.message}`); }
  return { data, body: m[2] };
}
export function stringifyFrontmatter(data, body) {
  return `---\n${JSON.stringify(data, null, 2)}\n---\n${body}`;
}

// ---------- tree snapshot for baseline diffs ----------
// Map of relPath -> content hash for every file git reports as changed or untracked.
export function snapshot(treeRoot) {
  const out = {};
  let raw;
  try { raw = gitRaw(treeRoot, 'status', '--porcelain=v1', '-uall', '-z'); } catch { return out; } // leading space is significant

  const entries = raw.split('\0').filter(Boolean);
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const status = e.slice(0, 2);
    let file = e.slice(3);
    if (status[0] === 'R' || status[0] === 'C') { i++; } // renamed: next entry is the origin path
    const abs = path.join(treeRoot, file);
    let hash = 'deleted';
    try { hash = crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex'); } catch {}
    out[file] = hash;
  }
  return out;
}
export function changedBetween(before, after) {
  const files = new Set([...Object.keys(before), ...Object.keys(after)]);
  return [...files].filter((f) => before[f] !== after[f]).sort();
}
// SPEC §3: reverting a file clears its violation. Reverted = the file's content is back to what it was when the
// offending call started (hash recorded at block time); a file that was clean then is reverted when it is clean
// again against an unchanged HEAD blob. Committing the change is not a revert.
export function gitHead(root) { try { return gitRaw(root, 'rev-parse', 'HEAD').trim(); } catch { return ''; } }
export function fileSha(abs) { try { return crypto.createHash('sha1').update(fs.readFileSync(abs)).digest('hex'); } catch { return 'deleted'; } }
export function pruneViolations(project, state) {
  const all = state.violations || [];
  const live = all.filter((v) => !isReverted(project.root, v));
  if (live.length !== all.length) { state.violations = live; writeState(project, state); }
  return state;
}
function isReverted(root, v) {
  if (v.head === undefined) return false; // recorded before 1.3.1: no baseline evidence, only a manual edit clears it
  if (v.before) return fileSha(path.join(root, v.file)) === v.before;
  const blob = (ref) => { try { return gitRaw(root, 'rev-parse', `${ref}:${v.file}`).trim(); } catch { return null; } };
  return !(v.file in snapshot(root)) && blob('HEAD') === blob(v.head);
}

// ---------- fingerprints (no identical retry) ----------
// The semantic identity of an issue: its text without any "## Blocked" trailer, plus the manifest frontmatter.
export function issueFingerprint(issueText, manifestText = '') {
  const body = issueText.replace(/\n\n## Blocked \([^)]*\)[\s\S]*$/, '');
  const fm = (/^---\r?\n([\s\S]*?)\r?\n---/.exec(manifestText) || [])[1] || '';
  return crypto.createHash('sha1').update(body).update('\0').update(fm).digest('hex');
}
// Hash of the whole planning surface: ARCHITECTURE.md + every file under .work/. Changes when the plan changes.
export function planHash(root) {
  const h = crypto.createHash('sha1');
  const add = (f) => { try { h.update(f).update('\0').update(fs.readFileSync(f)); } catch {} };
  add(path.join(root, 'ARCHITECTURE.md'));
  const walk = (d) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) { const p = path.join(d, e.name); e.isDirectory() ? walk(p) : add(p); } };
  walk(path.join(root, '.work'));
  return h.digest('hex');
}

// ---------- hook I/O ----------
export function readStdinJson() {
  try { return JSON.parse(fs.readFileSync(0, 'utf8') || '{}'); } catch { return {}; }
}
export function deny(reason) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason },
  }));
  process.exit(0);
}
export function allow() { process.exit(0); }
