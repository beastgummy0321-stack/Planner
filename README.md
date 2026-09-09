# harness

A Claude Code plugin: decision → decomposition → issue execution, with the model
hierarchy, container boundaries and cleanup built in. Design: [SPEC.md](SPEC.md).

```
/dig   think it through with the user   — frontier model, nothing is built
/carve    architecture + feature → ticket → issue   — planner model
/crank    claim → worktree → implement → gates → merge → integrate → clean   — control plane + workers
```

## Install (local)

```
claude --plugin-dir D:/0UserProfile/Desktop/Default/harness
```

Edit, then `/reload-plugins`. Validate the manifest with `claude plugin validate .`.
Tests: `npm test` (creates temp git repos; the TS chain installs dependency-cruiser into one).

## What it puts in a project

```
ARCHITECTURE.md   frontmatter = JSON manifest (modules, resources, verify, checker); body = current truth
.work/            PLAN.md (generated) · tickets/ · ready/ doing/ blocked/ done/   — the only queue
.harness/         gitignored: state.json (mode), scratch/, runtime/ (leases, baselines, last prompt)
tools/            the container checker the project can run without the plugin (CI too)
```

Requires git in the target project (worktrees, baseline diffs). Stacks with a container
adapter in v1: `ts` (dependency-cruiser + ownership analyzer), `python` (shipped AST checker).
Others stop `/carve` with `unsupported architecture adapter`.

## The gates, in one table

| when | tool | rule |
|---|---|---|
| grill | Write/Edit | only `.harness/scratch/**` |
| grill | Agent | no planner / worker dispatch |
| any | `harness mode` | only after the user typed the matching skill; never by the model |
| plan | Write/Edit | `ARCHITECTURE.md`, `.work/**`, approved checker config |
| work, main tree | Write/Edit | `.work/**` only (orchestration) |
| work, worktree | Write/Edit | the issue's `touch` minus `do_not_touch` |
| work, worker | Bash | exact match with the issue's verify/privileged commands, or `harness attach/status/env` |
| any | Bash (after) | baseline diff of main tree + worktree; out-of-allowlist changes → violation / blocked |
| finish | — | scope post-diff · checker (imports + ownership + legacy facades) · issue verify · typecheck/build |
| merge | — | integration checker + `verify.smoke` on the merged base (rolled back on red); planner approval when `review: planner` |
| plan → work | `harness mode work` | demands an independent `harness:challenger` (never with the planner's rationale) when ARCHITECTURE.md changed, an issue has `review: planner`, or more than one ticket is open; a bounded plan below that floor enters work directly |
| claim | — | refused for a re-queued blocked issue whose issue text + manifest are unchanged (no identical retry) |
| validate | — | new packages only via `deps` ⊆ ticket `deps_approved`; `touch` into `legacy` only with `legacy_migration: true` + planner review |
| integrate | — | machine verify → runtime acceptance → human items surfaced to the user |

## What is conditional since 1.3, and what never is

Containment is unconditional: worktree, touch/do-not-touch, worker Bash allowlist, destructive-command deny, scope post-diff, ownership, no identical retry. Assurance is paid where it can catch something: the dependency install runs once, before the first runtime command (never for a copy change); a docs-only diff skips the import checker, typecheck, build and smoke; the challenger is demanded by the machine floor above, not by every /carve; `adapter plan` says `up to date` instead of re-applying and re-proving. Every CLI call and agent dispatch leaves a line in `.harness/runtime/metrics.jsonl` — the data for the next round.

Agents: `planner` (opus), `challenger` (opus, read-only), `worker` (sonnet, worktree), `utility` (haiku: reuse scan, log triage, inventory, runtime acceptance, mechanical checks).
CI: Windows + Ubuntu (`.github/workflows/test.yml`).

CLI: `node bin/harness.mjs help`.
