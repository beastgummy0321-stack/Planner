---
name: carve
description: Turn a direction into one feature file and atomic issues (Feature -> Issues, one branch), through the planner. Use when the user types /carve, says "do it / plan it / 就照這個做" after a discussion, or when a running feature needs re-planning. Nothing has to precede it and nothing has to follow it - it may continue straight into /crank when the user wanted the work done.
---

# /carve — cut the work

`/carve` is an intent: **turn what we know into a feature and its issues.** The planner does the cutting; the main conversation relays approvals and results. If the user's intent was "build it", continue into `/crank` when the queue is ready; if it was "show me the plan", stop and show it.

CLI: `node "${CLAUDE_PLUGIN_ROOT}/bin/harness.mjs" <command>` (called `harness` below).

## First
1. No `.harness/`: `harness init` (git repo required).
2. Gather the direction: `.harness/scratch/discovery.md` if it exists, else the conversation, else the prompt. Read `ARCHITECTURE.md` and `harness status` if they exist. Re-planning a running feature is normal: the feature file and its ready/blocked issues are the input.

## Dispatch the planner
`Agent(subagent_type: "harness:planner")` with the direction verbatim, the CLI path, and the steps below. Do not plan in the main conversation.

The planner, in order:
1. **Architecture — only when it matters.** Skip `ARCHITECTURE.md` entirely for a script, a single-module app, a prototype, a repo whose shape is not the point. Create or update it when modules, ownership or public interfaces are a real concern: JSON manifest in the frontmatter (`stack`, `app_shell`, `modules` {root, public, may_depend_on, owns}, `resources` {owner, kind, definition, symbol}, `verify` {test, typecheck, build, smoke when the app can boot}, and for an existing repo `legacy` + `legacy_facades`), then prose answering "how does the system work now". The manifest is the desired topology: a module may be declared before it exists. When it exists and still holds, shape the work inside it — do not redesign what the direction does not change. `harness validate` is the schema.
2. **Checker — a capability, not a prerequisite.** With a manifest for `ts` or `python`: `harness adapter plan`; `up to date` → `harness adapter check`; otherwise show the install/modify list to the user once, then `apply --approved`, `check`, `prove`. Any other stack, or an unknown resource kind: the checker is skipped and the planner reviews boundaries by hand. Never stop planning for a missing adapter.
3. **Reuse and dependencies.** What the /dig reuse scan flagged is used, not rebuilt; a generic capability nobody scanned gets a `harness:utility` reuse scan before design. A new dependency or paid service is listed once for the user (what, why, the alternative, the impact); the issue that adds it names it in `deps`.
4. **Feature file** `.work/features/F01.md`: frontmatter `{ id, title, branch: "feature/<slug>", verify[], runtime[], human[], closed: false }`; sections `# Outcome` (one paragraph: what is true when this is done), `# Decisions` (the settled choices, one line each — this is what the next session reads first), `# Acceptance`. `verify` = machine commands that prove the feature, `runtime` = only what machine gates cannot see (boot, request, one job), `human` = only what needs a person. Then `harness feature start F01` checks out the branch; issues branch from it and merge into it.
5. **Issues** `.work/ready/F01-I01.md`: frontmatter `{ id, feature, after[], touch[], do_not_touch[], verify[], privileged[], review, interface_change }` plus `deps[]`, `legacy_migration`, `group` when they apply; sections `# Objective`, `# Done`, `# Verify`, `# Blocked if`. `review: planner` for public interfaces, schema, permissions, money, ownership, dependency files, legacy migration. Split at decision, ownership, dependency, rollback or verification boundaries, never at line count; `verify` is the cheapest falsifier of the claim.
6. **Issue-ready check**, per issue: a worker that never saw the discussion, given only this file, its module slice and the code — must it still choose ownership, a public interface, a data model, a dependency direction, or product behaviour? If yes, settle it (in the feature's Decisions or in ARCHITECTURE.md) or split.
7. `harness validate`. Delete `.harness/scratch/discovery.md` (its content now lives in the feature file).

## Independent challenge — automatic, when it earns its cost
The planner asks for one when the architecture changed or is new, the work crosses module boundaries, an issue carries `review: planner`, the risk is high, or it is unsure. Then dispatch `Agent(subagent_type: "harness:challenger")` with **only** the user-confirmed outcome (one paragraph), the paths of `ARCHITECTURE.md`, `.work/features/F01.md` and `.work/ready/`, and read access. Never the planner's reasoning — a reviewer who reads the author's defence is anchored. `CLEAR` → continue. `CHALLENGE` → the planner fixes the draft once and re-runs `harness validate`. A product or architecture disagreement is the one thing that goes to the user. One round; the user never operates this, at most they see "plan reviewed independently, N issues re-cut".

## Finish
Show the feature (title, outcome, decisions, branch), the ready issue ids in order, any human acceptance items, whether it was challenged. If the user wanted the work done, continue into `/crank`; otherwise stop here — the plan is on disk and a fresh session can pick it up.
