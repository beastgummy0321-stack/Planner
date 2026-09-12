// SessionStart / `harness status`: what we are doing and why, in a dozen lines. Never planning history, never the rule set.
import fs from 'node:fs';
import path from 'node:path';
import { listLeases, tryGit, readJson, writeJsonAtomic } from './core.mjs';
import { listFeatures, readFeature, featureIssues, dirtyOutsideWork } from './queue.mjs';

export const section = (body, name) => {
  const m = new RegExp(`^# ${name}\\s*\\n([\\s\\S]*?)(?=^# |$(?![\\r\\n]))`, 'm').exec(body);
  return (m ? m[1] : '').trim().split('\n').map((l) => l.trim()).filter(Boolean);
};

export function statusText(project) {
  const cli = process.env.CLAUDE_PLUGIN_ROOT ? `node "${process.env.CLAUDE_PLUGIN_ROOT.replace(/\\/g, '/')}/bin/harness.mjs"` : 'harness';
  const lines = [`harness (cli: ${cli})`];
  const leases = listLeases(project);
  const branch = tryGit(project.root, 'branch', '--show-current');
  const features = listFeatures(project).map((id) => ({ id, ...readFeature(project, id) })).filter((f) => f.data && !f.data.closed);
  if (!features.length) lines.push('no open feature — /dig to think one through, /carve to cut one, or just say what you want');
  else lines.push('Stored state is context, not authority: the newest user message overrides any conflicting Outcome, Decision, issue, prototype or queue state.');
  for (const f of features) {
    lines.push(`Feature: ${f.id} — ${f.data.title}${f.data.branch ? ` (branch ${f.data.branch}${branch && branch !== f.data.branch ? `, main tree is on ${branch}` : ''})` : ''}`);
    const outcome = section(f.body, 'Outcome'); if (outcome.length) lines.push(`Outcome: ${outcome.join(' ')}`);
    const decisions = section(f.body, 'Decisions'); if (decisions.length) lines.push('Decisions:', ...decisions.map((d) => (d.startsWith('-') ? d : `- ${d}`)));
    const q = featureIssues(project, f.id);
    lines.push(`Queue: doing ${q.doing.join(', ') || 'none'} · ready ${q.ready.join(', ') || 'none'} · blocked ${q.blocked.join(', ') || 'none'} · done ${q.done.length}`);
  }
  // what a /clear would otherwise lose: an unfinished discussion and uncommitted work — computed, never recorded
  if (fs.existsSync(path.join(project.harness, 'scratch', 'discovery.md'))) lines.push('Discovery in progress: .harness/scratch/discovery.md — where the last discussion stopped');
  const dirt = dirtyOutsideWork(project);
  if (dirt.length) lines.push(`Uncommitted in main tree: ${dirt.slice(0, 5).join(', ')}${dirt.length > 5 ? ` +${dirt.length - 5} more` : ''}`);
  const interruptions = leases.map((l) => `${l.issue}: ${l.worktree ? 'worker was active in ' + l.worktree : 'claimed, worker never attached'}${l.violations?.length ? ' (VIOLATED)' : ''}`);
  lines.push(`Last interruption: ${interruptions.length ? interruptions.join('; ') + ' — /crank recovers it' : 'none'}`);
  return lines.join('\n');
}

// Handoff check: hooks/compact.mjs counts a session's automatic compactions; every third, SessionStart or the next prompt
// injects this once. Injection is not delivery and the safe point is the model's call: it never blocks, never hands off.
export function handoffCheck(project, sessionId) {
  const file = path.join(project.harness, 'runtime', 'session.json');
  const s = readJson(file, {});
  if (!sessionId || s.session_id !== sessionId || (s.compactions || 0) < (s.advised_at || 0) + 3) return '';
  writeJsonAtomic(file, { ...s, advised_at: s.compactions });
  return `Handoff check: ${s.compactions} automatic compactions this session. At a safe point with a clear next step and a concrete gain, open the final answer with one /handoff suggestion; mid-change, same stage, pure Q&A, or already declined: stay silent.`;
}
