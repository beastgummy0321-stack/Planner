// Manifest (ARCHITECTURE.md frontmatter), feature-file and issue-file validation. Returns arrays of error strings.
import fs from 'node:fs';
import path from 'node:path';
import { parseFrontmatter, isInside } from './core.mjs';

export const ADAPTER_STACKS = ['ts', 'python'];          // stacks with a generated import checker; any other stack is legal, just uncheckered
export const RESOURCE_KINDS = ['supabase-table', 'drizzle-table', 'sqlalchemy-model', 'sql-table']; // kinds the ownership analyzers know; others are skipped
export const REVIEW = ['none', 'planner'];
export const FEATURE_ID_RE = /^F\d{2}$/;
export const ISSUE_ID_RE = /^F\d{2}-I\d{2}$/;

// ---------- manifest ----------
// ARCHITECTURE.md is optional: without it there is no module map and no checker, everything else still runs.
// opts.materialized: require every module root/public and legacy facade to exist on disk (the manifest is the
// desired topology, so existence is soft until `integrate feature`).
export function readManifest(root, opts = {}) {
  const file = path.join(root, 'ARCHITECTURE.md');
  if (!fs.existsSync(file)) return { manifest: null, body: '', errors: [] };
  return parseManifestText(root, fs.readFileSync(file, 'utf8'), opts);
}
export function validateManifestFile(root, file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return [e.message]; }
  return parseManifestText(root, text).errors;
}
export function parseManifestText(root, text, opts = {}) {
  let fm;
  try { fm = parseFrontmatter(text); } catch (e) { return { manifest: null, errors: [e.message] }; }
  const m = fm.data;
  const errors = validateManifest(m, root, opts);
  return { manifest: m, body: fm.body, errors };
}

export function validateManifest(m, root = null, { materialized = false } = {}) {
  const e = [];
  if (!m || typeof m !== 'object') return ['manifest is not an object'];
  if (typeof m.stack !== 'string' || !m.stack) e.push('stack must be a string (ts and python get a generated checker; any other stack runs without one)');
  const modules = m.modules && typeof m.modules === 'object' ? m.modules : null;
  if (!modules || !Object.keys(modules).length) e.push('modules must be a non-empty object');
  const names = modules ? Object.keys(modules) : [];
  const exists = (p) => !root || !materialized || fs.existsSync(path.join(root, p));
  for (const [name, mod] of Object.entries(modules || {})) {
    if (!/^[a-z][a-z0-9_-]*$/.test(name)) e.push(`module ${name}: name must be lower-case identifier`);
    if (!mod || typeof mod !== 'object') { e.push(`module ${name}: must be an object`); continue; }
    if (!mod.root) e.push(`module ${name}: root required`);
    else if (!exists(mod.root)) e.push(`module ${name}: root ${mod.root} does not exist (not materialized)`);
    if (!mod.public) e.push(`module ${name}: public entry required`);
    else {
      if (mod.root && !isInside(path.join(root || '/', mod.public), path.join(root || '/', mod.root))) e.push(`module ${name}: public ${mod.public} is outside root ${mod.root}`);
      if (!exists(mod.public)) e.push(`module ${name}: public ${mod.public} does not exist (not materialized)`);
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
    if (typeof r.kind !== 'string') e.push(`resource ${name}: kind must be a string (${RESOURCE_KINDS.join(', ')} are analyzed; any other kind is planner-reviewed by hand)`);
    if (!Array.isArray(r.definition) || !r.definition.length) e.push(`resource ${name}: definition must list where the schema lives`);
    if (!r.symbol) e.push(`resource ${name}: symbol required (table name / model symbol)`);
  }
  if (!Array.isArray(m.app_shell)) e.push('app_shell must be a list of globs (may be empty)');
  if (!m.verify || typeof m.verify !== 'object') e.push('verify must be an object of named commands (test, typecheck, build, smoke)');
  for (const k of ['test', 'typecheck', 'build', 'smoke']) if (m.verify && m.verify[k] !== undefined && typeof m.verify[k] !== 'string') e.push(`verify.${k} must be a command string`);
  if (m.checker !== undefined && !m.checker?.command) e.push('checker.command must be a command string when checker is present');
  // managed / legacy surface: legacy code may exist and shrink, never grow; managed code reaches it only through facades
  if (m.legacy !== undefined && !Array.isArray(m.legacy)) e.push('legacy must be a list of globs');
  if (m.legacy_facades !== undefined && !Array.isArray(m.legacy_facades)) e.push('legacy_facades must be a list of file paths');
  for (const f of m.legacy_facades || []) {
    if (!(m.legacy || []).some((g) => path.posix.matchesGlob(f, g))) e.push(`legacy facade ${f} is not inside a legacy glob`);
    if (!exists(f)) e.push(`legacy facade ${f} does not exist`);
  }
  for (const [name, mod] of Object.entries(modules || {})) {
    if (mod?.root && (m.legacy || []).some((g) => path.posix.matchesGlob(mod.root + '/x', g))) e.push(`module ${name}: root ${mod.root} lies inside a legacy glob; a module is managed, legacy is not`);
  }
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

// ---------- features (.work/features/F01.md) ----------
// The feature is the integration boundary: one branch, its issues, its acceptance contract, its decisions.
export function validateFeatureText(text) {
  let fm;
  try { fm = parseFrontmatter(text); } catch (e) { return { feature: null, errors: [e.message] }; }
  const d = fm.data, e = [];
  if (!FEATURE_ID_RE.test(d.id || '')) e.push('id must look like F01');
  if (!d.title) e.push('title required');
  for (const k of ['branch', 'base']) if (d[k] !== undefined && typeof d[k] !== 'string') e.push(`${k} must be a string`);
  for (const k of ['verify', 'runtime', 'human']) if (d[k] !== undefined && !Array.isArray(d[k])) e.push(`${k} must be a list`);
  if (typeof d.closed !== 'boolean') e.push('closed must be true/false');
  for (const h of ['# Outcome', '# Decisions']) if (!fm.body.includes(h)) e.push(`missing section ${h}`);
  return { feature: d, body: fm.body, errors: e };
}
export function validateFeatureFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return [e.message]; }
  const { feature, errors } = validateFeatureText(text);
  const base = path.basename(file, '.md');
  if (feature?.id && feature.id !== base) errors.push(`id ${feature.id} does not match filename ${base}`);
  return errors;
}

// ---------- issues (.work/{ready,doing,blocked,done}/F01-I01.md) ----------
export function validateIssueFile(file, root = null) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return [e.message]; }
  const ctx = root ? { manifest: readManifest(root).manifest } : {};
  const errors = validateIssueText(text, ctx).errors;
  const base = path.basename(file, '.md');
  const { data } = safeParse(text);
  if (data?.id && data.id !== base) errors.push(`id ${data.id} does not match filename ${base}`);
  return errors;
}
function safeParse(text) { try { return parseFrontmatter(text); } catch { return {}; } }
export function validateIssueText(text, ctx = {}) {
  let fm;
  try { fm = parseFrontmatter(text); } catch (e) { return { issue: null, errors: [e.message] }; }
  const d = fm.data, e = [];
  if (!ISSUE_ID_RE.test(d.id || '')) e.push('id must look like F01-I01');
  if (d.id && d.feature !== d.id.slice(0, 3)) e.push('feature must match the id');
  for (const k of ['after', 'touch', 'do_not_touch', 'verify', 'privileged']) if (!Array.isArray(d[k])) e.push(`${k} must be a list`);
  if (Array.isArray(d.touch) && !d.touch.length) e.push('touch must not be empty');
  if (Array.isArray(d.after)) for (const a of d.after) if (!ISSUE_ID_RE.test(a)) e.push(`after: bad id ${a}`);
  if (typeof d.interface_change !== 'boolean') e.push('interface_change must be true/false');
  if (!REVIEW.includes(d.review)) e.push(`review must be ${REVIEW.join(' | ')}`);
  if (d.interface_change === true && d.review !== 'planner') e.push('interface_change requires review: planner');
  if (d.group !== undefined && typeof d.group !== 'string') e.push('group must be a string');
  if (d.deps !== undefined && !Array.isArray(d.deps)) e.push('deps must be a list of package names');
  // legacy surface: new capability never grows into legacy; only a declared migration touches it, and the planner reviews it
  const legacy = ctx.manifest?.legacy || [];
  const pfx = (x) => x.split(/[*?[{]/)[0];
  const touchesLegacy = Array.isArray(d.touch) && d.touch.some((g) => legacy.some((l) => pfx(g).startsWith(pfx(l)) || pfx(l).startsWith(pfx(g))));
  if (d.legacy_migration !== undefined && typeof d.legacy_migration !== 'boolean') e.push('legacy_migration must be true/false');
  if (touchesLegacy && d.legacy_migration !== true) e.push('touch reaches a legacy path: only an issue with legacy_migration: true may (build a facade or move callers), never new capability');
  if (d.legacy_migration === true && d.review !== 'planner') e.push('legacy_migration requires review: planner');
  // dependency files: serialised by the scheduler and planner-reviewed; `deps` names what is added
  const depFiles = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'pyproject.toml', 'uv.lock'];
  const touchesDeps = Array.isArray(d.touch) && d.touch.some((g) => depFiles.some((f) => path.posix.matchesGlob(f, g)));
  if (touchesDeps && d.review !== 'planner') e.push('touching dependency files requires review: planner');
  if (touchesDeps && !(Array.isArray(d.deps) && d.deps.length)) e.push('touching dependency files requires deps: [<package>…] naming what is added');
  const body = fm.body;
  for (const h of ['# Objective', '# Done', '# Verify', '# Blocked if']) if (!body.includes(h)) e.push(`missing section ${h}`);
  if (Array.isArray(d.verify) && !d.verify.length && !/manual/i.test(body)) e.push('verify is empty: list runnable commands or state an explicit manual verification in # Verify');
  return { issue: d, body, errors: e };
}
