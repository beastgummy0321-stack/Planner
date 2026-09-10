---
name: crank
description: Execute ready issues one by one (or in safe parallel) through the control plane: claim, worktree, worker, machine gates, review, merge, smoke, integrate, clean up. Use only when the user types /crank. The main conversation routes; scripts schedule; workers implement; utility collects evidence.
disable-model-invocation: true
---

# /crank — control plane

The main conversation is the control plane: it calls `harness` scripts, dispatches agents, routes results. It never implements, never edits source, never reasons about scheduling — the scripts do. It never reads a long log itself — utility does.

CLI: `node "${CLAUDE_PLUGIN_ROOT}/bin/harness.mjs" <command>` (called `harness` below).

## First
Run `harness mode work`. It also recovers leases left by a dead session (issue re-queued, partial diff saved under `.harness/runtime/logs/`): tell the user which, then continue.

If it refuses with `Independent Challenge needed` (none this round, the last one never returned a verdict, or the plan changed after its CLEAR), recover without the user: the mode is still plan, so dispatch `Agent(subagent_type: "harness:challenger")` on the draft on disk exactly as /carve does — only the user-confirmed outcome (one paragraph, from `.work/PLAN.md` / the feature ticket, never the planner's reasoning), the paths of `ARCHITECTURE.md`, `.work/PLAN.md`, `.work/tickets/`, `.work/ready/`, and the CLI path; the challenger signs its verdict itself with `harness challenge <CLEAR|CHALLENGE>`. On CHALLENGE dispatch `harness:planner` once to fix the draft and run `harness validate`; a product or architecture disagreement stops here: "this needs /dig". Then run `harness mode work` again. One challenge round per /crank; if it refuses again for the same reason, show the reason and stop.

Any other refusal (no user prompt, violations, invalid manifest): show the reason and stop.

Bash in the main conversation is limited to `harness` commands and read-only git; anything else is denied before it runs.

## Loop until `harness queue next` is empty and nothing is in doing/
1. `harness queue next` — claimable issues (dependencies done, no touch overlap with active leases, dependency-changing issues alone).
2. `harness claim <id>` — atomic ready/ → doing/, lease created. If it says `identical retry refused`, the blocked issue was re-queued unchanged: go to step 6, never re-dispatch.
3. Dispatch the worker: `Agent(subagent_type: "harness:worker", isolation: "worktree", prompt: <below>)`.
   Prompt = exactly: `Issue <id>. First run this command verbatim and read its output: node "<absolute plugin path>/bin/harness.mjs" attach <id>` plus one line: "Implement only what the issue says. Bash is limited to the listed commands. When done, report in under ten lines: files changed, verify pass/fail per command, anything that blocked you." Nothing else.
4. When the worker returns: `harness finish <id>`. Order: scope post-diff → container checker (imports + ownership + legacy) → issue verify → typecheck/build. Green → prints `review: none|planner`. Red → the issue is in blocked/ with evidence and the worktree is discarded; go to step 6.
5. If `review: planner`: dispatch `harness:planner` with the issue path and the CLI path (it runs `harness diff <id> --stat` and reads what it needs — never paste a diff into a prompt); on approve the planner itself runs `harness review <id> approve` (hook-signed receipt for the current head); then `harness merge <id>`. Block → `harness block <id> "<reason>"`. Otherwise `harness merge <id>` directly. Merge runs the integration checker and the manifest's `verify.smoke` in the issue's worktree at the merge commit (never in the main tree; both skipped for a docs-only diff); red rolls the merge back and blocks the issue.
6. **Blocked issues.** Read `.work/blocked/<id>.md`. If it points at a log file (`dispatch harness:utility to triage`), dispatch `Agent(subagent_type: "harness:utility")` with the **log triage** job first and give the planner only its findings. Then dispatch the planner to resolve (re-slice, fix dependencies, rewrite the ticket) — it edits `.work/**` only; a re-queued issue must actually change, the identical-retry guard enforces it. If the block is about product behaviour, ownership, architecture direction, or the plan being wrong, stop and tell the user: "this needs /dig".
7. `harness integrate ticket <F01-T01>` when a ticket's issues are all done: machine verify → checker → the ticket's `runtime` acceptance. Green → dispatch the planner for the integration review (cross-issue assumptions, invariants, acceptance — not line-by-line). Approved → if the ticket has `human` items, show them to the user and wait; then `harness close ticket <F01-T01>`. Blocked → the planner files new issues; continue.
8. `harness integrate feature <F01>` when all tickets are closed: checker, tests, build, smoke, and the collected human items. Show the user the feature against the direction confirmed in /dig and ask for acceptance. Accepted → `harness close feature <F01>`. A deviation from the confirmed direction goes back to /dig, not into more issues.

## Evidence router
Whenever the next step needs facts and no decision — a long failing log, "who calls this", "is the rename complete", running a ticket's runtime commands and reporting what happened — dispatch `harness:utility` with the named job. The planner and the main conversation never spend tokens on evidence collection.

Parallel: dispatch several workers only when `queue next` lists several ids.

## Never
- Implement anything yourself or edit files outside `.work/**`.
- Widen an issue's `touch`, relax a gate, edit a test to make a red gate green, or clear a violation by hand.
- Re-dispatch a worker on an unchanged blocked issue.
- Skip `harness finish`: a worker saying "done" is not evidence.
