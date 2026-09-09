# harness — v1 design

The durable design of this plugin. Current truth only; git is the history.
Written 2026-09-10 from the handoff report, the external reviewer's three replies,
and five final rulings (§9). Nothing here is "V2": every section is a v1 completion
condition (§11).

## 1. What it is

A Claude Code plugin that turns a vague wish into shipped code through three
user entry points, with the model hierarchy, work decomposition, container
boundaries and cleanup built in:

```
/dig   frontier + user   think it through   (no build)
/carve    planner           architecture + feature → ticket → issue
/crank    control plane     claim → worktree → implement → gates → merge → integrate → clean
```

Reliability comes from hierarchy + tiny execution scope + hard module boundaries
+ machine verification + upward escalation — not from rules. A rule is added only
to protect an architecture invariant, execution isolation, or verification
correctness, or because a reproducible failure has no other fix.

## 2. Roles (not vendors)

| role     | who                                        | does                                                     | never                                              |
|----------|--------------------------------------------|----------------------------------------------------------|----------------------------------------------------|
| frontier | the model the user is talking to           | grill, direction, architecture escalation, final say     | routine implementation, issue review, log reading  |
| planner  | `agents/planner.md` (opus-class)           | ARCHITECTURE manifest, containers, feature/ticket/issue, blocked resolution, high-risk review, integration | redefine product goals (escalate to /dig instead) |
| worker   | `agents/worker.md` (sonnet-class, worktree)| one issue: implement, issue tests, verify                | architecture, scope creep, public interface change unless the issue says so, governance docs |
| utility  | `agents/utility.md` (haiku-class)          | grep, inventory, log triage, evidence, mechanical cleanup | conclusions about architecture                     |

No cross-vendor dispatch. `frontier` is whoever runs the main conversation.

## 3. Modes and the No-Build Gate

`.harness/state.json` holds `{ "mode": "grill" | "plan" | "work", "violations": [] }`.
No `.harness/` directory → the plugin is inert for that project.

| mode  | Write/Edit allowed (main tree)                                   | Agent dispatch allowed        |
|-------|------------------------------------------------------------------|-------------------------------|
| grill | `.harness/scratch/**` only                                       | utility, Explore              |
| plan  | `ARCHITECTURE.md`, `.work/**`, `.harness/**`, adapter-declared config paths after the user approved the install plan | planner, utility |
| work  | `.work/**`, `.harness/**` (orchestration only); in a worktree: the lease's `touch` minus `do_not_touch` | worker (only against a claimed lease), planner, utility |

Everything else is denied by PreToolUse (`hooks/gate.mjs`), not warned.

**Only the user changes mode.** `harness mode <m>` succeeds only when the most
recent user prompt (recorded by the UserPromptSubmit hook, which the model
cannot fake) invoked the matching skill (`/dig`, `/carve`, `/crank`). A model
that calls the Skill tool on its own is refused. There is no readiness
checklist, round limit, or "the model thinks it has enough" exit.

Bash in the main tree is allowed in every mode (the frontier researches, the
control plane runs `harness` scripts), but every Bash call is baselined before
and diffed after (`git status --porcelain` + `git diff HEAD --numstat`, plus the
same for the `.harness/scratch` exemption). A change outside the mode's
allowlist is recorded in `state.violations` and reported with exit 2; mode
transitions and `harness merge` refuse while violations exist. Reverting the
file clears it.

## 4. Durable documents in a target project

```
ARCHITECTURE.md      frontmatter = machine manifest (JSON, which is valid YAML); body = current truth prose
.work/               tracked: the only work queue
  PLAN.md            active Goal → Feature → Ticket tree; finished rows deleted
  tickets/F01-T01.md Outcome · Architecture scope · Issues · Integration verify · Acceptance
  ready/ doing/ blocked/ done/   issue files F01-T01-I01.md — the folder is the status
.harness/            gitignored: state.json, scratch/, runtime/leases/, runtime/baselines/, runtime/last-prompt.json
```

No CONSTITUTION, no ADR system, no per-module contract markdown, no BOARD
journal, no decision archive. A settled choice is written into ARCHITECTURE.md;
the previous version lives in git. User messages are candidates until the user
says "use this direction" inside /dig.

### 4.1 Manifest (ARCHITECTURE.md frontmatter)

```json
{
  "harness": 1,
  "stack": "ts",
  "app_shell": ["src/app/**"],
  "modules": {
    "identity": { "root": "src/modules/identity", "public": "src/modules/identity/index.ts",
                  "may_depend_on": [], "owns": ["src/modules/identity/**"] },
    "billing":  { "root": "src/modules/billing",  "public": "src/modules/billing/index.ts",
                  "may_depend_on": ["identity"], "owns": ["src/modules/billing/**"] }
  },
  "resources": {
    "payments": { "owner": "billing", "kind": "supabase-table",
                  "definition": ["supabase/migrations/**"], "symbol": "payments" }
  },
  "verify": { "typecheck": "npx tsc --noEmit", "build": "npm run build", "test": "npm test" },
  "checker": { "command": "npm run check:architecture" }
}
```

`harness validate` rejects: unknown stack, module without `root`/`public`,
`public` outside `root`, `may_depend_on` naming unknown modules or forming a
cycle, resource with unknown owner or unsupported `kind`, paths that do not
exist. There is exactly one module registry: this block.

### 4.2 Issue (`.work/*/F01-T01-I01.md`)

```
---
{ "id": "F01-T01-I01", "feature": "F01", "ticket": "T01", "after": [],
  "touch": ["src/modules/identity/**"], "do_not_touch": [],
  "verify": ["npm test -- identity"], "privileged": [],
  "interface_change": false, "review": "none" }
---
# Objective
# Done
# Verify
# Blocked if
```

Issue-ready gate (planner answers before filing): would a worker that never saw
/dig, given only this file, the manifest slice for its module and the code,
still have to choose module ownership, a public interface, a data model, a
dependency direction or product behaviour? If yes the issue is not ready.
`review` must be `planner` when `interface_change` is true, or the issue touches
schema/migrations, permissions, money, module ownership, or dependency files
(`package.json`, lockfiles, `pyproject.toml`).

## 5. Container: three machine layers

**Layer 1 — scope (plugin, any language).** PreToolUse denies Write/Edit outside
the lease's `touch` (minus `do_not_touch`). Worker Bash is default-deny: only an
exact string match with the issue's `verify`/`privileged` entries or a harness
fixed command (`node <plugin>/bin/harness.mjs …`) runs; exploration is
Read/Grep/Glob. No shell parsing. After every allowed Bash, worktree and main
tree are diffed against their pre-call baseline; any change outside `touch`
marks the lease violated → the issue goes to `blocked/` and the worktree is
discarded, never kept.

**Layer 2 — import boundary (plugin generates, project tool runs).** From the
manifest, `harness adapter apply` writes the checker config and package script
for the stack and installs the dev dependency — after printing what it will
install/modify/add and the user approving once. Rules enforced: one declared
public entry per module; cross-module imports only through it; no cycles; no
module imports the app shell. Existing equivalent tooling is reused, not
duplicated. Stacks in v1: `ts` (dependency-cruiser), `python` (import-linter for
forbidden/cycle contracts + a shipped AST script for entry-only). Any other
stack: `/carve` stops with `unsupported architecture adapter`; it never
downgrades to "manual review".

**Layer 3 — ownership (manifest + stack analyzer).** Logical owner ≠ definition
location: `resources.<name>.owner` names the module, `definition` names where
the schema physically lives (a shared migrations dir or central schema file is
legal). What is enforced is direct data access: a stack-specific, symbol-aware
analyzer flags any non-owner module that reads/writes the resource
(`supabase-table`: `.from("x")`, `.table("x")`, `.rpc(...)` targets;
`drizzle-table`: import/use of the table symbol; `sqlalchemy-model`: model
class import/use). Changing a resource's definition is allowed only in an issue
whose ticket belongs to the owner, with `review: planner`. An unknown
data-access pattern stops `/carve` with `unsupported ownership adapter`; generic
grep is evidence, never the mechanism.

## 6. Work hierarchy and queue

Goal → Feature (`F01`) → Ticket (`F01-T01`) → Issue (`F01-T01-I01`). Ticket is a
first-class object: it owns integration acceptance and groups issues.

Queue = folders. `ready → doing` is an atomic rename (claim); a second claim
fails. An issue is claimable when every `after` id is in `done/`. Parallel
workers are allowed when `after` is satisfied, `touch` globs do not overlap, no
two change the same public entry, and each has its own worktree; otherwise
sequential. Dependency-changing issues are always sequential.

## 7. /crank lifecycle

```
harness queue next            → claimable issues (deps, overlap, dependency-change serialisation)
harness claim <id>            → ready/ → doing/ (atomic), lease file created (awaiting attach)
Agent(harness:worker, isolation: worktree)   ← hook denies this dispatch unless such a lease exists
  worker: harness attach <id> → lease gets cwd, branch, base SHA; env adapter runs frozen install
  worker: implement           → Layer 1 gates on every tool call
  worker: verify commands     → exact-match Bash only
harness finish <id>           → scope post-diff · checker · ownership analyzer · issue verify · typecheck/build
                                 all green → review (if planner) → merge into base → done/
                                 any red   → blocked/ with Observed · Evidence · Why the issue cannot decide · Boundary affected
harness integrate ticket <id> → when all issues done: planner integration review, ticket verify, acceptance; delete issue bodies
harness integrate feature <id>→ full checker + tests + acceptance; delete ticket files and PLAN row; remove worktrees
```

The main conversation is the control plane: it calls scripts and routes
results. It does not fork `/crank` to a subagent (subagents cannot spawn
subagents). The scheduler is code, not the LLM. The planner appears only at
blocked, high-risk review, interface/ownership change, and integration.

Worktrees are Claude Code's own (`isolation: worktree`), one per issue, never
the shared main tree. Environment adapter: `ts` → detect lockfile, frozen
install with the project's package manager (npm ci / pnpm install
--frozen-lockfile / yarn --immutable) using its global cache; `python` → `uv
sync` per worktree with the shared cache. No shared `node_modules` junction:
that is shared mutable state. `.worktreeinclude` carries gitignored runtime
files (`.env`) into worktrees.

Runtime state for parallel workers lives in per-issue lease files
`.harness/runtime/leases/<id>.json` (`issue, agent_id, worktree, branch,
base_sha, allowed_commands, touch, do_not_touch, violations`). `state.json`
holds only low-frequency global state. Hooks resolve "which issue am I" from
the call's `cwd` (worktree path → lease) and `agent_id`.

## 8. Escalation and cleanup

Blocked is a formal state, not a retry loop. Worker → `blocked/` with evidence.
Planner resolves re-slicing, missing deps, ticket order, unclear contracts. If
the block is about product behaviour, ownership, architecture direction, or the
plan itself being wrong → back to `/dig` → user.

GC is built into `/crank`: issue done → body kept until ticket integration →
deleted; ticket closed → row kept in PLAN until feature close → deleted;
feature closed → worktrees removed, scratch cleared, ARCHITECTURE.md updated
only if truth changed. `.harness/scratch/discovery.md` is deleted when `/carve`
produces output. No completion reports, lessons-learned, postmortems, ADRs.

SessionStart injects only: mode, active feature/ticket/issues, blocked issues,
violations. Never planning history, finished issues, or the full rule set.
Context shrinks per tier: frontier reads the problem and repo; planner reads
grill output, manifest, active work; worker reads one issue, its module slice,
its code; utility reads one evidence target.

## 9. Five final rulings (2026-09-10, closed)

1. Ownership = logical owner + physical definition path; enforced on direct
   data access via symbol-aware stack adapters; unknown patterns stop `/carve`.
2. Worker Bash default-deny, exact-match allowlist only; baseline diff after
   every allowed call on worktree and main tree.
3. One worktree per issue, environment adapter with frozen install + shared
   package-manager cache; no junctioned `node_modules`; dependency changes are
   serialised and planner-reviewed.
4. `/crank` stays in the top-level control plane with deterministic scripts;
   never forked to a planner subagent.
5. Per-issue lease files with atomic claim; `state.json` holds only global
   low-frequency state; hooks resolve the issue from `cwd` and agent identity.

## 10. Explicitly not carried over from skeleton-slice

Constitution, ADR system/index/hooks, A/B/C routes, screen = module, universal
pull-out test, third-caller rule, global line cap, BOARD journal, ticket
contradiction essays, exhaustive shared-files prose, forced two-round
convergence, automatic documentation after work. Bringing any back requires a
reproduced failure of this harness first.

## 11. Definition of done for v1

The whole chain runs on a real project, and each of these regression scenarios
has been proven red once, then green:

1. Self-contradicting issue → `blocked/`, not a worker retry loop.
2. Worker bypasses a public entry → checker red.
3. Worker edits outside `touch` → PreToolUse deny.
4. Worker uses Bash to bypass scope → deny, or post-diff → blocked + worktree discarded.
5. Cross-module deep import → checker red.
6. Dependency cycle → checker red.
7. Non-owner module touches another's resource → ownership red.
8. Implementation attempted before the user ended /dig → No-Build deny.
9. New user idea taken as a decision → ARCHITECTURE.md unchanged.

## 13. Second round (2026-09-10): what the old harness protected, redesigned

Rule of the round: an old mechanism is not a compatibility requirement; the
failure it prevented is. Each entry names the failure and the new, smaller line.

| failure prevented | mechanism now | machine part |
|---|---|---|
| the planner is the only validator of its own assumptions | **Independent Challenge**: a fresh planner-class `harness:challenger` (read-only) gets the confirmed outcome + artefacts, never the planner's reasoning; answers CLEAR/CHALLENGE on contradiction, missing assumption, simpler route, execution trap; no veto, one round | gate records the challenger dispatch (`runtime/challenge.json`) and denies a prompt carrying rationale; `mode work` refuses without a record; `mode plan` clears it |
| building what the repo, a skill, the platform or a package already does | **Reuse gate** in /dig and /carve: utility runs the reuse scan (repo → installed skills/plugins/MCP → skill ecosystem → platform primitive → installed dep → maintained package → reference implementation); new packages are approved once by the user | issues touching dependency files must declare `deps`; each must be in the ticket's `deps_approved` |
| a dirty existing repo can never start under the container rules | **Managed / legacy surface**: manifest `legacy` globs + `legacy_facades`; legacy is ungoverned and may shrink; managed code reaches it only via facades; new capability never lands in legacy | checkers (depcruise rule, python AST) flag managed→legacy internals; validation rejects `touch` into legacy unless `legacy_migration: true` + planner review; module roots inside legacy rejected; no tolerance baselines |
| unit/typecheck/build green but the app does not run | **Acceptance contract** per ticket: `verify` (machine) · `runtime` (boot/request/click, only what machine gates cannot see) · `human` (only what needs a person); manifest `verify.smoke` | `merge` runs smoke on the merged base and rolls back on red; `integrate ticket` runs runtime after machine; human items are surfaced, never auto-closed; feature integration runs smoke |
| expensive models burn tokens on evidence | **Evidence router**: utility has fixed jobs — reuse scan, log triage, repo inventory, runtime acceptance, mechanical verification | red gates with long output write `runtime/logs/*.log`; the blocked body keeps an 8-line tail and tells the control plane to triage with utility first |
| re-dispatching the same failed input to another agent | **No identical retry**: fingerprint = issue text (minus Blocked trailer) + manifest frontmatter, stored at block time | `claim` refuses a re-queued issue with an unchanged fingerprint |
| the most expensive step starts before the biggest uncertainty is tested | **Disposable probe** under `.harness/scratch/probes/<name>/` during /dig: one question, result into discovery, never merged | scratch is gitignored and outside every `touch`; `mode plan` wipes `probes/` |
| the user is asked what the repo could answer | /dig communication contract: fact ≠ user question; ask only where the user holds authority; "I don't know" is legal; 1–3 high-leverage questions per turn | — (skill rule) |
| hooks/paths/worktrees behave differently per platform | `.github/workflows/test.yml`: Windows + Ubuntu matrix, node 24, python 3.12 | CI |

Still not carried over, and still not needed for any of the above: ADR,
constitution, A/B/C routes, screen = module, line caps, third-caller,
universal pull-out, BOARD journal, contradiction essays, forced convergence,
completion reports.

Regression scenarios added to §11: 10 self-review blindness, 11 closed-door
building, 12 legacy adoption, 13 utility routing, 14 runtime-only defect,
15 identical retry, 16 disposable probe — all proven red then green in `test/`.

## 14. Third round (2026-09-10): control-plane holes that only real use hits

An external stress pass (model reflexes, session death, greenfield, dirty repos,
false positives, command side effects) found holes the 20 tests did not cover.
Rule of the round: fix the pit, not the abstraction — every line below is ≤30
lines and has a red-then-green scenario in `test/stress.test.mjs`.

| failure prevented | mechanism now | machine part |
|---|---|---|
| greenfield deadlock: a new module cannot be declared until it exists, cannot exist until /crank | ARCHITECTURE.md is the **desired topology**; root/public existence is soft in /carve and /crank, hard at `integrate feature`; a repo with no module root is an explicit `greenfield` checker result, never "0 modules = green" | `validate.mjs` `materialized` option; `runChecker` greenfield branch (17) |
| `git reset --hard` / `git clean` / `rm -rf` / `npm install` in the main conversation runs first, is reported after | **reflex denylist** in PreToolUse for every non-worker Bash; in work mode the main conversation may run only `harness` and read-only git (agents keep the denylist). Deliberately not a sandbox: `node -e` still reaches the baseline diff | `gate.mjs` `DESTRUCTIVE`, `READ_ONLY_GIT` (18) |
| the side door: a module imports an unclassified `src/shared/**` and every module recouples through it | **closed world**: a module reaches local code only inside a declared module root or a legacy facade; every production file is a module, app_shell or legacy | depcruise `closed-world-local`; python `unclassified local file` (19) |
| ownership by word: `const users = []` is red, `.from(table)` is green | ownership is a **binding**: drizzle/sqlalchemy = importing the symbol from a `definition` file; sql-table = name inside a string literal; a non-literal supabase target in managed code is red (unknown ≠ green). Regex on imports, not an AST | `check_ownership.mjs`, `check_architecture.py` (20A/B/C) |
| a challenger that timed out counts as a review | the receipt has `completed` + `verdict`, written by **PostToolUse Agent**; `mode work` (plan→work only) refuses an unreturned challenge and a CLEAR whose `plan_hash` no longer matches | `post.mjs` `afterAgent`, `harness mode` (21, 22) |
| the session dies after attach: the lease blocks its touch prefix forever | **recover** inside `harness mode work`: a lease from another session is an orphan — partial diff saved to `runtime/logs/*.diff`, worktree discarded, issue re-queued unchanged (no blocked fingerprint); `release` also discards the worktree | `queue.recover`, lease `session_id` (23) |
| `finish` re-runs the privileged generator/migration | lease keeps `verify_commands` apart from the worker's `allowed_commands` | `claim`, `finish` (24) |
| `merge --approved` is a self-assertion | **review receipt**: only a Bash call by the `harness:planner` agent running `harness review <id> approve` is hook-signed with the current `head_sha`; `merge` accepts a matching receipt, nothing else | `gate.mjs`, `queue.merge` (25) |
| a passing smoke writes caches into the governed tree | merge smoke runs in the issue's worktree checked out at the merge commit; ticket/feature acceptance that dirties the main tree is red (detected, not prevented) | `queue.merge`, `dirtyOutsideWork` (26) |
| "先不要 /carve" transitions | the prompt must *be* the command: `^/carve` | `harness mode` (27) |
| an existing `check:architecture` is overwritten | composed: ours lands as `check:architecture:harness`, the checker runs both | `planTs` (28) |
| Yarn Classic gets Berry's `--immutable`; no-lockfile installs pass silently | `.yarnrc.yml` decides; a non-reproducible install is named in the env log | `envCommands` (29) |
| the reuse scan cannot leave the repo | utility has WebSearch/WebFetch; `find-skills` is a strategy, not a dependency | `agents/utility.md` |

Deliberately not done: user approval as a hook receipt (the `/crank` prompt is
the user's act; `deps_approved` + git log are the audit trail — restructuring
carve→crank for it is not worth it yet); base HEAD in the retry fingerprint
(would void every block on any merge); a TypeScript/Python AST ownership
analyzer; an "environment contract" gate.

## 15. Fourth round (2026-09-10): pay for assurance only where it can catch something (v1.3.0)

An external efficiency handoff (17 proposals) was ablated against the code: kept only what changes a real call
path. Containment stays unconditional; assurance became conditional on machine facts, never on a model's opinion.

| fixed cost removed | mechanism now | machine part |
|---|---|---|
| frozen install on every attach | lazy env: `ensureEnv` runs once, before the first command that needs a runtime (gate, finish, merge); `lease.env_ready` | `adapters.needsRuntime/ensureEnv` (37, 38) |
| typecheck/build/checker/smoke on a `.md` change | docs-only diff (`.md .txt` images) skips the import checker, typecheck, build at finish and the integration checker + smoke at merge; scope and issue verify always run | `queue.docsOnly` (39) |
| challenger on every /carve | machine floor: demanded when ARCHITECTURE.md hash ≠ `state.arch_hash` (or first plan), any open issue has `review: planner`, or >1 open ticket; below it work opens without one | `harness mode work` (40) |
| adapter apply + prove + approval per feature | `planAdapter.unchanged` by byte-compare of generated files, script and checker command → `adapter check` only | `adapters.isApplied` (41) |
| worker reads ARCHITECTURE prose; reviewer eats the whole diff | attach prints the touched modules' contract; `diff --stat`; planner reads files itself | `attach`, `diff` (42) |
| no data on where time goes | `.harness/runtime/metrics.jsonl`: one line per CLI call (ms, ok) and per agent dispatch; never injected | `bin/harness.mjs`, `gate.gateAgent` |

Deliberately not done (revisit only with metrics): a `needs_*` derived-requirements object, a `next-action`
state machine for /crank, a checker result cache, a reuse-scan cache, per-project model mapping, a replay benchmark.

## 12. Implementation order (dependency order, not phases)

1. Plugin shell ✓ 2. state + hooks foundation (deny proven, plugin loads via
`claude --plugin-dir`) 3. /dig (No-Build, scratch, user-only transition)
4. manifest parser/validator 5. container adapters ts + python 6. scope + Bash
enforcement + worktree + env adapter 7. /carve 8. queue 9. /crank 10. ownership
analyzers 11. ticket/feature integration 12. lifecycle cleanup 13. stress
regression (§11).
