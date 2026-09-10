---
name: carve
description: Turn a confirmed direction into architecture and atomic issues. Planner model; an independent challenger when the plan changes the architecture or crosses a boundary. Use only when the user types /carve — after /dig, or directly when the direction is clear — or to re-plan blocked work. Produces ARCHITECTURE.md and .work/ (PLAN, tickets, ready issues); wires the container checker once.
disable-model-invocation: true
---

# /carve — architecture and decomposition

## First
1. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/harness.mjs" mode plan`. If it refuses, stop and show the user the reason — the user did not type /carve, or main-tree violations exist. (Entering plan mode wipes probes and the previous challenge record: a new planning round.)
2. Read `.harness/scratch/discovery.md` if it exists (confirmed direction, reuse findings, probe results); without it the user's /carve prompt is the direction. Read `ARCHITECTURE.md` if it exists.

## Then dispatch the planner
Dispatch `Agent(subagent_type: "harness:planner")` with: the direction (discovery notes verbatim, or the prompt), the CLI path (`node "${CLAUDE_PLUGIN_ROOT}/bin/harness.mjs"`), and the steps below. Do not plan in the main conversation; it relays approvals and results.

The planner, in order:
1. **Architecture.** If `ARCHITECTURE.md` exists and still describes the system this work lands in, leave it unchanged and go to step 3: shape the work, do not redesign. Otherwise write it: JSON manifest in the frontmatter (`harness: 1`, `stack`, `app_shell`, `modules` {root, public, may_depend_on, owns}, `resources` {owner, kind, definition, symbol}, `verify` {test, typecheck, build, smoke when the app can boot}, `checker`, and for an existing repo `legacy` + `legacy_facades`), then prose answering "how does the system work now". The manifest is the desired topology: a module may be declared before any file exists (its first issue creates root + public entry; `integrate feature` refuses until every declared module is real). Every production source file is a module, `app_shell`, or `legacy` — an unclassified `src/shared/**` is red. Run `harness validate`; fix until clean.
2. **Legacy surface (existing repos).** No clean-up first, no exception ledger: declare what is managed (modules) and what is legacy (globs). Legacy shrinks, never grows: new capability lands in a module behind an explicit interface, managed code reaches legacy only through a declared facade, and moving a caller out of legacy is a `legacy_migration: true` issue with `review: planner`. A characterization test only when observable behaviour moves and no existing test describes it.
3. **Container checker.** Run `harness adapter plan`. If it says `up to date`, run `harness adapter check` only. Otherwise return its install/modify/add list to the main conversation, which asks the user once; on approval `harness adapter apply --approved`, then `harness adapter check` (green) and `harness adapter prove` (red on a deliberate violation). Unsupported stack or resource kind → stop with `unsupported architecture adapter` / `unsupported ownership adapter`; never downgrade to "manual review".
4. **Reuse and dependencies.** What the /dig reuse scan flagged is used, not rebuilt; a generic capability /dig did not scan gets a `harness:utility` reuse scan before design. Every new dependency or paid service is listed once for the user — what, why, the alternative without it, the impact — and enters the ticket's `deps_approved` only after approval; an issue touching dependency files names its `deps`.
5. **Decompose.** Goal → Feature (`F01`) → Ticket (`F01-T01`: `id, feature, title, verify[], runtime[], human[], deps_approved[], closed`; sections `# Outcome`, `# Acceptance`) → Issue (`F01-T01-I01`: `id, feature, ticket, after[], touch[], do_not_touch[], verify[], privileged[], review, interface_change`, plus `deps[]` / `legacy_migration` when they apply; sections `# Objective`, `# Done`, `# Verify`, `# Blocked if`) into `.work/ready/`. `harness validate` is the schema. Ticket `verify` = machine, `runtime` = only what machine gates cannot see (boot, request, one job), `human` = only what needs a person. Run `harness plan-sync`.
6. **Issue-ready gate**, per issue: a worker that never saw /dig, given only this file, its module slice and the code — must it still choose ownership, a public interface, a data model, a dependency direction, or product behaviour? If yes, split or settle it in ARCHITECTURE.md. Sizing and `verify` follow the planner rules (split at boundaries, not line count; cheapest falsifier).
7. Run `harness validate` again. Delete `.harness/scratch/discovery.md`.

## Then the Independent Challenge (one round, above the machine floor)
`harness mode work` demands it when ARCHITECTURE.md changed this round (or is new), when any issue carries `review: planner`, or when more than one ticket is open — it names the reason when it refuses. Below that floor the plan goes straight to /crank; the planner may still ask for one when unsure. To run it: dispatch `Agent(subagent_type: "harness:challenger")` with only the user-confirmed outcome (one paragraph), the paths of `ARCHITECTURE.md`, `.work/PLAN.md`, `.work/tickets/`, `.work/ready/`, and the CLI path (`node "${CLAUDE_PLUGIN_ROOT}/bin/harness.mjs"`) — the challenger records its own verdict with `harness challenge <CLEAR|CHALLENGE>` (hook-signed; the main conversation cannot record it). **Never the planner's reasoning or rationale** — the gate denies it; a reviewer who reads the author's defence is anchored.

The challenger answers CLEAR or CHALLENGE with evidence, no veto. On CHALLENGE, dispatch the original planner once to fix the draft and re-run `harness validate`. A product or architecture disagreement goes back to the user: "this needs /dig". No second round.

If the challenge is missing or stale when the user later types /crank (never returned a verdict, or the plan changed after its CLEAR), /crank dispatches the challenger itself on the draft on disk; the user never types anything but /dig, /carve, /crank.

## Finish
Show the user the PLAN tree, the ready issue ids, the challenge verdict (or that none was required) and any human acceptance items, then say: "type /crank to start execution — a fresh session is fine, the plan and queue are on disk." Do not invoke /crank yourself.
