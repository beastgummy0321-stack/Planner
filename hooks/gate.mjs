// PreToolUse: the No-Build gate, the scope gate, the worker Bash allowlist, dispatch control.
import path from 'node:path';
import {
  findProject, readState, findLeaseByCwd, findLeaseByAgent, listLeases, writeLease, worktreeRoot,
  isInside, rel, matchesAny, norm, snapshot, writeJsonAtomic, readStdinJson, deny, allow,
} from '../lib/core.mjs';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const PLAN_ALLOW = ['ARCHITECTURE.md', '.work/**', '.harness/**'];
const WORK_MAIN_ALLOW = ['.work/**', '.harness/**'];
const GRILL_ALLOW = ['.harness/scratch/**'];

const input = readStdinJson();
const cwd = input.cwd || process.cwd();
const project = findProject(cwd);
if (!project) allow();

const state = readState(project);
const mode = state.mode;
const tool = input.tool_name;
const agentType = input.agent_type || '';
const lease = findLeaseByCwd(project, cwd) || findLeaseByAgent(project, input.agent_id);
const isWorker = !!lease || /worker/i.test(agentType);

if (WRITE_TOOLS.has(tool)) gateWrite();
else if (tool === 'Bash') gateBash();
else if (tool === 'Agent') gateAgent();
allow();

function gateWrite() {
  const target = input.tool_input?.file_path || input.tool_input?.notebook_path;
  if (!target) allow();
  const abs = norm(path.resolve(cwd, target));

  if (lease) {
    if (!lease.worktree) deny(`issue ${lease.issue}: run harness attach before writing`);
    if (!isInside(abs, lease.worktree)) deny(`issue ${lease.issue}: ${abs} is outside its worktree`);
    const r = rel(lease.worktree, abs);
    if (matchesAny(r, ['.work/**', 'ARCHITECTURE.md', '.harness/**'])) deny(`worker may not edit ${r}`);
    if (matchesAny(r, lease.do_not_touch || [])) deny(`issue ${lease.issue}: ${r} is in do_not_touch`);
    if (!matchesAny(r, lease.touch || [])) deny(`issue ${lease.issue}: ${r} is outside touch ${JSON.stringify(lease.touch)}`);
    allow();
  }
  if (isWorker) deny('worker without a lease: run harness attach <issue> first');

  if (!isInside(abs, project.root)) {
    // A linked worktree that nobody attached: nothing may be written there.
    const top = worktreeRoot(cwd);
    if (top && isInside(abs, top) && !isInside(top, project.root)) deny('unattached worktree: run harness attach <issue>');
    allow(); // outside the project entirely (e.g. session scratchpad)
  }
  const r = rel(project.root, abs);
  if (mode === 'grill') {
    if (matchesAny(r, GRILL_ALLOW)) allow();
    deny(`No-Build gate: mode is grill, only .harness/scratch/** may be written (${r}). Only the user ends /grill by typing /plan.`);
  }
  if (mode === 'plan') {
    if (matchesAny(r, [...PLAN_ALLOW, ...(state.plan_allow || [])])) allow();
    deny(`plan mode: ${r} is not ARCHITECTURE.md, .work/**, .harness/** or an approved checker config path`);
  }
  if (mode === 'work') {
    if (matchesAny(r, WORK_MAIN_ALLOW)) allow();
    deny(`work mode: the main tree is orchestration only (.work/**, .harness/**); implementation happens in a claimed worktree (${r})`);
  }
  allow();
}

function gateBash() {
  const cmd = String(input.tool_input?.command || '').trim();
  if (isWorker) {
    const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ? norm(process.env.CLAUDE_PLUGIN_ROOT) : null;
    const fixed = pluginRoot ? new RegExp(`^node\\s+"?${escapeRe(pluginRoot)}/bin/harness\\.mjs"?\\s+(attach|status|env)\\b`, 'i') : null;
    const harnessCall = fixed && fixed.test(cmd.replace(/\\/g, '/'));
    if (harnessCall) {
      const m = /attach\s+(\S+)/.exec(cmd);
      if (m && input.agent_id) {
        // Record identity at attach time; the CLI fills in worktree/branch/base_sha.
        const l = lease || null;
        if (l && !l.agent_id) { l.agent_id = input.agent_id; writeLease(project, l); }
      }
      allow();
    }
    if (!lease) deny('worker Bash is default-deny: run harness attach <issue> first');
    if (lease.violations?.length) deny(`issue ${lease.issue} is violated; Bash disabled until the issue is blocked`);
    const allowed = (lease.allowed_commands || []).map((c) => c.trim());
    if (!allowed.includes(cmd)) deny(`worker Bash is default-deny. Allowed exactly: ${JSON.stringify(allowed)}. Explore with Read/Grep/Glob.`);
    baseline();
    allow();
  }
  baseline();
  allow();
}

function gateAgent() {
  const sub = String(input.tool_input?.subagent_type || '');
  const wantsWorker = /worker/i.test(sub);
  const wantsPlanner = /planner/i.test(sub);
  if (mode === 'grill' && (wantsWorker || wantsPlanner)) deny('No-Build gate: mode is grill; no planner or worker dispatch until the user types /plan');
  if (mode === 'plan' && wantsWorker) deny('plan mode: no worker dispatch until the user types /work');
  if (wantsWorker) {
    const pending = listLeases(project).filter((l) => !l.worktree);
    if (!pending.length) deny('worker dispatch requires a claimed issue: run harness claim <id> first');
  }
  allow();
}

function baseline() {
  const id = input.tool_use_id;
  if (!id) return;
  const trees = { main: snapshot(project.root) };
  if (lease?.worktree) trees.worktree = snapshot(lease.worktree);
  writeJsonAtomic(path.join(project.harness, 'runtime', 'baselines', `${id}.json`), { cwd, lease: lease?.issue || null, trees });
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }
