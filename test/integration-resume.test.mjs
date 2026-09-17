import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { tmpRepo, workReady, writeIssue, ISSUE, harness } from './helpers.mjs';

function scenario(t, { failure = 'T', runtime = [], smoke = 'S' } = {}) {
  const r = tmpRepo();
  t.after(() => fs.rmSync(r, { recursive: true, force: true }));
  fs.appendFileSync(path.join(r, '.gitignore'), 'dist/\n');
  fs.writeFileSync(path.join(r, 'gate.cjs'), `const fs = require('fs');
const step = process.argv[2];
fs.appendFileSync('.harness/scratch/order', step);
if(step === 'B') { fs.mkdirSync('dist',{recursive:true}); fs.writeFileSync('dist/app','built'); }
if(step === '${failure}' && fs.existsSync('.harness/scratch/fail')) process.exit(1);
`);
  const mark = x => `node gate.cjs ${x}`;
  workReady(r, { checker: { command: mark('C') }, verify: {
    typecheck: mark('Y'), build: mark('B'), build_outputs: ['dist'], test: mark('T'), smoke: mark(smoke),
  }}, { runtime: runtime.map(mark) });
  writeIssue(r, 'done', ISSUE());
  execFileSync('git', ['add', '.'], { cwd: r, stdio: 'pipe' });
  execFileSync('git', ['commit', '-qm', 'done'], { cwd: r, stdio: 'pipe' });
  const fail = path.join(r, '.harness/scratch/fail');
  fs.writeFileSync(fail, 'once');
  const first = harness(r, 'integrate', 'feature', 'F01');
  assert.equal(first.code, 1, first.out + first.err);
  assert.match(JSON.parse(first.out).reason, /red/);
  assert.equal(harness(r, 'close', 'feature', 'F01').code, 1, 'partial progress is not acceptance');
  fs.rmSync(fail);
  fs.writeFileSync(path.join(r, '.harness/scratch/order'), '');
  return { r, order: () => fs.readFileSync(path.join(r, '.harness/scratch/order'), 'utf8') };
}

test('explicit resume reuses passed stages and unchanged build, then runs failed test and smoke', t => {
  const {r, order} = scenario(t);
  const result = harness(r, 'integrate', 'feature', 'F01', '--resume');
  assert.equal(result.code, 0, result.out + result.err);
  assert.equal(order(), 'CTS');
  assert.equal(JSON.parse(result.out).steps.filter(s => s.reused).length, 2);
  assert.equal(harness(r, 'close', 'feature', 'F01').code, 0);
});

test('normal integration is fresh even when a checkpoint exists', t => {
  const {r, order} = scenario(t);
  assert.equal(harness(r, 'integrate', 'feature', 'F01').code, 0);
  assert.equal(order(), 'CYBTS');
});

test('changed build output invalidates build and all following machine stages', t => {
  const {r, order} = scenario(t);
  fs.writeFileSync(path.join(r, 'dist/app'), 'changed');
  assert.equal(harness(r, 'integrate', 'feature', 'F01', '--resume').code, 0);
  assert.equal(order(), 'CBTS');
});

test('source changes invalidate the entire checkpoint', t => {
  const {r, order} = scenario(t);
  fs.appendFileSync(path.join(r, 'src/modules/identity/index.ts'), '// changed\n');
  execFileSync('git', ['commit', '-am', 'source changed'], {cwd:r});
  assert.equal(harness(r, 'integrate', 'feature', 'F01', '--resume').code, 0);
  assert.equal(order(), 'CYBTS');
});

test('missing build output forces rebuilding', t => {
  const {r, order} = scenario(t);
  fs.rmSync(path.join(r, 'dist/app'));
  assert.equal(harness(r, 'integrate', 'feature', 'F01', '--resume').code, 0);
  assert.equal(order(), 'CBTS');
});

test('a changed environment invalidates every machine checkpoint', t => {
  const {r, order} = scenario(t);
  const before = process.env.HARNESS_RESUME_TEST;
  t.after(() => { if (before === undefined) delete process.env.HARNESS_RESUME_TEST; else process.env.HARNESS_RESUME_TEST = before; });
  process.env.HARNESS_RESUME_TEST = 'changed';
  assert.equal(harness(r, 'integrate', 'feature', 'F01', '--resume').code, 0);
  assert.equal(order(), 'CYBTS');
});

test('changed feature acceptance invalidates every stage even without a commit', t => {
  const {r, order} = scenario(t);
  fs.appendFileSync(path.join(r, '.work/features/F01.md'), '\nChanged acceptance\n');
  assert.equal(harness(r, 'integrate', 'feature', 'F01', '--resume').code, 0);
  assert.equal(order(), 'CYBTS');
});

test('expired checkpoints fall back to a fresh run', t => {
  const {r, order} = scenario(t);
  const file = path.join(r, '.harness/runtime/integrations/F01.progress.json');
  const progress = JSON.parse(fs.readFileSync(file));
  progress.at = 0;
  fs.writeFileSync(file, JSON.stringify(progress));
  assert.equal(harness(r, 'integrate', 'feature', 'F01', '--resume').code, 0);
  assert.equal(order(), 'CYBTS');
});

test('runtime reruns even when its exact command has a cached machine result', t => {
  const {r, order} = scenario(t, {failure: 'S', runtime: ['T']});
  const result = harness(r, 'integrate', 'feature', 'F01', '--resume');
  assert.equal(result.code, 0, result.out + result.err);
  assert.equal(order(), 'CST');
  assert.equal(JSON.parse(result.out).steps.filter(s => s.reused).length, 3);
});

test('a failed build is never reused even if it wrote an output file', t => {
  const {r, order} = scenario(t, {failure: 'B'});
  assert.equal(harness(r, 'integrate', 'feature', 'F01', '--resume').code, 0);
  assert.equal(order(), 'CBTS');
});

test('corrupt checkpoint data falls back to a fresh run', t => {
  const {r, order} = scenario(t);
  fs.writeFileSync(path.join(r, '.harness/runtime/integrations/F01.progress.json'), '{broken');
  assert.equal(harness(r, 'integrate', 'feature', 'F01', '--resume').code, 0);
  assert.equal(order(), 'CYBTS');
});
