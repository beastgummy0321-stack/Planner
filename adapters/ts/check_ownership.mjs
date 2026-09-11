#!/usr/bin/env node
// Ownership analyzer for TS/JS projects, driven by the ARCHITECTURE.md manifest.
// Copied into the project by `harness adapter apply` (tools/check_ownership.mjs).
// A non-owner module must not access another module's resource:
//   supabase-table: .from("x") / .rpc("x") / .schema(..).from("x") literal call targets;
//                   a non-literal target (.from(table)) inside any managed module is UNKNOWN = red
//   drizzle-table:  importing the table symbol from one of its definition files (import/export binding)
//   sql-table:      the table name inside a string literal (raw SQL)
//   anything else:  skipped (no analyzer) — the planner reviews ownership by hand
// A bare local identifier that happens to share the name (const users = []) is not a violation.
// ponytail: regex on import statements, not a TS AST — aliased sources (@/db/schema) match by path tail;
// a re-export barrel outside `definition` is not followed. Upgrade to the TypeScript API if that bites.
// Exit code = number of violations. Prints path:line: message.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(process.argv[2] || '.');
const text = fs.readFileSync(path.join(ROOT, 'ARCHITECTURE.md'), 'utf8');
const fm = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
if (!fm) { console.error('ARCHITECTURE.md: missing frontmatter'); process.exit(1); }
const manifest = JSON.parse(fm[1]);
const SKIP = new Set(['.git', 'node_modules', 'dist', 'build', '.next', '.harness', '.claude', 'coverage']);

function* files(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (SKIP.has(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(p);
    else if (/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/.test(e.name)) yield p;
  }
}
const rel = (p) => path.relative(ROOT, p).replace(/\\/g, '/');
const matches = (p, globs = []) => globs.some((g) => path.posix.matchesGlob(p, g));
const moduleOf = (p) => Object.entries(manifest.modules).find(([, m]) => matches(p, m.owns) || p === m.root || p.startsWith(m.root.replace(/\/$/, '') + '/'))?.[0] ?? null;
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const lineOf = (src, idx) => src.slice(0, idx).split('\n').length;
const stripExt = (p) => p.replace(/\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/, '').replace(/\/index$/, '');

// does an import source, written in `file`, point at one of the resource's definition files?
function importsDefinition(file, source, definition = []) {
  const defs = definition.map(stripExt);
  if (source.startsWith('.')) {
    const resolved = stripExt(path.posix.normalize(path.posix.join(path.posix.dirname(file), source)));
    return matches(resolved, definition) || defs.includes(resolved) || defs.some((d) => matches(resolved + '.ts', [d + '.ts']) );
  }
  const tail = stripExt(source.replace(/^[@~]\/?/, '').replace(/^src\//, ''));
  return defs.some((d) => d === tail || d.endsWith('/' + tail));
}

const resources = Object.entries(manifest.resources || {});
const hasSupabase = resources.some(([, r]) => r.kind === 'supabase-table');
const violations = [];
for (const abs of files(ROOT)) {
  const p = rel(abs);
  const me = moduleOf(p);
  const src = fs.readFileSync(abs, 'utf8');
  const who = me || 'app shell';
  for (const [name, r] of resources) {
    if (me === r.owner) continue;
    const sym = esc(r.symbol);
    if (r.kind === 'supabase-table') {
      const pat = new RegExp(`\\.(?:from|rpc)\\(\\s*['"\`]${sym}['"\`]`, 'g');
      for (const m of src.matchAll(pat)) violations.push(`${p}:${lineOf(src, m.index)}: ${who} accesses resource ${name} owned by ${r.owner}`);
    } else if (r.kind === 'drizzle-table') {
      if (matches(p, r.definition || [])) continue;
      // import { users } from '../db/schema' | import { users as u } | export { users } from … | import * as schema from '<definition>'
      const named = new RegExp(`\\b(?:import|export)\\s+(?:type\\s+)?\\{[^}]*\\b${sym}\\b[^}]*\\}\\s*from\\s*['"]([^'"]+)['"]`, 'g');
      const star = /\bimport\s+\*\s+as\s+(\w+)\s+from\s*['"]([^'"]+)['"]/g;
      for (const m of src.matchAll(named)) if (importsDefinition(p, m[1], r.definition)) violations.push(`${p}:${lineOf(src, m.index)}: ${who} accesses resource ${name} owned by ${r.owner} (imports ${r.symbol} from ${m[1]})`);
      for (const m of src.matchAll(star)) if (importsDefinition(p, m[2], r.definition) && new RegExp(`\\b${m[1]}\\.${sym}\\b`).test(src)) violations.push(`${p}:${lineOf(src, m.index)}: ${who} accesses resource ${name} owned by ${r.owner} (via ${m[1]}.${r.symbol})`);
    } else if (r.kind === 'sql-table') {
      if (matches(p, r.definition || [])) continue;
      const pat = new RegExp(`['"\`][^'"\`\\n]*\\b${sym}\\b[^'"\`\\n]*['"\`]`, 'g');
      for (const m of src.matchAll(pat)) violations.push(`${p}:${lineOf(src, m.index)}: ${who} accesses resource ${name} owned by ${r.owner} (sql literal)`);
    } // any other kind: no analyzer for it — skipped, the planner reviews ownership by hand
  }
  // dynamic supabase target in managed code: the analyzer cannot tell whose table it is, so it is red, not silently green.
  // A capitalised receiver (Array.from, Buffer.from, Readable.from) is a static factory, not a client.
  if (hasSupabase && me) {
    const dyn = /(?<![A-Z]\w*)\.(from|rpc)\(\s*(?!['"`])[^)\s]/g;
    for (const m of src.matchAll(dyn)) violations.push(`${p}:${lineOf(src, m.index)}: ${who} calls .${m[1]}() with a non-literal target — ownership unknown; use a string literal`);
  }
}
for (const v of violations) console.log(v);
process.exit(Math.min(violations.length, 255));
