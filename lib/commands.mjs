import { spawnSync } from 'node:child_process';
// Verification must terminate. Server commands need their own readiness/cleanup wrapper.
export function runCommand(command, cwd, options = {}) {
  const configured = Number(process.env.HARNESS_COMMAND_TIMEOUT_MS || 120000);
  const timeout = Number.isFinite(configured) && configured > 0 ? configured : 120000;
  const r = spawnSync(command, { cwd, shell: true, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024, timeout, ...options });
  if (r.error) r.stderr = (r.stderr || '') + `\n${r.error.code || 'execution error'}: ${r.error.message}`;
  return r;
}
