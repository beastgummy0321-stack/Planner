# Shared execution contract

Use this contract when planning or running a feature queue. Discussion, read-only reviews, and small local fixes do not require a queue, architecture inventory, subagent, or initialization.

## Authority
The latest user request controls scope. Existing decisions supply context, not permission. A request to implement authorizes necessary local edits and disposable local checks in that scope. For a feature queue, present its concrete outcome, scope, issue sequence and verification before the first issue; obtain plan approval once unless that unchanged plan is already approved or the user explicitly waived the checkpoint. Record execution permission once with `harness authorize <feature> "<user instruction and scope>"`. Asking a question or sending a later message is not approval. On pause or withdrawn authorization, stop dispatch and run `harness revoke <feature>`; ask the host to stop active workers at a safe point.

Explicit permission is still required for publishing, production mutations, paid actions, exposing credentials, destructive changes to user work, and scope expansion, unless already granted for that exact action. Preparation and read-only inspection may proceed. Git push is performed manually by the user. Agents and plugins do not run push, enable auto-push, or create push hooks; commit, merge and close remain local. Before the first local Git mutation, inspect active hooks for external side effects and prevent automatic push while preserving required local checks. The harness cannot authenticate the user's intent: the orchestrator records authorization honestly and host permissions remain authoritative.

## Size the workflow
- Small, clear, reversible local task: implement directly and run the relevant check. Do not create feature files solely to satisfy process.
- Multi-step work that benefits from isolation, dependency scheduling or resumption: use Feature → Issues. One feature has one outcome and one branch. Workers use linked worktrees and declared `touch` minus `do_not_touch`.
- Independent review is for material interface, ownership, security, data or integration risks. Delegate only when available and the isolation or parallel work earns its cost; simple planning and evidence lookup may stay in the main conversation.

## Reading and completion
Read the affected code and the contract needed for the next decision. Consult ARCHITECTURE.md only for module/interface/ownership changes. Read logs around the first failure; delegate large triage only when useful. Define observable completion and the cheapest effective verification before implementation. Finish authorized work through relevant verification and correction; stop when acceptance is satisfied or a concrete blocker needs outside input.

## Verification and repair
Workers run targeted checks while developing. `finish` performs the authoritative issue checks once per invocation; identical commands within that invocation, including the configured checker, are deduplicated. Explicit manifest issue profiles may narrow project typecheck/build for changes wholly inside their declared paths; interface changes and unmatched files retain full defaults. Keep required issue tests, checker, merge smoke and full feature integration. Use typecheck_before_test only to omit a subset proven covered by the immediately following full test suite. Keep one canonical command spelling; do not infer equivalence by splitting shell command strings. Merge checks cover the combined tree, so they are not automatically interchangeable with issue checks. Feature checks cover the final outcome. Rerun affected checks after relevant code, command, dependency or environment changes. Never reuse a green report against a different tree.

Update tests when the approved behavior changes; do not weaken assertions to conceal defects. Mutation testing is optional for critical logic or uncertain test sensitivity. State unverified manual items honestly. Ordinary in-scope failures retain the worktree for repair; scope violations and unresolved decisions are blocked. Stop repeated attempts when they provide no new evidence. Privileged generators/migrations run only with the required authorization and are never placed in repeatable verify lists.

## Stage closeout: bounded documentation maintenance
Run one scoped closeout at the end of dig, carve, crank, or a direct fix only when this task created a lasting decision or changed documented behavior. Read-only/discussion-only scope permits a response summary, not file edits. No durable change means no documentation work.

- Dig: update an existing discovery/candidate only when persistence helps the next step; distinguish confirmed decisions, assumptions and open questions. Do not create a transcript or a new report for every discussion.
- Carve: place each settled rule in its existing authoritative document. Keep Feature Decisions to shared constraints plus specific conditional references; put quotations, probes and historical handoffs under a separate top-level Evidence section, excluded from attach. Issues contain only their additional context and checks. Update the nearest index only when a page is added, moved or retired.
- Crank/direct fix: reconcile the affected docs with implemented behavior and actual verification. Check changed references and their inbound links once. Consolidate exact duplicates only after preserving unique evidence and unresolved scope; delete an absorbed candidate only when nothing unresolved remains. Preserve open acceptance and other tasks' scratch. Feature close remains subject to its integration receipt and genuine human acceptance.

Use existing pages and Git history; no mandatory daily log, closeout report, archive copy, global inventory or new approval stage. If something unrelated is stale, use the existing backlog only when actionable rather than expanding this task. A document is split only at a useful reading boundary and its old full text is removed. Finish this pass once; it must not trigger another pass. Report changes and material limitations in the normal completion response. No permission renewal for already-authorized local maintenance; security, paid/external actions and destructive changes to user work retain the Authority rules.

## Host integration
Resolve the plugin's absolute path from the loaded skill location or host-provided plugin root; invoke `node "<plugin>/bin/harness.mjs"`. Do not rely on shell-specific variable expansion in prose commands. Run the CLI in the target project/worktree, not the plugin checkout.

Claude Code can dispatch its named agent profiles. Codex or another host may dispatch a native worker with the relevant `agents/<role>.md` body; Claude frontmatter is host metadata, not a Codex tool schema. Inherit the active model unless the user configured a role-specific choice. `harness worktree <issue>` provides a host-neutral worktree; every worker must run `attach` in that directory. If native isolated workers are unavailable, the same agent may execute sequentially in that worktree under the same checks; do not claim independent review in that fallback.

Tool hooks are guardrails, not an OS sandbox. Unsupported tool paths and missing host hooks require disclosed limitations and the CLI's final scope checks; do not claim full isolation from Git diffs alone.
