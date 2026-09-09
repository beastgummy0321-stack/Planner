// Stack adapters: generate the container checker for the project, install it (after approval), run it, prove it red.
// v1 stacks: ts (dependency-cruiser + ownership script), python (shipped AST checker). Anything else = unsupported.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readManifest } from './validate.mjs';
import { stringifyFrontmatter, readState, writeState } from './core.mjs';

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
function pythonRunner(root) {
  return fs.existsSync(path.join(root, 'uv.lock')) ? 'uv run python' : 'python';
}
const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- plan: what apply would do ----------
export function planAdapter(root) {
  const { manifest, errors } = readManifest(root);
  if (errors.length) throw new Error(`ARCHITECTURE.md invalid:\n  ${errors.join('\n  ')}`);
  const stack = manifest.stack;
  if (stack === 'ts') return planTs(root, manifest);
  if (stack === 'python') return planPython(root, manifest);
  throw new Error(`unsupported architecture adapter: stack ${stack}`);
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
  const existing = pkg.scripts?.['check:architecture'];
  return {
    stack: 'ts',
    install: missing.length ? [`${pm} ${pm === 'yarn' ? 'add -D' : 'install -D'} ${missing.join(' ')}`] : [],
    add: ['.dependency-cruiser.cjs', 'tools/check_ownership.mjs'],
    modify: ['package.json (scripts.check:architecture' + (existing && existing !== script ? ' — REPLACES existing: ' + existing : '') + ')', 'ARCHITECTURE.md (checker.command)'],
    checker: `${run} check:architecture`,
    script,
    files: { '.dependency-cruiser.cjs': depcruiseConfig(root, m), 'tools/check_ownership.mjs': fs.readFileSync(path.join(PLUGIN, 'adapters/ts/check_ownership.mjs'), 'utf8') },
    reuse: existing ? `existing check:architecture script found: ${existing}` : null,
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
  const state = readState(project);
  const touched = [...plan.add, 'package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'ARCHITECTURE.md', 'node_modules/**'];
  state.plan_allow = [...new Set([...(state.plan_allow || []), ...touched])];
  writeState(project, state);
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
    pkg.scripts = { ...(pkg.scripts || {}), 'check:architecture': plan.script };
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
      const body = res.kind === 'supabase-table'
        ? (ext === 'ts' ? `export const q = (c) => c.from('${res.symbol}').select();\n` : `def q(c):\n    return c.table('${res.symbol}').select('*')\n`)
        : (ext === 'ts' ? `export const q = ${res.symbol};\n` : `q = ${res.symbol}\n`);
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
export function setupEnv(wt, stack) {
  const cmds = [];
  if (stack === 'ts') {
    const pm = packageManager(wt);
    cmds.push(pm === 'pnpm' ? 'pnpm install --frozen-lockfile' : pm === 'yarn' ? 'yarn install --immutable'
      : fs.existsSync(path.join(wt, 'package-lock.json')) ? 'npm ci' : 'npm install --no-package-lock'); // env setup never dirties the tree
  } else if (stack === 'python') {
    if (fs.existsSync(path.join(wt, 'uv.lock'))) cmds.push('uv sync --frozen');
  }
  const log = [];
  for (const c of cmds) {
    const r = spawnSync(c, { cwd: wt, shell: true, encoding: 'utf8' });
    log.push({ command: c, code: r.status, tail: ((r.stdout || '') + (r.stderr || '')).split('\n').slice(-5).join('\n') });
    if (r.status !== 0) return { ok: false, log };
  }
  return { ok: true, log };
}
