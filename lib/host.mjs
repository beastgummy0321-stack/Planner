// Normalize host payloads; policy stays in gate/post.
export function toolKind(input) {
  const name = input.tool_name || '';
  if (['Bash', 'exec_command', 'shell_command'].includes(name)) return 'shell';
  if (name === 'apply_patch') return 'patch';
  if (['Write', 'Edit', 'MultiEdit', 'NotebookEdit'].includes(name)) return 'write';
  if (['Agent', 'spawn_agent'].includes(name)) return 'agent';
  return 'other';
}
export function commandOf(input) { return String(input.tool_input?.command ?? input.tool_input?.cmd ?? ''); }
export function roleOf(input) { return String(input.tool_input?.subagent_type ?? input.tool_input?.agent_type ?? input.tool_input?.role ?? ''); }
export function writeTargets(input) {
  if (toolKind(input) !== 'patch') return [input.tool_input?.file_path || input.tool_input?.notebook_path].filter(Boolean);
  const patch = input.tool_input?.command ?? input.tool_input?.patch ?? input.tool_input?.input;
  if (typeof patch !== 'string' || !patch.startsWith('*** Begin Patch') || !patch.trimEnd().endsWith('*** End Patch')) throw new Error('unrecognized patch: expected a complete apply_patch envelope');
  const paths = [];
  for (const line of patch.split(/\r?\n/)) {
    const m = /^\*\*\* (?:Add File|Update File|Delete File|Move to): (.+)$/.exec(line);
    if (m) paths.push(m[1]);
  }
  if (!paths.length) throw new Error('patch has no target paths');
  return [...new Set(paths)];
}
