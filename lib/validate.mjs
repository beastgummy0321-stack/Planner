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
  if (!m.verify || typeof m.verify !== 'object') e.push('verify must be an object of named commands (test, typecheck, build, smoke)');
  for (const k of ['test', 'typecheck', 'build', 'smoke']) if (m.verify && m.verify[k] !== undefined && typeof m.verify[k] !== 'string') e.push(`verify.${k} must be a command string`);
  if (!m.checker?.command) e.push('checker.command required (set by harness adapter apply)');
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

export function isLegacyPath(m, p) {
  return (m?.legacy || []).some((g) => path.posix.matchesGlob(p, g));
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

// ---------- tickets ----------
const TICKET_ID_RE = /^F\d{2}-T\d{2}$/;
export function validateTicketText(text) {
  let fm;
  try { fm = parseFrontmatter(text); } catch (e) { return { ticket: null, errors: [e.message] }; }
  const d = fm.data, e = [];
  if (!TICKET_ID_RE.test(d.id || '')) e.push('id must look like F01-T01');
  if (d.id && d.feature !== d.id.slice(0, 3)) e.push('feature must match the id');
  if (!d.title) e.push('title required');
  for (const k of ['verify', 'runtime', 'human', 'deps_approved']) if (d[k] !== undefined && !Array.isArray(d[k])) e.push(`${k} must be a list`);
  if (!Array.isArray(d.verify)) e.push('verify must be a list of machine commands (may be empty)');
  if (typeof d.closed !== 'boolean') e.push('closed must be true/false');
  const body = fm.body;
  for (const h of ['# Outcome', '# Acceptance']) if (!body.includes(h)) e.push(`missing section ${h}`);
  return { ticket: d, body, errors: e };
}
export function validateTicketFile(file) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return [e.message]; }
  const { ticket, errors } = validateTicketText(text);
  const base = path.basename(file, '.md');
  if (ticket?.id && ticket.id !== base) errors.push(`id ${ticket.id} does not match filename ${base}`);
  return errors;
}

// ---------- issues ----------
// root (optional) enables the cross-file checks: legacy surface from the manifest, dependency approval from the ticket.
export function validateIssueFile(file, root = null) {
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) { return [e.message]; }
  const ctx = {};
  if (root) {
    ctx.manifest = readManifest(root).manifest;
    const { data } = safeParse(text);
    const tf = data?.id ? path.join(root, '.work', 'tickets', `${data.id.slice(0, 7)}.md`) : null;
    if (tf && fs.existsSync(tf)) ctx.ticket = safeParse(fs.readFileSync(tf, 'utf8')).data;
  }
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
  // legacy surface: new capability never grows into legacy; only a declared migration touches it, and the planner reviews it
  const legacy = ctx.manifest?.legacy || [];
  const touchesLegacy = Array.isArray(d.touch) && d.touch.some((g) => legacy.some((l) => { const p = (x) => x.split(/[*?[{]/)[0]; return p(g).startsWith(p(l)) || p(l).startsWith(p(g)); }));
  if (d.legacy_migration !== undefined && typeof d.legacy_migration !== 'boolean') e.push('legacy_migration must be true/false');
  if (touchesLegacy && d.legacy_migration !== true) e.push('touch reaches a legacy path: only an issue with legacy_migration: true may (build a facade or move callers), never new capability');
  if (d.legacy_migration === true && d.review !== 'planner') e.push('legacy_migration requires review: planner');
  // dependency approval: a new package enters only through a ticket the user approved
  if (d.deps !== undefined && !Array.isArray(d.deps)) e.push('deps must be a list of package names');
  if (ctx.ticket && Array.isArray(d.deps) && d.deps.length) {
    const approved = ctx.ticket.deps_approved || [];
    for (const dep of d.deps) if (!approved.includes(dep)) e.push(`dependency ${dep} is not in the ticket's deps_approved (the user approves new packages once, in /carve)`);
  }
  if (!ID_RE.test(d.id || '')) e.push('id must look like F01-T01-I01');
  if (d.id && (d.feature !== d.id.slice(0, 3) || d.ticket !== d.id.slice(4, 7))) e.push('feature/ticket must match the id');
  for (const k of ['after', 'touch', 'do_not_touch', 'verify', 'privileged']) if (!Array.isArray(d[k])) e.push(`${k} must be a list`);
  if (Array.isArray(d.touch) && !d.touch.length) e.push('touch must not be empty');
  if (Array.isArray(d.after)) for (const a of d.after) if (!ID_RE.test(a)) e.push(`after: bad id ${a}`);
  if (typeof d.interface_change !== 'boolean') e.push('interface_change must be true/false');
  if (!REVIEW.includes(d.review)) e.push(`review must be ${REVIEW.join(' | ')}`);
  if (d.interface_change === true && d.review !== 'planner') e.push('interface_change requires review: planner');
  const depFiles = ['package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'pyproject.toml', 'uv.lock'];
  const touchesDeps = Array.isArray(d.touch) && d.touch.some((g) => depFiles.some((f) => path.posix.matchesGlob(f, g)));
  if (touchesDeps && d.review !== 'planner') e.push('touching dependency files requires review: planner');
  if (touchesDeps && !(Array.isArray(d.deps) && d.deps.length)) e.push('touching dependency files requires deps: [<package>…] naming what is added (reuse gate: repo → skills → platform → installed dep → package → custom)');
  const body = fm.body;
  for (const h of ['# Objective', '# Done', '# Verify', '# Blocked if']) if (!body.includes(h)) e.push(`missing section ${h}`);
  if (Array.isArray(d.verify) && !d.verify.length && !/manual/i.test(body)) e.push('verify is empty: list runnable commands or state an explicit manual verification in # Verify');
  return { issue: d, body, errors: e };
}
