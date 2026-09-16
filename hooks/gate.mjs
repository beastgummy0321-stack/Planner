// PreToolUse: the execution container. It governs workers only — has the worker a lease, is it in its worktree,
// is the file inside touch and outside do_not_touch, is the command destructive. The main conversation and the
// planner are never scope-gated here (anything may advise, only execution isolation and failed verification may
// block); the destructive-command reflex below is the one deny that applies to everyone.
import path from 'node:path';
import { appendFileSync as fsAppend } from 'node:fs';
import {
  findProject, findLeaseByCwd, findLeaseByAgent, listLeases, writeLease,
  assertNoWorkerCommands, isInside, rel, matchesAny, norm, snapshot, writeJsonAtomic, readStdinJson, deny, allow,
} from '../lib/core.mjs';
import { needsRuntime, envIsReady } from '../lib/adapters.mjs';
import { toolKind, commandOf, roleOf, writeTargets } from '../lib/host.mjs';

// Commands that destroy work before any PostToolUse diff can see it. ponytail: a reflex denylist, not a sandbox —
// `node -e "fs.rmSync(...)"` still gets through; for a worker the scope diff catches that after the fact.
const DESTRUCTIVE = [
  /\bgit\s+(reset\s+--hard|clean\b|push\s+.*(--force|-f\b)|branch\s+-D|worktree\s+remove\s+.*--force)/,
  /\brm\s+(-\w*r|-\w*f)/, /\bRemove-Item\b.*-Recurse/i, /\brmdir\s+\/s/i, /\bdel\s+\/[sq]/i,
];

const input = readStdinJson();
const cwd = input.cwd || process.cwd();
const project = findProject(cwd);
if (process.env.HARNESS_DEBUG_LOG && !(project && isInside(process.env.HARNESS_DEBUG_LOG, project.root))) {
  try { fsAppend(process.env.HARNESS_DEBUG_LOG, JSON.stringify({ hook: 'gate', input }) + '\n'); } catch {}
}
if (!project) allow();

const tool = toolKind(input);
const agentType = input.agent_type || '';
const lease = findLeaseByCwd(project, cwd) || findLeaseByAgent(project, input.agent_id);
const isWorker = !!lease || /worker/i.test(agentType);

if (tool === 'write' || tool === 'patch') gateWrite();
else if (tool === 'shell') gateBash();
else if (tool === 'agent') gateAgent();
allow();

function gateWrite() {
  if (!isWorker) {
    let targets;
    try { targets = writeTargets(input); } catch(e) { deny(e.message); }
    if (targets.some(t => isInside(path.resolve(cwd,t), project.root) && !/^\.(work|harness)\//.test(rel(project.root,path.resolve(cwd,t))))) {
      try { assertNoWorkerCommands(project); } catch(e) { deny(e.message); }
    }
    allow();
  }
  let targets;
  try { targets = writeTargets(input); } catch (e) { deny(e.message); }
  if (!targets.length) deny('write target unavailable; use a supported scoped edit tool');
  if (!lease) deny('worker without a lease: run harness attach <issue> first');
  if (!lease.worktree) deny(`issue ${lease.issue}: run harness attach before writing`);
  for (const target of targets) {
  const abs = norm(path.resolve(cwd, target));
  if (!isInside(abs, lease.worktree)) deny(`issue ${lease.issue}: ${abs} is outside its worktree`);
  const r = rel(lease.worktree, abs);
  if (matchesAny(r, ['.work/**', 'ARCHITECTURE.md', '.harness/**'])) deny(`worker may not edit ${r}`);
  if (matchesAny(r, lease.do_not_touch || [])) deny(`issue ${lease.issue}: ${r} is in do_not_touch`);
  if (!matchesAny(r, lease.touch || [])) deny(`issue ${lease.issue}: ${r} is outside touch ${JSON.stringify(lease.touch)}`);
  }
  allow();
}

function harnessCli(cmd, subs) {
  const pluginRoot = norm(process.env.PLUGIN_ROOT || process.env.CLAUDE_PLUGIN_ROOT || path.resolve(import.meta.dirname, '..'));
  const re = new RegExp(`^node\\s+"?${pluginRoot ? escapeRe(pluginRoot) : '\\S*'}/bin/harness\\.mjs"?\\s+(${subs})\\b`, 'i');
  return re.test(cmd.replace(/\\/g, '/'));
}

function gateBash() {
  const cmd = commandOf(input).trim();
  const hit = DESTRUCTIVE.find((re) => re.test(cmd));
  if (hit) deny(`destructive command denied before it runs (${hit}). Revert single files instead; resets and cleans go through harness.`);
  if (!isWorker) allow();
  if (harnessCli(cmd, 'attach|status|env')) {
    // record identity at attach time so later calls resolve the lease by agent_id as well as by cwd
    const m = /attach\s+(\S+)/.exec(cmd);
    if (m && input.agent_id && lease && !lease.agent_id) { lease.agent_id = input.agent_id; writeLease(project, lease); }
    allow();
  }
  if (!lease) deny('worker Bash: run harness attach <issue> first');
  if (!lease.worktree) deny(`issue ${lease.issue}: run harness attach before running commands`);
  if (lease.violations?.length) deny(`issue ${lease.issue} is violated; Bash disabled until the issue is blocked`);
  if (needsRuntime(cmd) && !envIsReady(lease)) deny('runtime dependencies are not prepared for these inputs: run harness env in this worktree, then retry');
  baseline();
  allow();
}

function gateAgent() {
  const sub = roleOf(input);
  try { fsAppend(path.join(project.harness, 'runtime', 'metrics.jsonl'), JSON.stringify({ agent: sub, ts: Date.now() }) + '\n'); } catch {}
  if (/worker/i.test(sub) && !listLeases(project).some((l) => !l.worktree)) deny('worker dispatch requires a claimed issue: run harness claim <id> first');
  allow();
}

// every worker Bash call is diffed afterwards (post.mjs): worktree changes outside touch and any main-tree change are violations
function baseline() {
  const id = input.tool_use_id;
  if (!id) return;
  writeJsonAtomic(path.join(project.harness, 'runtime', 'baselines', `${id}.json`), { cwd, lease: lease.issue, trees: { main: snapshot(project.root), worktree: snapshot(lease.worktree) } });
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
