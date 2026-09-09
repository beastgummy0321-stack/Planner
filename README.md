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
| finish | — | scope post-diff · checker (imports + ownership) · issue verify · typecheck/build |
| merge | — | integration checker on the merged base; planner approval when `review: planner` |

CLI: `node bin/harness.mjs help`.
