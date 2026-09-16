# Shared execution contract

Use this contract when planning or running a feature queue. Discussion, read-only reviews, and small local fixes do not require a queue, architecture inventory, subagent, or initialization.

## Authority
The latest user request controls scope. Existing decisions supply context, not permission. A request to implement authorizes necessary local edits and disposable local checks in that scope; record it once with `harness authorize <feature> "<user instruction and scope>"`. Asking a question or sending a later message is not approval. On pause or withdrawn authorization, stop dispatch and run `harness revoke <feature>`; ask the host to stop active workers at a safe point.

Explicit permission is still required for publishing/pushing, production mutations, paid actions, exposing credentials, destructive changes to user work, and scope expansion, unless already granted for that exact action. Preparation and read-only inspection may proceed. The harness cannot authenticate the user's intent: the orchestrator records authorization honestly and host permissions remain authoritative.

## Size the workflow
- Small, clear, reversible local task: implement directly and run the relevant check. Do not create feature files solely to satisfy process.
- Multi-step work that benefits from isolation, dependency scheduling or resumption: use Feature → Issues. One feature has one outcome and one branch. Workers use linked worktrees and declared `touch` minus `do_not_touch`.
- Independent review is for material interface, ownership, security, data or integration risks. Delegate only when available and the isolation or parallel work earns its cost; simple planning and evidence lookup may stay in the main conversation.

## Reading and completion
Read the affected code and the contract needed for the next decision. Consult ARCHITECTURE.md only for module/interface/ownership changes. Read logs around the first failure; delegate large triage only when useful. Define observable completion and the cheapest effective verification before implementation. Finish authorized work through relevant verification and correction; stop when acceptance is satisfied or a concrete blocker needs outside input.

## Verification and repair
Workers run targeted checks while developing. `finish` performs the authoritative issue checks once per invocation; identical commands within that invocation are deduplicated. Merge checks cover the combined tree, so they are not automatically interchangeable with issue checks. Feature checks cover the final outcome. Rerun affected checks after relevant code, command, dependency or environment changes. Never reuse a green report against a different tree.

Update tests when the approved behavior changes; do not weaken assertions to conceal defects. Mutation testing is optional for critical logic or uncertain test sensitivity. State unverified manual items honestly. Ordinary in-scope failures retain the worktree for repair; scope violations and unresolved decisions are blocked. Stop repeated attempts when they provide no new evidence. Privileged generators/migrations run only with the required authorization and are never placed in repeatable verify lists.

## Host integration
Resolve the plugin's absolute path from the loaded skill location or host-provided plugin root; invoke `node "<plugin>/bin/harness.mjs"`. Do not rely on shell-specific variable expansion in prose commands. Run the CLI in the target project/worktree, not the plugin checkout.

Claude Code can dispatch its named agent profiles. Codex or another host may dispatch a native worker with the relevant `agents/<role>.md` body; Claude frontmatter is host metadata, not a Codex tool schema. Inherit the active model unless the user configured a role-specific choice. `harness worktree <issue>` provides a host-neutral worktree; every worker must run `attach` in that directory. If native isolated workers are unavailable, the same agent may execute sequentially in that worktree under the same checks; do not claim independent review in that fallback.

Tool hooks are guardrails, not an OS sandbox. Unsupported tool paths and missing host hooks require disclosed limitations and the CLI's final scope checks; do not claim full isolation from Git diffs alone.
