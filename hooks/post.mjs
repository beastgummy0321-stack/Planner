// PostToolUse: scope diff after a worker's Bash; validate ARCHITECTURE.md / feature / issue files after writes.
import fs from 'node:fs';
import path from 'node:path';
import { findProject, readLease, writeLease, rel, matchesAny, norm, snapshot, changedBetween, readJson, readStdinJson } from '../lib/core.mjs';
import { validateManifestFile, validateIssueFile, validateFeatureFile } from '../lib/validate.mjs';

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
  if (!base) return; // only worker calls are baselined
  try { fs.unlinkSync(file); } catch {}
  const lease = readLease(project, base.lease);
  if (!lease) return;
  const bad = [
    // .work/ and .harness/ in the main tree belong to the control plane (claim/release/merge/planner run while workers build);
    // a worker cannot write them from its worktree (gate.mjs), so a change there is never the worker's doing.
    ...changedBetween(base.trees.main, snapshot(project.root)).filter((f) => !/^\.(work|harness)\//.test(f)).map((f) => `${f} (main tree)`),
    ...(lease.worktree ? changedBetween(base.trees.worktree, snapshot(lease.worktree)).filter((f) => matchesAny(f, lease.do_not_touch || []) || !matchesAny(f, lease.touch || [])).map((f) => `${f} (outside touch)`) : []),
  ];
  if (!bad.length) return;
  lease.violations = [...(lease.violations || []), ...bad.map((f) => ({ file: f, tool_use_id: id, command: input.tool_input?.command }))];
  writeLease(project, lease);
  fail(`harness: Bash changed files outside the issue's scope:\n  ${bad.join('\n  ')}\nIssue ${lease.issue} is now violated: it will be moved to blocked/ and its worktree discarded by harness finish.`);
}

function afterWrite() {
  const target = input.tool_input?.file_path;
  if (!target) return;
  const abs = norm(path.resolve(cwd, target));
  const r = rel(project.root, abs);
  let errors = [];
  if (r === 'ARCHITECTURE.md') errors = validateManifestFile(project.root, abs);
  else if (/^\.work\/(ready|doing|blocked|done)\/[^/]+\.md$/.test(r)) errors = validateIssueFile(abs, project.root);
  else if (/^\.work\/features\/[^/]+\.md$/.test(r)) errors = validateFeatureFile(abs);
  if (errors.length) fail(`harness: ${r} is invalid:\n  ${errors.join('\n  ')}`);
}
