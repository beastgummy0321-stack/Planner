import fs from 'node:fs';
import path from 'node:path';
import { readState, listLeases, QUEUE_DIRS } from './core.mjs';

export function queue(root) {
  const out = {};
  for (const d of QUEUE_DIRS) {
    const dir = path.join(root, '.work', d);
    out[d] = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => f.slice(0, -3)).sort() : [];
  }
  return out;
}

export function statusText(project) {
  const s = readState(project);
  const q = queue(project.root);
  const leases = listLeases(project);
  const cli = process.env.CLAUDE_PLUGIN_ROOT ? `node "${process.env.CLAUDE_PLUGIN_ROOT.replace(/\\/g, '/')}/bin/harness.mjs"` : 'harness';
  const lines = [`harness: mode=${s.mode} (cli: ${cli})`];
  if (q.doing.length) lines.push(`doing: ${q.doing.join(', ')}`);
  if (q.ready.length) lines.push(`ready: ${q.ready.join(', ')}`);
  if (q.blocked.length) lines.push(`blocked: ${q.blocked.join(', ')}`);
  if (q.done.length) lines.push(`done (awaiting ticket integration): ${q.done.join(', ')}`);
  for (const l of leases) lines.push(`lease ${l.issue}: ${l.worktree ? 'attached ' + l.worktree : 'awaiting attach'}${l.violations?.length ? ' VIOLATED' : ''}`);
  if (s.violations?.length) lines.push(`violations (revert to clear): ${s.violations.map((v) => v.file).join(', ')}`);
  lines.push(s.mode === 'grill' ? 'No-Build gate active: only .harness/scratch/** is writable; only the user ends /grill by typing /plan.'
    : s.mode === 'plan' ? 'plan mode: ARCHITECTURE.md and .work/** writable; /work when issues are ready.'
    : 'work mode: main tree is orchestration only; implementation runs in claimed worktrees via /work.');
  return lines.join('\n');
}
