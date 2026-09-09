#!/usr/bin/env node
// Ownership analyzer for TS/JS projects, driven by the ARCHITECTURE.md manifest.
// Copied into the project by `harness adapter apply` (tools/check_ownership.mjs).
// A non-owner module must not access another module's resource:
//   supabase-table: .from("x") / .rpc("x") / .schema(..).from("x") call targets
//   drizzle-table / sql-table: import or use of the table symbol outside the owner and its definition files
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

const violations = [];
for (const abs of files(ROOT)) {
  const p = rel(abs);
  const me = moduleOf(p);
  const src = fs.readFileSync(abs, 'utf8');
  const lines = src.split(/\r?\n/);
  for (const [name, r] of Object.entries(manifest.resources || {})) {
    if (me === r.owner) continue;
    const sym = r.symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let pat;
    if (r.kind === 'supabase-table') pat = new RegExp(`\\.(?:from|rpc)\\(\\s*['"\`]${sym}['"\`]`);
    else if (r.kind === 'drizzle-table' || r.kind === 'sql-table') {
      if (matches(p, r.definition || [])) continue;
      pat = new RegExp(`(?<![\\w.$])${sym}(?![\\w$])`);
    } else { violations.push(`ARCHITECTURE.md:0: resource ${name}: unsupported ownership adapter for kind ${r.kind}`); continue; }
    lines.forEach((line, i) => {
      if (pat.test(line)) violations.push(`${p}:${i + 1}: ${me || 'app shell'} accesses resource ${name} owned by ${r.owner}`);
    });
  }
}
for (const v of violations) console.log(v);
process.exit(Math.min(violations.length, 255));
