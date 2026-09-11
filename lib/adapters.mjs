// Stack adapters: generate the container checker for the project, install it (after approval), run it, prove it red.
// Stacks with an adapter: ts (dependency-cruiser + ownership script), python (shipped AST checker).
// Any other stack: no generated checker — a capability the project lacks, never a reason to stop planning.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readManifest } from './validate.mjs';
import { stringifyFrontmatter, writeLease } from './core.mjs';

const PLUGIN = path.resolve(import.meta.dirname, '..');

export function detectStack(root) {
  if (fs.existsSync(path.join(root, 'package.json'))) return 'ts';
  if (fs.existsSync(path.join(root, 'pyproject.toml')) || fs.existsSync(path.join(root, 'requirements.txt'))) return 'python';
  return null;
}
export function packageManager(root) {
  if (fs.existsSync(path.join(root, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(root, 'yarn.lock'))) return 'yarn';
  return 'npm';
}
// Yarn Berry (2+) keeps .yarnrc.yml and takes --immutable; Yarn Classic (1) takes --frozen-lockfile and rejects --immutable.
const yarnBerry = (root) => fs.existsSync(path.join(root, '.yarnrc.yml'));
function pythonRunner(root) {
  return fs.existsSync(path.join(root, 'uv.lock')) ? 'uv run python' : 'python';
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
function* files(dir) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['.git', 'node_modules', 'dist', 'build', '.next', '.harness', '.claude'].includes(e.name)) continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) yield* files(p); else yield p;
  }
}

// ---------- plan: what apply would do ----------
export function planAdapter(root) {
  const { manifest, errors } = readManifest(root);
  if (!manifest) throw new Error('no ARCHITECTURE.md: nothing to wire a checker for');
  if (errors.length) throw new Error(`ARCHITECTURE.md invalid:\n  ${errors.join('\n  ')}`);
  const stack = manifest.stack;
  const plan = stack === 'ts' ? planTs(root, manifest) : stack === 'python' ? planPython(root, manifest) : null;
  if (!plan) return { stack, unsupported: true, install: [], add: [], modify: [], checker: null };
  plan.unchanged = isApplied(root, manifest, plan);
  return plan;
}
// Already wired: nothing to install, every generated file is byte-identical on disk, the checker command is recorded.
// Then /carve runs `adapter check` only — no approval prompt, no re-apply, no re-prove.
function isApplied(root, m, plan) {
  if (plan.install.length || m.checker?.command !== plan.checker) return false;
  for (const [f, content] of Object.entries(plan.files)) {
    try { if (fs.readFileSync(path.join(root, f), 'utf8') !== content) return false; } catch { return false; }
  }
  if (plan.stack === 'ts') {
    try { if (JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).scripts?.[plan.scriptName] !== plan.script) return false; } catch { return false; }
  }
  return true;
}

function planTs(root, m) {
  const pm = packageManager(root);
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const has = (d) => !!(pkg.devDependencies?.[d] || pkg.dependencies?.[d]);
  const hasTs = fs.existsSync(path.join(root, 'tsconfig.json')) || [...files(root)].some((f) => /\.tsx?$/.test(f));
  // dependency-cruiser 18 parses TypeScript through the typescript package, supported range >=2 <7.
  let tsVersion = null;
  try { tsVersion = JSON.parse(fs.readFileSync(path.join(root, 'node_modules/typescript/package.json'), 'utf8')).version; } catch {}
  if (tsVersion && Number(tsVersion.split('.')[0]) >= 7) throw new Error(`unsupported architecture adapter: dependency-cruiser needs typescript <7, project has ${tsVersion}`);
  const missing = [...(!has('dependency-cruiser') ? ['dependency-cruiser'] : []), ...(hasTs && !has('typescript') ? ['typescript@^6'] : [])];
  const roots = scanRoots(m);
  const run = pm === 'npm' ? 'npm run' : `${pm} run`;
  const script = `depcruise --config .dependency-cruiser.cjs ${roots.join(' ')} && node tools/check_ownership.mjs`;
  // an existing check:architecture is composed with, never overwritten: ours lands under its own name and the checker runs both
  const existing = pkg.scripts?.['check:architecture'];
  const compose = !!existing && existing !== script;
  const scriptName = compose ? 'check:architecture:harness' : 'check:architecture';
  return {
    stack: 'ts',
    install: missing.length ? [`${pm} ${pm === 'yarn' ? 'add -D' : 'install -D'} ${missing.join(' ')}`] : [],
    add: ['.dependency-cruiser.cjs', 'tools/check_ownership.mjs'],
    modify: [`package.json (scripts.${scriptName})`, 'ARCHITECTURE.md (checker.command)'],
    checker: compose ? `${run} check:architecture && ${run} ${scriptName}` : `${run} ${scriptName}`,
    script, scriptName,
    files: { '.dependency-cruiser.cjs': depcruiseConfig(root, m), 'tools/check_ownership.mjs': fs.readFileSync(path.join(PLUGIN, 'adapters/ts/check_ownership.mjs'), 'utf8') },
    reuse: compose ? `existing check:architecture kept (${existing}); harness rules run after it as ${scriptName}` : null,
  };
}
function planPython(root, m) {
  return {
    stack: 'python',
    install: [],
    add: ['tools/check_architecture.py'],
    modify: ['ARCHITECTURE.md (checker.command)'],
    checker: `${pythonRunner(root)} tools/check_architecture.py`,
    files: { 'tools/check_architecture.py': fs.readFileSync(path.join(PLUGIN, 'adapters/python/check_architecture.py'), 'utf8') },
    reuse: fs.existsSync(path.join(root, '.importlinter')) ? 'existing .importlinter kept; harness rules run alongside it' : null,
  };
}
function scanRoots(m) {
  const tops = new Set();
  for (const mod of Object.values(m.modules)) tops.add(mod.root.split('/')[0]);
  for (const g of m.app_shell || []) tops.add(g.split('/')[0].replace(/\*.*$/, '') || '.');
  return [...tops].filter(Boolean);
}

export function depcruiseConfig(root, m) {
  const names = Object.keys(m.modules);
  const rules = [
    { name: 'no-circular', severity: 'error', comment: 'harness: no dependency cycles', from: {}, to: { circular: true } },
  ];
  if (m.app_shell?.length) {
    const shell = m.app_shell.map((g) => '^' + esc(g.replace(/\/\*\*$/, '')) + '/').join('|');
    rules.push({ name: 'no-app-shell', severity: 'error', comment: 'harness: modules never import the app shell',
      from: { path: names.map((n) => '^' + esc(m.modules[n].root) + '/').join('|') }, to: { path: shell } });
  }
  for (const n of names) {
    const mod = m.modules[n];
    const rootRe = '^' + esc(mod.root) + '/';
    rules.push({ name: `${n}-public-entry-only`, severity: 'error', comment: `harness: ${n} is reached only through ${mod.public}`,
      from: { pathNot: rootRe }, to: { path: rootRe, pathNot: '^' + esc(mod.public) + '$' } });
    const forbidden = names.filter((o) => o !== n && !(mod.may_depend_on || []).includes(o));
    if (forbidden.length) rules.push({ name: `${n}-may-depend-on`, severity: 'error', comment: `harness: ${n} may depend only on [${(mod.may_depend_on || []).join(', ')}]`,
      from: { path: rootRe }, to: { path: forbidden.map((o) => '^' + esc(m.modules[o].root) + '/').join('|') } });
  }
  // closed world: a module reaches local code only inside a declared module root (its own, or another's public entry —
  // enforced above) or a legacy facade. An unclassified src/shared|lib|utils file is the side door that recouples every module.
  const classified = [...names.map((n) => '^' + esc(m.modules[n].root) + '/'), ...(m.legacy_facades || []).map((f) => '^' + esc(f) + '$')];
  rules.push({ name: 'closed-world-local', severity: 'error', comment: 'harness: local imports must target a declared module (or legacy facade); classify the file in ARCHITECTURE.md',
    from: { path: names.map((n) => '^' + esc(m.modules[n].root) + '/').join('|') },
    to: { pathNot: classified.join('|'), dependencyTypesNot: ['core', 'npm', 'npm-dev', 'npm-optional', 'npm-peer', 'npm-bundled', 'npm-no-pkg', 'npm-unknown', 'unknown', 'undetermined'] } });
  if (m.legacy?.length) {
    // managed code never grows a new dependency on legacy internals; a declared facade is the only door
    const legacyRe = m.legacy.map((g) => '^' + esc(g.replace(/\/\*\*$/, '')) + '/').join('|');
    const facades = (m.legacy_facades || []).map((f) => '^' + esc(f) + '$').join('|');
    rules.push({ name: 'managed-no-legacy-internals', severity: 'error', comment: 'harness: managed modules reach legacy only through legacy_facades',
      from: { path: names.map((n) => '^' + esc(m.modules[n].root) + '/').join('|') }, to: { path: legacyRe, ...(facades ? { pathNot: facades } : {}) } });
  }
  const options = { doNotFollow: { path: 'node_modules' }, exclude: { path: '(^|/)(node_modules|dist|build|\\.next|\\.harness|\\.claude)/' } };
  if (fs.existsSync(path.join(root, 'tsconfig.json'))) { options.tsConfig = { fileName: 'tsconfig.json' }; options.tsPreCompilationDeps = true; }
  return `// Generated by harness from ARCHITECTURE.md — regenerate with \`harness adapter apply\`, do not hand-edit.\nmodule.exports = ${JSON.stringify({ forbidden: rules, options }, null, 2)};\n`;
}

// ---------- apply ----------
export function applyAdapter(project) {
  const root = project.root;
  const plan = planAdapter(root);
  if (plan.unsupported) throw new Error(`no checker adapter for stack ${plan.stack}: nothing to apply`);
  for (const [f, content] of Object.entries(plan.files)) {
    fs.mkdirSync(path.dirname(path.join(root, f)), { recursive: true });
    fs.writeFileSync(path.join(root, f), content);
  }
  for (const cmd of plan.install) {
    const r = spawnSync(cmd, { cwd: root, shell: true, stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`install failed: ${cmd}`);
  }
  if (plan.stack === 'ts') {
    const pkgFile = path.join(root, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'));
    pkg.scripts = { ...(pkg.scripts || {}), [plan.scriptName]: plan.script };
    fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n');
  }
  const { manifest, body } = readManifest(root);
  manifest.checker = { command: plan.checker };
  fs.writeFileSync(path.join(root, 'ARCHITECTURE.md'), stringifyFrontmatter(manifest, body));
  return plan;
}

// ---------- check / prove ----------
export function runChecker(root) {
  const { manifest, errors } = readManifest(root);
  if (errors.length) return { ok: false, output: `ARCHITECTURE.md invalid:\n${errors.join('\n')}` };
  // no manifest, or a stack without an adapter: the architecture container is off; scope, verify and typecheck/build still run
  if (!manifest) return { ok: true, code: 0, skipped: 'no ARCHITECTURE.md', output: 'skipped: no ARCHITECTURE.md (architecture checks off)' };
  if (!manifest.checker?.command) return { ok: true, code: 0, skipped: 'no checker', output: `skipped: no checker wired for stack ${manifest.stack} (harness adapter plan wires one for ts/python; otherwise the planner reviews boundaries by hand)` };
  // greenfield: no declared module root exists yet, so there is nothing to inspect; the first merge that creates one runs the real check
  if (!Object.values(manifest.modules).some((mod) => fs.existsSync(path.join(root, mod.root)))) {
    return { ok: true, code: 0, greenfield: true, output: 'greenfield: no module root exists yet; the checker runs from the first merge that creates one', command: manifest.checker.command };
  }
  const r = spawnSync(manifest.checker.command, { cwd: root, shell: true, encoding: 'utf8' });
  const output = (r.stdout || '') + (r.stderr || '');
  // A checker that inspected nothing is not green — that is the silent downgrade the spec forbids.
  if (r.status === 0 && /\(0 modules, 0 dependencies cruised\)|missing-typescript-transpiler/.test(output)) {
    return { ok: false, code: 1, output: 'checker inspected 0 modules (transpiler missing or wrong scan roots) — not green:\n' + output, command: manifest.checker.command };
  }
  return { ok: r.status === 0, code: r.status, output, command: manifest.checker.command };
}

export function proveChecker(root) {
  const { manifest } = readManifest(root);
  const names = Object.keys(manifest.modules);
  const green = runChecker(root);
  if (!green.ok) return { ok: false, step: 'baseline', output: green.output };
  const ext = manifest.stack === 'ts' ? 'ts' : 'py';
  const results = [];
  const probes = [];
  const cleanup = () => { for (const f of probes) { try { fs.unlinkSync(f); } catch {} } probes.length = 0; };
  const write = (relFile, content) => { const f = path.join(root, relFile); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); probes.push(f); };
  const importLine = (fromFile, toFile, sym) => {
    if (ext === 'ts') { let relp = path.posix.relative(path.posix.dirname(fromFile), toFile).replace(/\.ts$/, ''); if (!relp.startsWith('.')) relp = './' + relp; return `import { ${sym} } from '${relp}';\nexport const use = ${sym};\n`; }
    const mod = toFile.replace(/\.py$/, '').replace(/\/__init__$/, '').replace(/\//g, '.');
    return `from ${mod} import ${sym}\n`;
  };
  try {
    if (names.length >= 2) {
      const [a, b] = names;
      const internal = `${manifest.modules[b].root}/__harness_probe_internal.${ext}`;
      const probe = `${manifest.modules[a].root}/__harness_probe.${ext}`;
      write(internal, ext === 'ts' ? 'export const probe = 1;\n' : 'probe = 1\n');
      write(probe, importLine(probe, internal, 'probe'));
      const r = runChecker(root);
      results.push({ scenario: 'deep import of another module internals', red: !r.ok, output: r.output.trim() });
      cleanup();
    } else results.push({ scenario: 'deep import', skipped: 'needs two modules' });
    for (const [rname, res] of Object.entries(manifest.resources || {})) {
      const nonOwner = names.find((n) => n !== res.owner);
      if (!nonOwner) break;
      const probe = `${manifest.modules[nonOwner].root}/__harness_probe_owner.${ext}`;
      const def = (res.definition || []).find((d) => !/[*?[{]/.test(d));
      if (res.kind !== 'supabase-table' && res.kind !== 'sql-table' && !def) { results.push({ scenario: `non-owner touches resource ${rname}`, skipped: 'definition is a glob; the import-binding probe needs a file' }); break; }
      const body = res.kind === 'supabase-table'
        ? (ext === 'ts' ? `export const q = (c) => c.from('${res.symbol}').select();\n` : `def q(c):\n    return c.table('${res.symbol}').select('*')\n`)
        : res.kind === 'sql-table'
          ? (ext === 'ts' ? `export const q = 'select * from ${res.symbol}';\n` : `q = 'select * from ${res.symbol}'\n`)
          : importLine(probe, def, res.symbol);
      write(probe, body);
      const r = runChecker(root);
      results.push({ scenario: `non-owner touches resource ${rname}`, red: !r.ok, output: r.output.trim() });
      cleanup();
      break; // one resource proves the analyzer
    }
  } finally { cleanup(); }
  const after = runChecker(root);
  const ok = results.every((r) => r.skipped || r.red) && after.ok;
  return { ok, results, restored_green: after.ok };
}

// ---------- environment adapter (run inside a worktree) ----------
function jsInstall(dir, notes, where) {
  const pm = packageManager(dir);
  if (pm === 'pnpm') return ['pnpm install --frozen-lockfile'];
  if (pm === 'yarn') return [yarnBerry(dir) ? 'yarn install --immutable' : 'yarn install --frozen-lockfile'];
  if (fs.existsSync(path.join(dir, 'package-lock.json'))) return ['npm ci'];
  notes.push(`no lockfile${where ? ` in ${where}` : ''}: install is not reproducible; commit package-lock.json`);
  return ['npm install --no-package-lock']; // env setup never dirties the tree
}
// A backend stack with a JS app in a subdirectory still needs that app's dependencies: the project's own
// verify commands (`cd frontend && npx tsc`) run inside the worktree, and an npx that finds no local binary
// installs a stranger from the registry instead of failing. Own lockfile = own app; a workspace package
// carries no lockfile of its own and is already covered by the root install.
function jsSubprojects(wt) {
  let entries = [];
  try { entries = fs.readdirSync(wt, { withFileTypes: true }); } catch { return []; }
  return entries.filter((e) => e.isDirectory() && !e.name.startsWith('.') && e.name !== 'node_modules'
    && fs.existsSync(path.join(wt, e.name, 'package.json'))
    && ['package-lock.json', 'pnpm-lock.yaml', 'yarn.lock'].some((l) => fs.existsSync(path.join(wt, e.name, l))))
    .map((e) => e.name);
}
export function envCommands(wt, stack) {
  const cmds = [], notes = [];
  if (stack === 'ts') cmds.push(...jsInstall(wt, notes));
  else if (stack === 'python') {
    if (fs.existsSync(path.join(wt, 'uv.lock'))) cmds.push('uv sync --frozen');
    else notes.push('no uv.lock: no environment setup; the verify commands must work in the ambient interpreter');
  }
  for (const d of jsSubprojects(wt)) cmds.push(...jsInstall(path.join(wt, d), notes, d).map((c) => `cd ${d} && ${c}`));
  return { cmds, notes };
}
export function setupEnv(wt, stack) {
  const { cmds, notes } = envCommands(wt, stack);
  const log = notes.map((n) => ({ note: n }));
  for (const c of cmds) {
    const r = spawnSync(c, { cwd: wt, shell: true, encoding: 'utf8' });
    log.push({ command: c, code: r.status, tail: ((r.stdout || '') + (r.stderr || '')).split('\n').slice(-5).join('\n') });
    if (r.status !== 0) return { ok: false, log };
  }
  return { ok: true, log };
}

// Lazy provisioning: a worktree starts cold; the dependency install runs once, the first time a command needs a runtime.
// ponytail: token regex, not a resolver — a verify command wrapped in a shell script counts as no-runtime; list the real command in verify instead.
const RUNTIME = /^\s*(npm|npx|pnpm|yarn|node|tsc|vitest|jest|playwright|uv|python|python3|pytest)\b/i;
export function needsRuntime(cmd) { return RUNTIME.test(String(cmd || '')); }
export function ensureEnv(project, lease) {
  if (!lease?.worktree) return { ok: false, log: [{ note: 'no worktree attached' }] };
  if (lease.env_ready) return { ok: true, log: [], cached: true };
  const { manifest } = readManifest(project.root);
  const r = setupEnv(lease.worktree, manifest?.stack || detectStack(lease.worktree));
  if (r.ok) { lease.env_ready = true; writeLease(project, lease); }
  return r;
}
