import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { parseFrontmatter, readJson, writeJsonAtomic } from './core.mjs';
function file(p, id) {
  if (!/^F\d{2}$/.test(id || '')) throw new Error('invalid feature id');
  return path.join(p.harness, 'runtime', 'authorizations', id + '.json');
}
function scopeKey(p, id) {
  const f = parseFrontmatter(fs.readFileSync(path.join(p.root, '.work/features', id + '.md'), 'utf8'));
  const outcome = (f.body.match(/^# Outcome\s*\n([\s\S]*?)(?=^# |$(?![\r\n]))/m) || [])[1] || '';
  return crypto.createHash('sha256').update(JSON.stringify([f.data.id, f.data.branch || '', outcome.trim()])).digest('hex');
}
export function authorize(p, id, instruction) {
  if (!instruction?.trim()) throw new Error('record the actual user instruction and authorized scope');
  const receipt = { scope: scopeKey(p, id), instruction, at: Date.now() };
  writeJsonAtomic(file(p, id), receipt); return receipt;
}
export function revoke(p, id) { fs.rmSync(file(p, id), { force: true }); }
export function requireAuthorization(p, id) {
  const r = readJson(file(p, id), null);
  if (!r || r.scope !== scopeKey(p, id)) throw new Error(`${id}: execution authorization missing or outcome changed; record existing user permission with authorize, or ask only if permission is absent`);
  return r;
}
