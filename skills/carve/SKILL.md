---
name: carve
description: Turn a user-confirmed direction into architecture and atomic issues. Planner model, then an independent challenger. Use only when the user types /carve after /dig, or to re-plan blocked work. Produces ARCHITECTURE.md (manifest + current truth) and .work/ (PLAN, tickets, ready issues). Wires the container checker into the project after one user approval.
disable-model-invocation: true
---

# /carve — architecture and decomposition

## First
1. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/harness.mjs" mode plan`. If it refuses, stop and show the user the reason — the user did not type /carve, or main-tree violations exist. (Entering plan mode wipes probes and the previous challenge record: this is a new planning round.)
2. Read `.harness/scratch/discovery.md` (the confirmed direction, reuse findings, probe results) and `ARCHITECTURE.md` if it exists.

## Then dispatch the planner
Dispatch `Agent(subagent_type: "harness:planner")` with: the discovery notes verbatim, the CLI path (`node "${CLAUDE_PLUGIN_ROOT}/bin/harness.mjs"`), and the instruction set below. Do not plan in the main conversation; it relays approvals and results.

The planner, in order:
1. **Architecture.** Write `ARCHITECTURE.md`: JSON manifest in the frontmatter (SPEC §4.1 — `stack`, `app_shell`, `modules`, `resources`, `verify` incl. `smoke` when the app can boot, `checker`, and for an existing repo `legacy` + `legacy_facades`), then prose that answers "how does the system work now". Modules follow business capability and ownership, never screens. The manifest is the desired topology: a new module may be declared before any file exists (its first issue creates root + public entry; `integrate feature` refuses until every declared module is real). Every production source file must be classified — a module, `app_shell`, or `legacy` — because a module may import local code only from declared modules: an unclassified `src/shared/**` is red. Run `harness validate`; fix until clean.
2. **Managed / legacy surface (existing repos).** Do not clean the repo first and do not build an exception ledger. Declare what the harness manages now (modules) and what is legacy (globs). Legacy may exist and shrink; it never grows: new capability lands in a new module behind an explicit interface, and managed code reaches legacy only through a declared facade. Moving a caller from legacy to managed is a `legacy_migration: true` issue with `review: planner`; a characterization test is written only when observable behaviour is being moved or changed and existing tests do not describe it.
3. **Container checker.** Run `harness adapter plan`; return its install/modify/add list to the main conversation, which asks the user once. On approval `harness adapter apply --approved`, then `harness adapter check` (green) and `harness adapter prove` (red on a deliberate violation). Unsupported stack or resource kind → stop with `unsupported architecture adapter` / `unsupported ownership adapter`; never downgrade to "manual review".
4. **Reuse and dependencies.** Anything the reuse scan in /dig flagged is used, not rebuilt; if a generic capability appears now that /dig did not scan, dispatch `harness:utility` for a reuse scan before designing it. Every new runtime or dev dependency, or paid service, is listed once for the user — what, why, the alternative without it, the impact — and only after approval goes into the ticket's `deps_approved`. An issue that touches dependency files must name its `deps`; validation refuses anything not approved.
5. **Decompose.** Goal → Feature (`F01`) → Ticket (`F01-T01`, frontmatter: `id, feature, title, verify[], runtime[], human[], deps_approved[], closed`) → Issue (`F01-T01-I01`, SPEC §4.2) into `.work/ready/`. Each ticket carries its acceptance contract: `verify` = machine (tests, typecheck), `runtime` = only what machine gates cannot see (boot the app and load the main route, call the endpoint, run one job — Playwright/curl commands), `human` = only what needs a person (visual, UX, copy, business acceptance). Run `harness plan-sync`.
6. **Issue-ready gate**, per issue: a worker that never saw /dig, given only this file, its module's manifest slice and the code — does it still have to choose ownership, a public interface, a data model, a dependency direction, or product behaviour? If yes, split or settle it in ARCHITECTURE.md. One outcome, one module, runnable `verify` or an explicit manual verification, `review: planner` for interface changes, schema/migrations, permissions, money, ownership, dependency files, legacy migration.
7. Run `harness validate` again. Delete `.harness/scratch/discovery.md`.

## Then the Independent Challenge (one round, mandatory)
The planner must not be the only validator of its own assumptions. Dispatch `Agent(subagent_type: "harness:challenger")` with only: the user-confirmed outcome (one paragraph), and the paths of `ARCHITECTURE.md`, `.work/PLAN.md`, `.work/tickets/`, `.work/ready/`. **Do not pass the planner's reasoning, rationale or history** — the gate denies a prompt that carries it, because a reviewer who reads the author's defence is anchored. `harness mode work` refuses until this dispatch has happened in the current planning round.

The challenger answers CLEAR or CHALLENGE on four questions: contradiction, missing assumption, simpler route, execution trap — each with evidence. It has no veto. On CHALLENGE, dispatch the original planner once to fix the draft (`.work/**`, `ARCHITECTURE.md`) and re-run `harness validate`. A product or architecture disagreement goes back to the user: say "this needs /dig". There is no second challenge round; no planner ↔ challenger loop.

## Finish
Show the user the PLAN tree, the ready issue ids, the challenge verdict, and any human acceptance items, then say: "type /crank to start execution." Do not invoke /crank yourself.
