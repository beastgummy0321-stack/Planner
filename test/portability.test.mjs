import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { toolKind, writeTargets } from '../lib/host.mjs';
import { needsRuntime } from '../lib/adapters.mjs';
import { tmpRepo, workReady, writeIssue, ISSUE, harness, hook, workerDoes } from './helpers.mjs';

test('native patch includes source and rename destination; malformed patches fail closed', () => {
  const patch = '*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: secret/a.ts\n@@\n-x\n+y\n*** Delete File: src/b.ts\n*** End Patch';
  assert.deepEqual(writeTargets({tool_name:'apply_patch',tool_input:{command:patch}}), ['src/a.ts','secret/a.ts','src/b.ts']);
  assert.throws(() => writeTargets({tool_name:'apply_patch',tool_input:{command:'bad'}}), /envelope/);
  assert.equal(toolKind({tool_name:'exec_command'}), 'shell');
  assert.equal(toolKind({tool_name:'spawn_agent'}), 'agent');
});

test('host-neutral worktree, native hook scope, and revoked authorization', () => {
  const r = tmpRepo(); workReady(r, null); writeIssue(r, 'ready', ISSUE({verify:['node -e 0']}));
  assert.equal(harness(r,'claim','F01-I01').code,0);
  const w = harness(r,'worktree','F01-I01'); assert.equal(w.code,0,w.err);
  const wt = path.join(r,'.harness/worktrees/F01-I01');
  assert.ok(fs.existsSync(wt)); assert.equal(harness(wt,'attach','F01-I01').code,0);
  const patch = '*** Begin Patch\n*** Update File: src/modules/identity/index.ts\n*** Move to: src/modules/billing/moved.ts\n@@\n-a\n+b\n*** End Patch';
  const result = hook('gate',{cwd:wt,tool_name:'apply_patch',tool_input:{command:patch}},wt);
  assert.equal(result.denied,true); assert.match(result.reason,/do_not_touch/);
  assert.equal(harness(r,'release','F01-I01').code,0);
  assert.equal(harness(r,'revoke','F01').code,0);
  assert.notEqual(harness(r,'claim','F01-I01').code,0);
  const malformed = hook('gate',{cwd:r,tool_name:'apply_patch',tool_input:{command:'bad'}},r);
  assert.equal(malformed.denied,true);
});

test('compound runtime commands are detected but builtin probes stay cold', () => {
  assert.equal(needsRuntime('echo ready && npm test'),true);
  assert.equal(needsRuntime('echo ready; python app.py'),true);
  assert.equal(needsRuntime('node -e 0'),false);
});

test('failed verification retains edits for repair; closure requires a current integration receipt', () => {
  const r = tmpRepo(); workReady(r, null);
  writeIssue(r, 'ready', ISSUE({verify:[`node -e "if (!require('fs').readFileSync('src/modules/identity/index.ts','utf8').includes('fixed')) process.exit(1)"`]}));
  const wt = workerDoes(r,'F01-I01', w => fs.writeFileSync(path.join(w,'src/modules/identity/index.ts'),'broken\n'));
  const failed = harness(r,'finish','F01-I01');
  assert.match(failed.out,/repairable/); assert.ok(fs.existsSync(wt));
  fs.writeFileSync(path.join(wt,'src/modules/identity/index.ts'),'fixed\n');
  const finish = harness(r,'finish','F01-I01'); assert.equal(finish.code,0,finish.err + finish.out);
  const merge = harness(r,'merge','F01-I01'); assert.equal(merge.code,0,merge.err + merge.out);
  const close = harness(r,'close','feature','F01'); assert.notEqual(close.code,0); assert.match(close.err,/integration/);
  const integrate = harness(r,'integrate','feature','F01'); assert.equal(integrate.code,0,integrate.err + integrate.out);
  const file = path.join(r,'.work/features/F01.md'); fs.appendFileSync(file,'\nChanged acceptance detail\n');
  assert.notEqual(harness(r,'close','feature','F01').code,0,'changed acceptance invalidates receipt');
});
