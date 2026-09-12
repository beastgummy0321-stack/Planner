---
name: crank
description: Run the ready queue: claim, worktree, worker, machine gates, review, merge into the feature branch, integrate, close. Use when the user types /crank, says "run it / 開工", or when the user answers a carved plan with a go. The main conversation routes; scripts schedule; workers implement; utility collects evidence.
---

# /crank — run the queue

The main conversation is the control plane: it calls `harness` scripts, dispatches agents, routes results. It does not implement issues itself (that is what workers and their worktrees are for), does not reason about scheduling (the scripts do), and does not read long logs (utility does). It may still answer the user, discuss, re-plan, or pause the queue at any time — the queue is state, not a mode.

CLI: `node "${CLAUDE_PLUGIN_ROOT}/bin/harness.mjs" <command>` (called `harness` below).

## First
`harness recover` — issues left by a dead session are re-queued, their partial diff saved under `.harness/runtime/logs/`; tell the user which. `harness status` shows the feature, its branch and the queue; if the main tree is not on the feature branch, `harness feature start F01`.

## Loop until `harness queue next` is empty and nothing is in doing/
1. `harness queue next` — claimable issues (dependencies done, no touch overlap with active leases, dependency-changing issues alone).
2. `harness claim <id>` — atomic ready/ → doing/, lease created. `identical retry refused` means the blocked issue was re-queued unchanged: go to step 6, never re-dispatch. `show the user the plan` means the feature has not started and its issues are newer than the user's last message: show the plan, end the turn, claim after they answer.
3. Dispatch the worker: `Agent(subagent_type: "harness:worker", isolation: "worktree", prompt: <below>)`.
   Prompt = exactly: `Issue <id>. First run this command verbatim and read its output: node "<absolute plugin path>/bin/harness.mjs" attach <id>` plus one line: "Implement only what the issue says, within the feature outcome and decisions attach printed. When done, report in under ten lines: files changed, verify pass/fail per command, anything that blocked you." Nothing else.
4. When the worker returns: `harness finish <id>`. Order: scope post-diff → container checker (skipped when the project has none) → issue verify → typecheck/build. Green → prints `review: none|planner`. Red → the issue is in blocked/ with evidence and the worktree is discarded; go to step 6.
5. `review: planner` → dispatch `harness:planner` with the issue path and the CLI path (it runs `harness diff <id> --stat` and reads what it needs — never paste a diff into a prompt); it runs `harness review <id> approve` or reports a block (`harness block <id> "<reason>"`). Then `harness merge <id>`: merges into the feature branch, runs the integration checker and `verify.smoke` in the issue's worktree at the merge commit (both skipped for a docs-only diff); red rolls the merge back and blocks the issue.
6. **Blocked issues.** Read `.work/blocked/<id>.md`. If it points at a log file, dispatch `harness:utility` with the **log triage** job first and give the planner only its findings. Then dispatch the planner to resolve (re-slice, fix dependencies, settle the contract, update Decisions) — a re-queued issue must actually change; the identical-retry guard enforces it. A block about product behaviour or the direction itself goes to the user, in one question with a recommendation.
7. `harness integrate feature <F01>` when every issue is done: checker → project test/build → feature verify → smoke → runtime acceptance; human items are listed, never auto-closed. Green → dispatch the planner for the integration review (cross-issue assumptions, invariants, acceptance — not line-by-line). Then show the user the outcome against the feature's Outcome paragraph, with the human items; on acceptance `harness close feature <F01>` — done issues and the feature file are deleted, the feature branch merges into its base and is removed. A deviation from the outcome is re-planned (`/carve` on the running feature), not patched with ad-hoc issues. More work ahead after close is a new stage: a `/handoff` suggestion fits there.

## Evidence router
Whenever the next step needs facts and no decision — a long failing log, "who calls this", "is the rename complete", running acceptance commands and reporting what happened — dispatch `harness:utility` with the named job.

Parallel: dispatch several workers only when `queue next` lists several ids.

## Never
- Widen an issue's `touch`, edit a test to make a red gate green, or clear a violation by hand.
- Re-dispatch a worker on an unchanged blocked issue.
- Skip `harness finish`: a worker saying "done" is not evidence.
