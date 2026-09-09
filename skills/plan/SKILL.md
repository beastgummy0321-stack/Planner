---
name: plan
description: Turn a user-confirmed direction into architecture and atomic issues. Planner model. Use only when the user types /plan after /grill, or to re-plan blocked work. Produces ARCHITECTURE.md (manifest + current truth) and .work/ (PLAN, tickets, ready issues). Wires the container checker into the project after one user approval.
disable-model-invocation: true
---

# /plan — architecture and decomposition

## First
1. Run `node "${CLAUDE_PLUGIN_ROOT}/bin/harness.mjs" mode plan`. If it refuses, stop and show the user the reason — it means the user did not type /plan, or main-tree violations exist.
2. Read `.harness/scratch/discovery.md` (the confirmed direction) and `ARCHITECTURE.md` if it exists.

## Then dispatch the planner
Dispatch `Agent(subagent_type: "harness:planner")` with: the discovery notes verbatim, the path of the plugin CLI (`node "${CLAUDE_PLUGIN_ROOT}/bin/harness.mjs"`), and the instruction set below. Do not plan in the main conversation; the main conversation relays approvals and results.

The planner, in order:
1. **Architecture.** Write `ARCHITECTURE.md`: JSON manifest in the frontmatter (see SPEC §4.1: `stack`, `app_shell`, `modules` with `root`/`public`/`may_depend_on`/`owns`, `resources` with `owner`/`kind`/`definition`/`symbol`, `verify`, `checker`), then prose that answers "how does the system work now". Modules follow business capability and ownership, never screen names. Current truth only, no history, no rationale museum. Run `harness validate`; fix until clean.
2. **Container checker.** Run `harness adapter plan`. It prints exactly what will be installed, which files change, which are added. Return that list to the main conversation; the main conversation asks the user once. On approval run `harness adapter apply`, then `harness adapter check` — it must be green, and `harness adapter prove` must show it goes red on a deliberate violation. If the stack or a resource kind is unsupported, stop with `unsupported architecture adapter` / `unsupported ownership adapter`; never downgrade to "manual review".
3. **Decompose.** Goal → Feature (`F01`) → Ticket (`F01-T01`) → Issue (`F01-T01-I01`). Write `.work/PLAN.md` (active tree only), `.work/tickets/F01-T01.md` (Outcome, Architecture scope, Issues, Integration verify, Acceptance), and issues into `.work/ready/` in the format of SPEC §4.2.
4. **Issue-ready gate**, per issue, before filing: a worker that never saw /grill, given only this file, its module's manifest slice and the code — does it still have to choose module ownership, a public interface, a data model, a dependency direction, or product behaviour? If yes, split further or settle it in ARCHITECTURE.md. One outcome per issue, one module, a runnable `verify` (or an explicit manual verification in `# Verify`), `review: planner` for interface changes, schema/migrations, permissions, money, ownership, dependency files.
5. Run `harness validate` again. Delete `.harness/scratch/discovery.md`.

The planner does not redefine the product direction. If the confirmed direction is technically impossible or contradictory, it returns an escalation ("back to /grill: …") instead of choosing.

## Finish
Show the user the PLAN tree and the ready issue ids, then say: "type /work to start execution." Do not invoke /work yourself.
