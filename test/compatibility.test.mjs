import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { toolKind } from '../lib/host.mjs';
import { findProject } from '../lib/core.mjs';
import { statusText } from '../lib/status.mjs';
import { tmpRepo, workReady, hook, harness } from './helpers.mjs';

test('hook matchers route every supported host tool into policy', () => {
  const config = JSON.parse(fs.readFileSync(new URL('../hooks/hooks.json', import.meta.url)));
  for (const event of ['PreToolUse', 'PostToolUse']) {
    for (const tool of ['Bash', 'exec_command', 'shell_command', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Agent', 'apply_patch', 'spawn_agent']) {
      assert.notEqual(toolKind({tool_name: tool}), 'other');
      assert.ok(config.hooks[event].some(h => new RegExp(`^(?:${h.matcher})$`).test(tool)), `${event}: ${tool}`);
    }
  }
});

test('Codex shell payloads reach destructive-command policy without executing commands', () => {
  const r = tmpRepo(); workReady(r, null);
  for (const tool_name of ['exec_command', 'shell_command']) {
    const result = hook('gate', {cwd:r, tool_name, tool_input:{cmd:'git reset --hard'}}, r);
    assert.equal(result.denied, true, result.out + result.err);
    assert.equal(hook('gate', {cwd:r, tool_name, tool_input:{cmd:'git status --short'}}, r).denied, false);
  }
});

test('empty queue still reports open feature and human acceptance requirements', () => {
  const r = tmpRepo(); workReady(r, null, {human:['Review the preview']});
  assert.match(statusText(findProject(r)), /Closure: open.*human acceptance items: 1/);
  assert.equal(harness(r, 'close', 'feature', 'F01').code, 1);
  assert.ok(fs.existsSync(`${r}/.work/features/F01.md`));
});
