---
name: work
description: Execute ready issues one by one (or in safe parallel) through the control plane: claim, worktree, worker, machine gates, review, merge, integrate, clean up. Use only when the user types /work. The main conversation routes; scripts schedule; workers implement.
disable-model-invocation: true
---

# /work — control plane

The main conversation is the control plane: it calls `harness` scripts, dispatches agents, routes results. It never implements, never edits source, never reasons about scheduling — the scripts do.

CLI: `node "${CLAUDE_PLUGIN_ROOT}/bin/harness.mjs" <command>` (call it `harness` below).

## First
Run `harness mode work`. If refused, show the reason and stop.

## Loop until `harness queue next` is empty and nothing is in doing/
1. `harness queue next` — prints the claimable issues (dependencies done, no touch overlap with active leases, dependency-changing issues alone).
2. `harness claim <id>` — atomic ready/ → doing/, lease created.
3. Dispatch the worker:
   `Agent(subagent_type: "harness:worker", isolation: "worktree", prompt: <below>)`.
   Prompt = exactly: `Issue <id>. First run this command verbatim and read its output: node "<absolute plugin path>/bin/harness.mjs" attach <id>` plus one line: "Implement only what the issue says. Bash is limited to the listed commands. When done, report: what changed, verify output, anything that blocked you." Nothing else — no architecture, no history.
4. When the worker returns: `harness finish <id>`. It runs, in order: scope post-diff, container checker, ownership analyzer, issue verify commands, project typecheck/build. Green → prints `review: none` or `review: planner`. Red → the issue is moved to blocked/ with evidence and the worktree is discarded; go to step 6.
5. If `review: planner`: dispatch `Agent(subagent_type: "harness:planner")` with the issue file and the diff (`harness diff <id>`); it answers approve / block with reasons. Approve → `harness merge <id>` (merges the branch into the base, moves the issue to done/, removes the worktree). Block → `harness block <id> "<reason>"`.
6. Blocked issues: read `.work/blocked/<id>.md`. Dispatch the planner to resolve (re-slice, fix dependencies, rewrite the ticket) — it may edit `.work/**` only. If the block is about product behaviour, ownership, architecture direction, or the plan being wrong, stop and tell the user: "this needs /grill". Never retry a worker on the same blocked issue unchanged.
7. `harness integrate ticket <F01-T01>` when a ticket's issues are all done: runs the ticket's integration verify, dispatches the planner for the integration review (cross-issue assumptions, architecture invariants, acceptance) — not a line-by-line re-review. Pass → ticket closed, issue bodies deleted.
8. `harness integrate feature <F01>` when a feature's tickets are all closed: full checker, tests, smoke/acceptance. Pass → ticket files and PLAN row deleted, worktrees removed, scratch cleared. If the result deviates from the confirmed direction, that goes back to /grill, not into more issues.

Parallel: dispatch several workers only when `queue next` lists several ids (it already checked overlap and dependencies).

## Never
- Implement anything yourself or edit files outside `.work/**`.
- Widen an issue's `touch`, relax a gate, or edit a test to make a red gate green.
- Skip `harness finish`: a worker saying "done" is not evidence.
