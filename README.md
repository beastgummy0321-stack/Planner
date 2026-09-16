# Planner Harness 3.0

A scoped workflow for Claude Code, Codex, and other coding hosts. Small local tasks run directly. Features that need isolation or resumable scheduling use a queue.

## Choose the smallest useful path

- Discuss a decision: `dig`; no Git initialization or execution permission implied.
- Build a disposable prototype: `demo`.
- Plan a multi-step feature: `carve`.
- Execute an authorized queue: `crank`.
- Extract a specific external capability: `dist`.
- Save/resume work: `handoff`; improve a recurring workflow issue: `retro`.

These skills are independent. See [WORKFLOW.md](WORKFLOW.md) for the shared authority, reading, verification, and repair contract. See [SPEC.md](SPEC.md) for the data model.

## Host compatibility

`.claude-plugin/plugin.json` preserves Claude loading. `.codex-plugin/plugin.json` provides Codex metadata and skills. Both use `hooks/hooks.json`; hook payloads normalize shell, edit, patch, and worker-dispatch tools. Named Claude agent profiles are not automatically Codex profiles: a Codex orchestrator passes the relevant role body to its native worker and creates an explicit worktree. The active model is inherited.

Requires Node.js 24+, Git, and any runtime required by the target project's checks. Run the CLI from the target project, with an absolute plugin path:

```text
node "<plugin>/bin/harness.mjs" help
node "<plugin>/bin/harness.mjs" init
```

Claude supports local loading with `claude --plugin-dir "<plugin>"`. Codex installation uses its plugin mechanism; this checkout is not automatically installed by editing it. Host hook delivery and native worker integration must be smoke-tested in the installed host. CLI and synthetic hook tests alone do not prove native integration.

## Queue lifecycle

```text
existing user authorization -> authorize feature -> claim issue
  -> worktree -> attach -> edit / targeted checks
  -> finish -> repair in place if needed -> review when required
  -> merge -> feature integrate -> close
```

Record the actual approved scope once with `authorize F01 "<user instruction>"`. A later message is not approval. `revoke F01` withdraws it. Sensitive external actions retain their own permission requirements. Use `worktree F01-I01` after claim; run `attach F01-I01` in the returned directory. Run `env` there only when runtime dependencies are needed. `queue next [limit]` defaults to two candidates; dependency and interface changes run exclusively.

`finish` retains ordinary failing work for repair. A scope violation blocks. Identical verification commands are deduplicated within a phase; merged-tree and final acceptance checks remain distinct. `close` requires a fresh successful integration receipt. Human acceptance items additionally require actual user acceptance recorded with `--human-approved`.

`recover` does nothing by default. After the host confirms a session has ended, use `recover --ended-session <id>`. Prefer an explicit per-run `HARNESS_SESSION_ID` on hosts that do not deliver session hooks. Never infer death merely because another session starts.

## Project files and limitations

- `.work/features` and `.work/ready|doing|blocked|done`: versioned outcome and queue.
- `.harness/`: ignored leases, logs, worktrees, receipts and scratch. Scratch is retained for explicit scoped cleanup.
- Optional `ARCHITECTURE.md`: module/ownership contract; supported adapters provide additional checks. Unsupported analyzers are reported as skipped.
- Dynamic ownership targets in supported adapters remain conservative failures requiring investigation; do not silently treat an unprovable ownership boundary as safe.

Hooks and Git diffs are guardrails, not a security sandbox. Use host permissions for network, credentials and destructive operations. Verification commands time out after 120 seconds by default (`HARNESS_COMMAND_TIMEOUT_MS` overrides); server commands need explicit readiness and process-tree cleanup wrappers, since shell timeout alone is not a full process supervisor. Keep one orchestrator for each queue; parallel workers have separate leased worktrees.

## Development

Run `npm test`. Tests create temporary Git repos; the TypeScript adapter integration test installs dependency-cruiser. See [OPTIMIZATION-REPORT.md](OPTIMIZATION-REPORT.md) for changes and [ASTRA-EVALUATION.md](ASTRA-EVALUATION.md) for the architecture rubric and the limits of the available evidence.
