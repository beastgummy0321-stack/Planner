---
name: crank
description: Execute an authorized feature queue, or resume its unfinished work.
---

# Crank
Use [the execution contract](../../WORKFLOW.md) once on entry.

Read status to locate the current feature and leases. Another session ID is not evidence of death. Run `recover --ended-session <id>` only after confirming that host session and its workers ended. Otherwise leave their leases alone.

1. Check execution authorization against the current user request. Record existing permission with authorize; a user pause revokes it. Start the feature branch. Commit only the reviewed plan/checker files needed by its workers, as part of authorized local queued execution; leave unrelated user changes untouched.
2. `queue next <available-slots>` selects nonconflicting work (default total concurrency: 2). `claim <id>` then `worktree <id>` prepares the isolated directory. Dispatch with the worker role, issue id, absolute CLI path and worktree path. Run attach there first; its output carries relevant context. Use the host's tools, not a copied Claude API signature.
3. Run `finish <id>`. A repairable failure keeps its worktree; return concrete evidence to the same worker. A scope violation blocks. If repair requires a new product decision or wider scope, report it to the planner/user. Repeated failure without new evidence stops the attempt.
4. For `review: planner`, review the current diff and record `review <id> approve`; a changed head invalidates that receipt. Merge only after required checks pass. Before a merge or main-tree re-plan, wait for in-flight worker shell calls to finish; do useful read-only work while waiting. A failed merge/integration check is investigated using its evidence.
5. When no issue is runnable, inspect waiting/active/blocked: wait for active work, resolve a concrete blocker, or report a dependency deadlock. An empty candidate list is not completion. Do not poll without a relevant state change.
6. Once all issues are done, `integrate feature <id>`. Review only remaining material cross-issue assumptions. If required human judgments remain, present them once; record their explicit acceptance through `close feature <id> --human-approved`. With no human items and local merge/cleanup already in scope, close immediately and report the verified outcome. Close requires a fresh successful integration receipt.

Do not enlarge scope or clear violations to force green. Preserve user work and evidence. Long logs may be triaged locally or delegated; do not dispatch an extra agent for a short error. Report actual test results and any remaining limitations.
