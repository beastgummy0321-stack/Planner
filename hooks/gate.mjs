// PreToolUse: the execution container. It governs workers only — has the worker a lease, is it in its worktree,
// is the file inside touch and outside do_not_touch, is the command destructive. The main conversation and the
// planner are never scope-gated here (anything may advise, only execution isolation and failed verification may
// block); the destructive-command reflex below is the one deny that applies to everyone.
import path from 'node:path';
import { appendFileSync as fsAppend } from 'node:fs';
import {
  findProject, findLeaseByCwd, findLeaseByAgent, listLeases, writeLease,
  isInside, rel, matchesAny, norm, snapshot, writeJsonAtomic, readStdinJson, deny, allow,
} from '../lib/core.mjs';
import { needsRuntime, ensureEnv } from '../lib/adapters.mjs';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
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

const tool = input.tool_name;
const agentType = input.agent_type || '';
const lease = findLeaseByCwd(project, cwd) || findLeaseByAgent(project, input.agent_id);
const isWorker = !!lease || /worker/i.test(agentType);

if (WRITE_TOOLS.has(tool)) gateWrite();
else if (tool === 'Bash') gateBash();
else if (tool === 'Agent') gateAgent();
allow();

function gateWrite() {
  if (!isWorker) allow();
  const target = input.tool_input?.file_path || input.tool_input?.notebook_path;
  if (!target) allow();
  if (!lease) deny('worker without a lease: run harness attach <issue> first');
  if (!lease.worktree) deny(`issue ${lease.issue}: run harness attach before writing`);
  const abs = norm(path.resolve(cwd, target));
  if (!isInside(abs, lease.worktree)) deny(`issue ${lease.issue}: ${abs} is outside its worktree`);
  const r = rel(lease.worktree, abs);
  if (matchesAny(r, ['.work/**', 'ARCHITECTURE.md', '.harness/**'])) deny(`worker may not edit ${r}`);
  if (matchesAny(r, lease.do_not_touch || [])) deny(`issue ${lease.issue}: ${r} is in do_not_touch`);
  if (!matchesAny(r, lease.touch || [])) deny(`issue ${lease.issue}: ${r} is outside touch ${JSON.stringify(lease.touch)}`);
  allow();
}

function harnessCli(cmd, subs) {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ? norm(process.env.CLAUDE_PLUGIN_ROOT) : null;
  const re = new RegExp(`^node\\s+"?${pluginRoot ? escapeRe(pluginRoot) : '\\S*'}/bin/harness\\.mjs"?\\s+(${subs})\\b`, 'i');
  return re.test(cmd.replace(/\\/g, '/'));
}

function gateBash() {
  const cmd = String(input.tool_input?.command || '').trim();
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
  if (needsRuntime(cmd)) {
    // lazy env: the frozen install runs here, once, before the first command that needs a runtime
    const e = ensureEnv(project, lease);
    if (!e.ok) deny(`issue ${lease.issue}: environment setup failed before ${cmd}: ${JSON.stringify(e.log)}`);
  }
  baseline();
  allow();
}

function gateAgent() {
  const sub = String(input.tool_input?.subagent_type || '');
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
