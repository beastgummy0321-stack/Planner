// PostToolUse: baseline diff after Bash; validate ARCHITECTURE.md / .work issue files after writes.
import fs from 'node:fs';
import path from 'node:path';
import {
  findProject, readState, writeState, readLease, writeLease, findLeaseByCwd, findLeaseByAgent,
  rel, matchesAny, norm, snapshot, changedBetween, readJson, readStdinJson,
} from '../lib/core.mjs';
import { validateManifestFile, validateIssueFile } from '../lib/validate.mjs';

const input = readStdinJson();
const cwd = input.cwd || process.cwd();
const project = findProject(cwd);
if (!project) process.exit(0);

const tool = input.tool_name;
if (tool === 'Bash') afterBash();
else if (['Write', 'Edit', 'MultiEdit'].includes(tool)) afterWrite();
process.exit(0);

function fail(msg) { process.stderr.write(msg + '\n'); process.exit(2); }

function afterBash() {
  const id = input.tool_use_id;
  if (!id) return;
  const file = path.join(project.harness, 'runtime', 'baselines', `${id}.json`);
  const base = readJson(file, null);
  if (!base) return;
  try { fs.unlinkSync(file); } catch {}
  const state = readState(project);
  const lease = base.lease ? readLease(project, base.lease) : (findLeaseByCwd(project, cwd) || findLeaseByAgent(project, input.agent_id));
  const problems = [];

  // main tree
  const mainChanged = changedBetween(base.trees.main, snapshot(project.root));
  const mainAllow = lease ? [] : mainAllowFor(state.mode, state);
  const mainBad = mainChanged.filter((f) => !matchesAny(f, mainAllow));
  if (mainBad.length) problems.push(...mainBad.map((f) => `${f} (main tree, mode ${state.mode}${lease ? ', by worker ' + lease.issue : ''})`));

  // worktree
  if (lease?.worktree && base.trees.worktree) {
    const wtChanged = changedBetween(base.trees.worktree, snapshot(lease.worktree));
    const bad = wtChanged.filter((f) => matchesAny(f, lease.do_not_touch || []) || !matchesAny(f, lease.touch || []));
    if (bad.length) {
      lease.violations = [...(lease.violations || []), ...bad.map((f) => ({ file: f, tool_use_id: id, command: input.tool_input?.command }))];
      writeLease(project, lease);
      problems.push(...bad.map((f) => `${f} (worktree of ${lease.issue}, outside touch)`));
    }
  }
  if (!problems.length) return;
  if (!lease) {
    state.violations = [...(state.violations || []), ...mainBad.map((f) => ({ file: f, tool_use_id: id, mode: state.mode, command: input.tool_input?.command }))];
    writeState(project, state);
  }
  fail(`harness: Bash changed files outside the allowlist:\n  ${problems.join('\n  ')}\n` +
    (lease ? `Issue ${lease.issue} is now violated: it will be moved to blocked/ and its worktree discarded by harness finish.`
           : `Revert these files (git checkout -- <file> / delete untracked) to clear state.violations; mode changes and merges are refused until then.`));
}

function mainAllowFor(mode, state) {
  if (mode === 'grill') return ['.harness/scratch/**'];
  if (mode === 'plan') return ['ARCHITECTURE.md', '.work/**', '.harness/**', ...(state.plan_allow || [])];
  if (mode === 'work') return ['.work/**', '.harness/**'];
  return ['**'];
}

function afterWrite() {
  const target = input.tool_input?.file_path;
  if (!target) return;
  const abs = norm(path.resolve(cwd, target));
  const r = rel(project.root, abs);
  let errors = [];
  if (r === 'ARCHITECTURE.md') errors = validateManifestFile(project.root, abs);
  else if (/^\.work\/(ready|doing|blocked|done)\/[^/]+\.md$/.test(r)) errors = validateIssueFile(abs);
  if (errors.length) fail(`harness: ${r} is invalid:\n  ${errors.join('\n  ')}`);
}
