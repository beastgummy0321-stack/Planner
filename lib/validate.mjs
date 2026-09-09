// Manifest (ARCHITECTURE.md frontmatter) and issue-file validation. Returns arrays of error strings.
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter, isInside } from './core.mjs';

export const STACKS = ['ts', 'python'];
export const RESOURCE_KINDS = ['supabase-table', 'drizzle-table', 'sqlalchemy-model', 'sql-table'];
export const REVIEW = ['none', 'planner'];
const ID_RE = /^F\d{2}-T\d{2}-I\d{2}$/;

export function readManifest(root) {
  const file = path.join(root, 'ARCHITECTURE.md');
  if (!fs.existsSync(file)) return { manifest: null, errors: ['ARCHITECTURE.md not found'] };
  return parseManifestText(root, fs.readFileSync(file, 'utf8'));
}
export function validateManifestFile(root, file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return [e.message]; }
  return parseManifestText(root, text).errors;
}
export function parseManifestText(root, text) {
  let fm;
  try { fm = parseFrontmatter(text); } catch (e) { return { manifest: null, errors: [e.message] }; }
  const m = fm.data;
  const errors = validateManifest(m, root);
  return { manifest: m, body: fm.body, errors };
}

export function validateManifest(m, root = null) {
  const e = [];
  if (!m || typeof m !== 'object') return ['manifest is not an object'];
  if (m.harness !== 1) e.push('harness must be 1');
  if (!STACKS.includes(m.stack)) e.push(`stack must be one of ${STACKS.join(', ')} (got ${JSON.stringify(m.stack)}); other stacks: unsupported architecture adapter`);
  const modules = m.modules && typeof m.modules === 'object' ? m.modules : null;
  if (!modules || !Object.keys(modules).length) e.push('modules must be a non-empty object');
  const names = modules ? Object.keys(modules) : [];
  const exists = (p) => !root || fs.existsSync(path.join(root, p));
  for (const [name, mod] of Object.entries(modules || {})) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) e.push(`module ${name}: name must be lower-case identifier`);
    if (!mod || typeof mod !== 'object') { e.push(`module ${name}: must be an object`); continue; }
    if (!mod.root) e.push(`module ${name}: root required`);
    else if (!exists(mod.root)) e.push(`module ${name}: root ${mod.root} does not exist`);
    if (!mod.public) e.push(`module ${name}: public entry required`);
    else {
      if (mod.root && !isInside(path.join(root || '/', mod.public), path.join(root || '/', mod.root))) e.push(`module ${name}: public ${mod.public} is outside root ${mod.root}`);
      if (!exists(mod.public)) e.push(`module ${name}: public ${mod.public} does not exist`);
    }
    if (!Array.isArray(mod.owns) || !mod.owns.length) e.push(`module ${name}: owns must be a non-empty list of globs`);
    if (!Array.isArray(mod.may_depend_on)) e.push(`module ${name}: may_depend_on must be a list`);
    else for (const d of mod.may_depend_on) {
      if (!names.includes(d)) e.push(`module ${name}: may_depend_on names unknown module ${d}`);
      if (d === name) e.push(`module ${name}: depends on itself`);
    }
  }
  if (modules) for (const c of cycles(modules)) e.push(`dependency cycle: ${c.join(' → ')}`);
  for (const [name, r] of Object.entries(m.resources || {})) {
    if (!r || typeof r !== 'object') { e.push(`resource ${name}: must be an object`); continue; }
    if (!names.includes(r.owner)) e.push(`resource ${name}: owner ${JSON.stringify(r.owner)} is not a module`);
    if (!RESOURCE_KINDS.includes(r.kind)) e.push(`resource ${name}: kind ${JSON.stringify(r.kind)} unsupported (${RESOURCE_KINDS.join(', ')}); unknown pattern = unsupported ownership adapter`);
    if (!Array.isArray(r.definition) || !r.definition.length) e.push(`resource ${name}: definition must list where the schema lives`);
    if (!r.symbol) e.push(`resource ${name}: symbol required (table name / model symbol the analyzer looks for)`);
  }
  if (!Array.isArray(m.app_shell)) e.push('app_shell must be a list of globs (may be empty)');
  if (!m.verify || typeof m.verify !== 'object') e.push('verify must be an object of named commands (test, typecheck, build)');
  if (!m.checker?.command) e.push('checker.command required (set by harness adapter apply)');
  return e;
}

function cycles(modules) {
  const out = [];
  const seen = new Set();
  for (const start of Object.keys(modules)) {
    const stack = [[start, [start]]];
    while (stack.length) {
      const [n, trail] = stack.pop();
      for (const d of modules[n]?.may_depend_on || []) {
        if (d === start) { const key = [...trail].sort().join(','); if (!seen.has(key)) { seen.add(key); out.push([...trail, d]); } }
        else if (!trail.includes(d) && modules[d]) stack.push([d, [...trail, d]]);
      }
    }
  }
  return out;
}

// ---------- issues ----------
export function validateIssueFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return [e.message]; }
  const errors = validateIssueText(text).errors;
  const base = path.basename(file, '.md');
  const { data } = safeParse(text);
  if (data?.id && data.id !== base) errors.push(`id ${data.id} does not match filename ${base}`);
  return errors;
}
function safeParse(text) { try { return parseFrontmatter(text); } catch { return {}; } }
export function validateIssueText(text) {
  let fm;
  try { fm = parseFrontmatter(text); } catch (e) { return { issue: null, errors: [e.message] }; }
  const d = fm.data, e = [];
  if (!ID_RE.test(d.id || '')) e.push('id must look like F01-T01-I01');
  if (d.id && (d.feature !== d.id.slice(0, 3) || d.ticket !== d.id.slice(4, 7))) e.push('feature/ticket must match the id');
  for (const k of ['after', 'touch', 'do_not_touch', 'verify', 'privileged']) if (!Array.isArray(d[k])) e.push(`${k} must be a list`);
  if (Array.isArray(d.touch) && !d.touch.length) e.push('touch must not be empty');
  if (Array.isArray(d.after)) for (const a of d.after) if (!ID_RE.test(a)) e.push(`after: bad id ${a}`);
  if (typeof d.interface_change !== 'boolean') e.push('interface_change must be true/false');
  if (!REVIEW.includes(d.review)) e.push(`review must be ${REVIEW.join(' | ')}`);
  if (d.interface_change === true && d.review !== 'planner') e.push('interface_change requires review: planner');
  const depFiles = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'pyproject.toml', 'uv.lock'];
  if (Array.isArray(d.touch) && d.touch.some((g) => depFiles.some((f) => path.posix.matchesGlob(f, g))) && d.review !== 'planner') e.push('touching dependency files requires review: planner');
  const body = fm.body;
  for (const h of ['# Objective', '# Done', '# Verify', '# Blocked if']) if (!body.includes(h)) e.push(`missing section ${h}`);
  if (Array.isArray(d.verify) && !d.verify.length && !/manual/i.test(body)) e.push('verify is empty: list runnable commands or state an explicit manual verification in # Verify');
  return { issue: d, body, errors: e };
}
