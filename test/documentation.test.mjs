import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import assert from 'node:assert/strict';
import { docsOnly } from '../lib/queue.mjs';
import { validateManifest } from '../lib/validate.mjs';
import { tmpRepo, workReady, writeIssue, ISSUE, workerDoes, harness, MANIFEST } from './helpers.mjs';

test('prose fast path excludes runtime prompts, executable manifest and assets', () => {
  assert.equal(docsOnly(['README.md', 'docs/architecture/ads.md']), true);
  for (const file of ['app/methodology/image.md', 'app/departments/ads/task.md', 'ARCHITECTURE.md', 'frontend/src/logo.svg', 'src/config.txt']) {
    assert.equal(docsOnly([file]), false, file);
  }
  assert.equal(docsOnly([]), false);
});

test('a Markdown runtime prompt cannot bypass a failing project gate', { timeout: 120000 }, () => {
  const r = tmpRepo();
  workReady(r, { verify: { typecheck: 'node -e "process.exit(1)"' } });
  writeIssue(r, 'ready', ISSUE({ touch: ['app/methodology/**'], verify: ['git status'] }));
  const wt = workerDoes(r, 'F01-I01', w => {
    fs.mkdirSync(path.join(w, 'app/methodology'), { recursive: true });
    fs.writeFileSync(path.join(w, 'app/methodology/task.md'), 'runtime instruction\n');
  });
  const result = JSON.parse(harness(r, 'finish', 'F01-I01').out);
  assert.equal(result.ok, false);
  assert.equal(result.repairable, true);
  assert.match(result.reason, /typecheck/);
  assert.ok(fs.existsSync(wt));
});

test('integration deduplicates checker, builds before tests and reuses that build for smoke', { timeout: 120000 }, () => {
  const marker = path.join(os.tmpdir(), `harness-order-${Date.now()}.txt`).replace(/\\/g, '/');
  const mark = x => `node -e "require('fs').appendFileSync('${marker}','${x}')"`;
  const r = tmpRepo();
  workReady(r, { checker: { command: mark('C') }, verify: {
    typecheck: mark('Y'), build: mark('B'), test: mark('T'), smoke: mark('S'), smoke_after_build: mark('R'),
  } }, { verify: [mark('C'), mark('T')] });
  writeIssue(r, 'ready', ISSUE({ verify: [mark('C')] }));
  workerDoes(r, 'F01-I01', w => fs.writeFileSync(path.join(w, 'src/modules/identity/new.ts'), 'export const fresh = true;\n'));
  assert.equal(harness(r, 'finish', 'F01-I01').code, 0);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'CYB', 'finish checker runs once');
  assert.equal(harness(r, 'merge', 'F01-I01').code, 0);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'CYBCS', 'merge retains standalone smoke');
  fs.writeFileSync(marker, '');
  const result = harness(r, 'integrate', 'feature', 'F01');
  assert.equal(result.code, 0, result.out + result.err);
  assert.equal(fs.readFileSync(marker, 'utf8'), 'CYBTR');
  fs.rmSync(marker);
});

test('build-reusing smoke cannot be configured without standalone smoke and build', () => {
  const m = MANIFEST();
  m.verify.smoke_after_build = 'node -e 0';
  assert.ok(validateManifest(m).some(x => x.includes('requires both build and smoke')));
});

test('build output declarations reject traversal, runtime state and missing build commands', () => {
  for (const output of ['../outside', '/absolute', 'C:/outside', 'dist/**', '.harness/runtime', 'dist/../src', '']) {
    const m = MANIFEST();
    m.verify.build = 'node -e 0';
    m.verify.build_outputs = [output];
    assert.ok(validateManifest(m).some(x => x.includes('build_outputs')), output);
  }
  const m = MANIFEST();
  m.verify.build_outputs = ['dist'];
  assert.ok(validateManifest(m).some(x => x.includes('build_outputs')));
  m.verify.build = 'node -e 0';
  assert.deepEqual(validateManifest(m), []);
});
