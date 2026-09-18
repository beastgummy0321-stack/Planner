import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { issueProjectChecks } from '../lib/queue.mjs';
import { validateManifest } from '../lib/validate.mjs';
import { tmpRepo, workReady, writeFeature, writeIssue, ISSUE, workerDoes, harness, MANIFEST, hook } from './helpers.mjs';

test('issue profiles narrow only wholly matched changes; interfaces and unknown paths retain full gates', () => {
  const m = MANIFEST();
  m.verify = { typecheck: 'full', build: 'build', issue_profiles: [
    { only: ['app/tests/**'], typecheck: 'backend', build: null },
  ] };
  assert.deepEqual(issueProjectChecks(m, ['app/tests/test_x.py', 'docs/x.md']), { typecheck: 'backend', build: null });
  for (const files of [[], ['app/api.py'], ['app/tests/test_x.py', 'frontend/a.ts'], ['package.json'], ['ARCHITECTURE.md']]) {
    assert.deepEqual(issueProjectChecks(m, files), { typecheck: 'full', build: 'build' });
  }
  assert.deepEqual(issueProjectChecks(m, ['app/tests/test_x.py'], true), { typecheck: 'full', build: 'build' });
});

test('malformed profiles and subset-free typecheck without full tests fail validation', () => {
  for (const profile of [{ only: ['../outside'], build: null }, { only: [], build: null }, { only: ['app/**'], test: null }, { only: ['app/**'], build: '' }]) {
    const m = MANIFEST(); m.verify.issue_profiles = [profile];
    assert.ok(validateManifest(m).length, JSON.stringify(profile));
  }
  const m = MANIFEST(); m.verify.typecheck_before_test = 'node -e 0';
  assert.ok(validateManifest(m).some(e => e.includes('requires both typecheck and test')));
  m.verify.typecheck = 'node -e 0';
  assert.deepEqual(validateManifest(m), []);
});

test('finish uses the narrow profile but retains checker and issue tests; integration retains build and full tests', { timeout: 120000 }, () => {
  const marker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'harness-scoped-')), 'calls.txt').replace(/\\/g, '/');
  const mark = text => `node -e "require('fs').appendFileSync('${marker}','${text}')"`;
  const r = tmpRepo();
  workReady(r, { checker: { command: mark('C') }, verify: {
    typecheck: mark('D'), typecheck_before_test: mark('I'), build: mark('B'), test: mark('T'), smoke: mark('S'),
    issue_profiles: [{ only: ['src/modules/identity/**'], typecheck: mark('P'), build: null }],
  } });
  writeIssue(r, 'ready', ISSUE({ verify: [mark('V')] }));
  workerDoes(r, 'F01-I01', w => fs.writeFileSync(path.join(w, 'src/modules/identity/new.ts'), 'export const value = 2;\n'));
  let result = harness(r, 'finish', 'F01-I01');
  assert.equal(result.code, 0, result.out + result.err);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'CVP');
  assert.equal(harness(r, 'merge', 'F01-I01').code, 0);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'CVPCS');
  fs.writeFileSync(marker, '');
  result = harness(r, 'integrate', 'feature', 'F01');
  assert.equal(result.code, 0, result.out + result.err);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'CIBTS');
});

test('a scoped issue still fails on its required behavior test', { timeout: 120000 }, () => {
  const r = tmpRepo();
  workReady(r, { verify: { typecheck: 'node -e 0', build: 'node -e 0', issue_profiles: [{ only: ['src/modules/identity/**'], build: null }] } });
  writeIssue(r, 'ready', ISSUE({ verify: ['node -e "process.exit(1)"'] }));
  workerDoes(r, 'F01-I01', w => fs.writeFileSync(path.join(w, 'src/modules/identity/new.ts'), 'export const value = 2;\n'));
  const result = harness(r, 'finish', 'F01-I01');
  assert.equal(result.code, 1);
  assert.match(result.out, /machine gate red: verify/);
});

test('session injection keeps inactive feature status without loading its long decisions', () => {
  const r = tmpRepo(); workReady(r);
  writeFeature(r, { id: 'F02', title: 'Unrelated open work', branch: 'other', human: ['Review result'] }, '# Outcome\nUNRELATED_SECRET_CONTEXT\n# Decisions\n- unrelated decision\n# Acceptance\nx\n');
  let result = hook('session', { cwd: r }, r);
  assert.match(result.out, /F02 — Unrelated open work/);
  assert.match(result.out, /human acceptance items: 1/);
  assert.match(result.out, /\.work\/features\/F02.md/);
  assert.doesNotMatch(result.out, /UNRELATED_SECRET_CONTEXT|unrelated decision/);
  writeIssue(r, 'ready', ISSUE());
  assert.equal(harness(r, 'claim', 'F01-I01').code, 0);
  writeFeature(r, {}, '# Outcome\n' + 'x'.repeat(3000) + '\n# Decisions\n- active constraint\n# Acceptance\nx\n');
  result = hook('session', { cwd: r }, r);
  assert.match(result.out, /active constraint/);
  assert.doesNotMatch(result.out, /x{601}/);
  assert.match(result.out, /full context in feature file/);
});
