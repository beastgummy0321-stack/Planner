# harness

A Claude Code plugin: a planning layer that thinks freely, a Kanban, and an isolated executor.
Design: [SPEC.md](SPEC.md).

```
/dig     think it through with the user          — nothing is built, nothing is locked
/carve   feature + issues on one branch          — planner model, optional independent challenge
/crank   claim → worktree → worker → gates → merge → integrate → close   — control plane + workers
```

None of the three is required before another: "this is fine, do it" carves and cranks by itself.

> Anything may advise. Only execution isolation and failed verification may block.

## Install (local)

```
claude --plugin-dir D:/0UserProfile/Desktop/Default/harness
```

Edit, then `/reload-plugins`. Validate the manifest with `claude plugin validate .`.
Tests: `npm test` (creates temp git repos; the TS chain installs dependency-cruiser into one).

## What it puts in a project

```
ARCHITECTURE.md   optional: frontmatter = JSON manifest (modules, resources, verify, checker); body = current truth
.work/            features/F01.md · ready/ doing/ blocked/ done/   — the only queue
.harness/         gitignored: scratch/ (discovery, probes), runtime/ (leases, baselines, logs, reviews)
tools/            the container checker the project can run without the plugin (CI too)
```

Requires git in the target project (worktrees, scope diffs). Stacks with a generated checker:
`ts` (dependency-cruiser + ownership analyzer), `python` (shipped AST checker). Any other stack
runs the same chain without the import checker.

## The gates, in one table

| when | who | rule |
|---|---|---|
| Write/Edit | worker | only inside its worktree, inside `touch`, outside `do_not_touch`; never `.work/`, `ARCHITECTURE.md` |
| Bash | worker | anything except destructive commands; every call diffed — a change outside `touch` or in the main tree is a violation |
| Bash | anyone | `git reset --hard`, `git clean`, `rm -rf`, force push, `branch -D` denied before they run |
| Agent | anyone | a worker dispatch needs a claimed issue |
| finish | — | scope post-diff · checker (skipped when the project has none) · issue verify · typecheck/build |
| merge | — | planner receipt at the current head when `review: planner`; integration checker + `verify.smoke` in the worktree (rolled back on red) |
| claim | — | refused for a re-queued blocked issue whose text + manifest are unchanged |
| integrate feature | — | checker · test/build · feature verify · smoke · runtime acceptance; human items surfaced, never auto-closed |
| close feature | — | done issues + feature file deleted; feature branch merged into its base and removed |

The main conversation and the planner are not gated: they may write, run, re-plan, and discuss at any time.

Agents: `planner` (opus), `challenger` (opus, read-only, planner-triggered), `worker` (sonnet, worktree), `utility` (haiku: reuse scan, log triage, inventory, runtime acceptance, mechanical checks).
CI: Windows + Ubuntu (`.github/workflows/test.yml`).

CLI: `node bin/harness.mjs help`.
