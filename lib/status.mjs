// SessionStart / `harness status`: what we are doing and why, in a dozen lines. Never planning history, never the rule set.
import { listLeases, tryGit } from './core.mjs';
import { listFeatures, readFeature, featureIssues } from './queue.mjs';

const section = (body, name) => {
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
  for (const f of features) {
    lines.push(`Feature: ${f.id} — ${f.data.title}${f.data.branch ? ` (branch ${f.data.branch}${branch && branch !== f.data.branch ? `, main tree is on ${branch}` : ''})` : ''}`);
    const outcome = section(f.body, 'Outcome'); if (outcome.length) lines.push(`Outcome: ${outcome.join(' ')}`);
    const decisions = section(f.body, 'Decisions'); if (decisions.length) lines.push('Decisions:', ...decisions.map((d) => (d.startsWith('-') ? d : `- ${d}`)));
    const q = featureIssues(project, f.id);
    lines.push(`Queue: doing ${q.doing.join(', ') || 'none'} · ready ${q.ready.join(', ') || 'none'} · blocked ${q.blocked.join(', ') || 'none'} · done ${q.done.length}`);
  }
  const interruptions = leases.map((l) => `${l.issue}: ${l.worktree ? 'worker was active in ' + l.worktree : 'claimed, worker never attached'}${l.violations?.length ? ' (VIOLATED)' : ''}`);
  lines.push(`Last interruption: ${interruptions.length ? interruptions.join('; ') + ' — /crank recovers it' : 'none'}`);
  return lines.join('\n');
}
