// PreToolUse: the No-Build gate, the scope gate, the worker Bash allowlist, dispatch control.
import path from 'node:path';
import { appendFileSync as fsAppend } from 'node:fs';
import {
  findProject, readState, findLeaseByCwd, findLeaseByAgent, listLeases, writeLease, readLease, worktreeRoot,
  isInside, rel, matchesAny, norm, snapshot, writeJsonAtomic, readStdinJson, deny, allow, planHash,
} from '../lib/core.mjs';

const WRITE_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
const PLAN_ALLOW = ['ARCHITECTURE.md', '.work/**', '.harness/**'];
const WORK_MAIN_ALLOW = ['.work/**', '.harness/**'];
const GRILL_ALLOW = ['.harness/scratch/**'];
// Commands that destroy work before any PostToolUse diff can see it. ponytail: a reflex denylist, not a sandbox —
// `node -e "fs.rmSync(...)"` still gets through; the baseline diff catches that after the fact.
const DESTRUCTIVE = [
  /\bgit\s+(reset\s+--hard|clean\b|checkout\s+(--|\.)|restore\b|stash\s+drop|push\s+.*(--force|-f\b)|branch\s+-D|worktree\s+remove\s+.*--force)/,
  /\brm\s+(-\w*r|-\w*f)/, /\bRemove-Item\b.*-Recurse/i, /\brmdir\s+\/s/i, /\bdel\s+\/[sq]/i,
  /\b(npm|pnpm|yarn|pip|pip3|uv|poetry)\s+(install|i|add|uninstall|remove|rm|update|upgrade)\b/, // packages enter through /carve approval, into a worker's privileged list
];
const READ_ONLY_GIT = /^git\s+(status|log|diff|show|branch|worktree\s+list|rev-parse|ls-files|blame)\b/;


const input = readStdinJson();
const cwd = input.cwd || process.cwd();
const project = findProject(cwd);
if (process.env.HARNESS_DEBUG_LOG && !(project && isInside(process.env.HARNESS_DEBUG_LOG, project.root))) {
  // never write the debug log inside the governed tree: it would dirty the baseline diff
  try { fsAppend(process.env.HARNESS_DEBUG_LOG, JSON.stringify({ hook: 'gate', input }) + '\n'); } catch {}
}
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
    deny(`No-Build gate: mode is grill, only .harness/scratch/** may be written (${r}). Only the user ends /dig by typing /carve.`);
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

function harnessCli(cmd, subs) {
  const pluginRoot = process.env.CLAUDE_PLUGIN_ROOT ? norm(process.env.CLAUDE_PLUGIN_ROOT) : null;
  const re = new RegExp(`^node\\s+"?${pluginRoot ? escapeRe(pluginRoot) : '\\S*'}/bin/harness\\.mjs"?\\s+(${subs})\\b`, 'i');
  return re.test(cmd.replace(/\\/g, '/'));
}

function gateBash() {
  const cmd = String(input.tool_input?.command || '').trim();
  if (isWorker) {
    const harnessCall = harnessCli(cmd, 'attach|status|env');
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
  if (harnessCli(cmd, '\\w[\\w-]*')) {
    // planner review receipt: hook-written, so the control plane cannot approve on the planner's behalf
    const m = /\breview\s+(\S+)\s+approve\b/.exec(cmd);
    if (m && /planner/i.test(agentType)) {
      const l = readLease(project, m[1]);
      if (l?.finished) writeJsonAtomic(path.join(project.harness, 'runtime', 'reviews', `${m[1]}.json`), { issue: m[1], verdict: 'approve', head_sha: l.head_sha, agent_id: input.agent_id || null, agent_type: agentType, at: Date.now() });
    }
    allow();
  }
  const hit = DESTRUCTIVE.find((re) => re.test(cmd));
  if (hit) deny(`destructive command denied before it runs (${hit}). The governed tree is not a scratchpad: probes go under .harness/scratch/probes, packages through /carve, resets through harness.`);
  if (mode === 'work' && !agentType && !READ_ONLY_GIT.test(cmd)) deny('work mode: the main conversation runs only harness commands and read-only git; workers implement, utility collects evidence');
  baseline();
  allow();
}

function gateAgent() {
  const sub = String(input.tool_input?.subagent_type || '');
  const wantsWorker = /worker/i.test(sub);
  const wantsPlanner = /planner/i.test(sub);
  const wantsChallenger = /challenger/i.test(sub);
  if (mode === 'grill' && (wantsWorker || wantsPlanner || wantsChallenger)) deny('No-Build gate: mode is grill; no planner, challenger or worker dispatch until the user types /carve');
  if (mode === 'plan' && wantsWorker) deny('plan mode: no worker dispatch until the user types /crank');
  if (wantsChallenger) {
    if (mode !== 'plan') deny('the Independent Challenge runs in plan mode on a finished draft');
    const prompt = String(input.tool_input?.prompt || '');
    if (/rationale|reasoning|why I chose|my thinking/i.test(prompt)) deny('the challenger must not receive the planner\'s reasoning or rationale — only the confirmed outcome, ARCHITECTURE.md, PLAN, tickets, issues');
    // hook-written record: the model cannot fake that a challenge was dispatched this round; PostToolUse marks it completed
    writeJsonAtomic(path.join(project.harness, 'runtime', 'challenge.json'), { dispatched_at: Date.now(), completed: false, verdict: null, plan_hash: planHash(project.root), tool_use_id: input.tool_use_id || null });
  }
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
