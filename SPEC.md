# harness — v2 design

The durable design of this plugin. Current truth only; git is the history.
v2 (2026-09-11) cut v1's governance layer back to what it always was underneath:
**a planning layer that thinks freely, a Kanban, and an isolated executor.**

## 0. The one rule

> **Anything may advise. Only execution isolation and failed verification may block.**

A planner who dislikes the architecture re-plans. A challenger who sees a simpler route
sends it back to the planner. An adapter that does not support the stack is not used.
A reuse scan that finds a package is input for the planner. None of these stop anything.
Two things do: a worker leaving its scope, and a verification that is red.

## 1. Five principles (everything else is a capability)

1. **Frontier and planner are never locked.** The main conversation may discuss, redesign,
   re-cut issues, insert work, revisit a decision, at any time. There is no global mode and no
   command the user must type before the model may think or act.
2. **Feature → Issues is the only decomposition.** A feature is one branch, one outcome, its
   decisions, its acceptance contract. Issues are its atomic work. No goals, no tickets;
   `group` labels related issues when a feature is big.
3. **A worker is always isolated.** One issue, one lease, one worktree branched from the feature
   branch; writes only inside `touch` minus `do_not_touch`; every Bash call diffed; a change
   outside scope blocks the issue and discards the worktree. This is the execution container.
4. **Modules cross only through their public interface.** When a project declares
   `ARCHITECTURE.md`, the import checker enforces one public entry per module, declared
   dependencies, no cycles, no side doors, legacy reached only through facades. This is the
   architecture container. Projects that do not need it do not declare it.
5. **Machine verification decides whether a change merges; the user decides product.** Scope
   post-diff, checker, issue verify, typecheck/build, integration checker, smoke, feature
   verify, runtime acceptance. Human acceptance items are surfaced, never auto-closed.

## 2. Roles

| role       | who                                       | does                                                                 | never                                                    |
|------------|-------------------------------------------|----------------------------------------------------------------------|----------------------------------------------------------|
| frontier   | the model the user is talking to          | discussion, direction, control plane for /crank, final say           | implement an issue itself, read long logs                |
| planner    | `agents/planner.md` (opus-class)          | architecture when it matters, feature + issues, blocked resolution, reviews, integration review | redefine the product goal (asks the user)     |
| challenger | `agents/challenger.md` (opus, read-only)  | one independent round on a finished draft: contradiction, missing assumption, simpler route, execution trap | veto, a second round     |
| worker     | `agents/worker.md` (sonnet, worktree)     | one issue: implement, verify                                         | architecture, scope creep, interface change unless the issue says so |
| prototyper | `agents/prototyper.md` (sonnet)           | one clickable fake-data UI prototype in scratch, revised in place    | backend, issues, architecture, `src/`, a second visual identity |
| utility    | `agents/utility.md` (haiku)               | reuse scan, log triage, inventory, runtime acceptance, mechanical checks | conclusions                                           |

## 3. Entry points are intents, not transitions

```
/dig        "I want to think, not build, right now."
/prototype  "Let me click it before you build it."
/carve      "Turn what we know into a feature and issues."
/crank      "Run the queue."
```

None is required before another. "This plan is fine, do it" carves and cranks without a
further command; "/dig" on a running feature is a discussion, not a rollback. The plugin
never answers "type /carve to continue".

`/prototype` is a disposable probe specialised for UI, not a stage: one self-contained
`index.html` under `.harness/scratch/prototype/<slug>/`, opened by double-click, every flow
clickable, deterministic fake data, no backend. The user reacts in plain language; the
prototyper revises in place; one version unless the user asks for several. An approved
prototype becomes lines in the feature's Decisions and stays in scratch as the workers'
visual reference until the feature closes. No queue, state, approval file or CLI for it.

## 4. Files in a target project

```
ARCHITECTURE.md        optional. frontmatter = JSON manifest; body = how the system works now
.work/                 tracked: the only work queue
  features/F01.md      { id, title, branch, base, verify[], runtime[], human[], closed } · # Outcome · # Decisions · # Acceptance
  ready/ doing/ blocked/ done/    issue files F01-I01.md — the folder is the status
.harness/              gitignored: state.json, scratch/ (discovery.md, probes/, prototype/), runtime/ (leases, baselines, logs, reviews, session)
tools/                 the generated checker the project runs without the plugin
```

Manifest: `stack` (any string; `ts` and `python` get a generated checker), `app_shell`,
`modules` {root, public, may_depend_on, owns}, `resources` {owner, kind, definition, symbol}
(known kinds are analyzed, others planner-reviewed), `verify` {test, typecheck, build, smoke},
`checker` (set by `adapter apply`), `legacy` + `legacy_facades`.

Issue: `{ id, feature, after[], touch[], do_not_touch[], verify[], privileged[], review, interface_change }`
plus `deps[]`, `legacy_migration`, `group` when they apply; sections Objective · Done ·
Verify · Blocked if. `review: planner` when `interface_change`, dependency files, legacy migration.

No PLAN.md, no tickets, no ADRs, no constitution, no journal, no completion reports. A settled
choice lives in the feature's Decisions (while the feature is open) or in ARCHITECTURE.md.

## 5. Lifecycle

```
harness feature start F01        check out feature/<slug> (from the current branch)
harness queue next               claimable issues: deps done, no touch overlap, dependency changes alone
harness claim <id>               ready/ → doing/ (atomic rename), lease created
Agent(harness:worker, worktree)  denied unless such a lease exists
  worker: harness attach <id>    lease gets cwd, branch, base_sha; prints issue + module slice; env stays lazy
  worker: implement              PreToolUse: touch / do_not_touch / destructive deny; PostToolUse: diff both trees
harness finish <id>              scope post-diff · checker (skipped when none) · issue verify · typecheck/build → green | blocked/
harness review <id> approve      planner's receipt for the current head (review: planner only)
harness merge <id>               into the feature branch; integration checker + smoke in the worktree at the merge commit; → done/
harness integrate feature F01    checker · test/build · feature verify · smoke · runtime; human items listed
harness close feature F01        delete done issues + feature file; merge feature branch into base; remove it; clear scratch
harness recover                  leases from a dead session: partial diff saved, worktree discarded, issue re-queued
```

Blocked is a formal state with evidence, not a retry loop; an unchanged blocked issue cannot be
re-claimed (fingerprint of issue text + manifest). Long evidence goes to a log file for utility
triage. The main conversation is the control plane and is never forked into a subagent.

## 6. Capabilities (kept, optional, never a prerequisite)

Import checker adapters (ts: dependency-cruiser; python: shipped AST script) · ownership analyzers
(supabase-table, drizzle-table, sqlalchemy-model, sql-table) · legacy surface with facades ·
reuse scan · disposable probes · clickable UI prototype (`/prototype`, prototyper agent) · independent challenge (planner-triggered, one round, never
handed the planner's rationale) · lazy frozen env per worktree · docs-only fast path · evidence
router · metrics in `.harness/runtime/metrics.jsonl` · SessionStart injection of feature,
outcome, decisions, queue, last interruption.

## 7. Removed in v2 (and why)

Global `grill/plan/work` mode and its write allowlists · user-only mode transitions verified
against the last prompt · main-conversation Bash restrictions and main-tree violations ·
challenge receipts (`challenge.json`, plan hash, hook signing, machine floor) · hook-signed
planner review · ticket layer and `deps_approved` · PLAN.md · "unsupported adapter stops
/carve" · exact-match worker Bash. Each was a locally reasonable rule whose sum turned a
personal Kanban into a governance framework. The failures they guarded against are still
covered by §0: scope diff, fingerprinted retries, machine verification, and a planner that is
free to re-plan.

## 8. Regression scenarios (test/)

Worker scope (write deny, Bash post-diff, main-tree change) · worker dispatch needs a lease ·
destructive reflex · frontier writes freely · no ARCHITECTURE.md still runs the chain · unknown
stack / resource kind is skipped, not fatal · checker red at finish and at merge · identical
retry refused · docs-only fast path · lazy env once · privileged runs once · review receipt at
head · smoke in the worktree · runtime acceptance and human items · greenfield module ·
recover after session death · feature branch start → issues merge into it → close merges into
base · session status shows outcome, decisions, queue, interruption.
