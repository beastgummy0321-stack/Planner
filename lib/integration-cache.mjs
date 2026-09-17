import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readJson, writeJsonAtomic, isInside } from './core.mjs';

// Only explicit retries reuse a machine-stage prefix. External services are not cached.
export function integrationCheckpoint(p, fid, signature, resume) {
  const file = path.join(p.harness, 'runtime/integrations', `${fid}.progress.json`);
  const hash = crypto.createHash('sha256').update(signature).update(process.version).update(process.execPath);
  hash.update(JSON.stringify(Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b))));
  for (const name of ['queue.mjs', 'integration-cache.mjs', 'commands.mjs']) hash.update(fs.readFileSync(new URL(name, import.meta.url)));
  const key = hash.digest('hex'); // no environment values / credentials are persisted
  const old = resume ? readJson(file, null) : null;
  const age = Date.now() - old?.at;
  let eligible = old?.key === key && age >= 0 && age < 3600000 && Array.isArray(old.passed);
  const at = eligible ? old.at : Date.now();
  const passed = [];
  const save = () => writeJsonAtomic(file, { key, at, passed });
  save();
  return {
    reuse(stage, command, outputs) {
      const prev = eligible && old.passed[passed.length];
      eligible = !!prev && prev.stage === stage && prev.command === command
        && (stage !== 'build' || (!!outputs && outputs === prev.outputs));
      return eligible;
    },
    record(stage, command, outputs) { passed.push({ stage, command, ...(stage === 'build' ? { outputs } : {}) }); save(); },
    clear() { fs.rmSync(file, { force: true }); },
  };
}

// Missing/unreadable/empty outputs or symlinks cannot certify a previous build.
export function buildFingerprint(root, outputs) {
  if (!Array.isArray(outputs) || !outputs.length) return null;
  const hash = crypto.createHash('sha256');
  let files = 0;
  const visit = file => {
    if (!isInside(fs.realpathSync(file), fs.realpathSync(root))) throw new Error('outside checkout');
    const stat = fs.lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error('symlink');
    hash.update(JSON.stringify([path.relative(root, file), stat.mode]));
    if (stat.isDirectory()) for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name));
    else if (stat.isFile()) { hash.update(crypto.createHash('sha256').update(fs.readFileSync(file)).digest()); files++; }
    else throw new Error('not a regular file');
  };
  try { for (const output of [...outputs].sort()) visit(path.join(root, output)); } catch { return null; }
  return files ? hash.digest('hex') : null;
}
