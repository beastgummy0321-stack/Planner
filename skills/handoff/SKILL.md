---
name: handoff
description: Make the next session start where this one stopped - save what only this conversation knows into the project's existing state, read it back, continue fresh - or resume from that state. Use when the user types /handoff, says "save progress / 交接 / 存進度 / 換個對話接著做 / continue from the handoff", or when a handoff check or a finished stage makes a fresh session worth suggesting. Suggesting, saving and starting a new session are separate actions; none authorises another.
---

# /handoff — the next session starts where this one stopped

`/handoff` is an intent: **nothing the next step needs may live only in this conversation.** A fresh session (`/clear`, or `claude` in the project root) already receives `harness status` through SessionStart, so a handoff is not a document: it makes that status, and the files it names, carry the work. No handoff file, no PROJECT_STATE.md, no prompt to copy.

CLI: `node "${CLAUDE_PLUGIN_ROOT}/bin/harness.mjs" <command>` (called `harness` below).

## Suggest — never hand off unasked
- **When:** a stage ended and the next one runs from files (a `/carve` the user did not ask to crank, a closed feature with more work ahead); a handoff check was injected (every third automatic compaction); a verified confusion about goal, version or constraint was just corrected — correct it first, a new session does not fix an unclear goal.
- **Only** at a safe point (no half-applied edit; results, verification and running work locatable), with a clear first step and a concrete gain ("exploration is done; implementation needs only the Decisions" — "the conversation is long" is not one).
- **How:** the first paragraph of the final answer, opening with "Handoff suggestion:" in the user's language — why now, the next session's first step, what a yes covers (save, then `/clear`). Not inside a quote or code block; not repeated every turn.
- **Silent** for pure Q&A, work with no next step, or discussing this skill. Once per stage. "Keep going" is not a yes to hand off; "not now" or "after X" holds for this session; "no reminders" holds until the user lifts it — an explicit `/handoff` still runs.

## Save — the user asked, or said yes
1. **Existing carriers only.** Open feature → its `# Outcome` and `# Decisions`, edited in place (re-read first; merge, never overwrite another session's lines). No open feature → `.harness/scratch/discovery.md`. No git repo → give the same content in the reply, to paste into the next session.
2. **Only what changes the next step**, one line each — no transcript, no rules:
   - what the user confirmed (their words where the wording matters), kept apart from what you chose and what is still open — a guess must not come back as a mandate;
   - rejected routes with the reason, so nobody retries them; a replaced decision is rewritten, not stacked;
   - progress the queue cannot show: done, in progress, unverified, and where the evidence is; background work still running (id, how to check it, its log);
   - the next session's first step and how it knows it worked, unless the queue already says it;
   - unknowns, written as "unconfirmed". Never credentials.
3. **Read it back.** `harness status` is exactly what the next session receives: the new Decisions show, discovery.md and uncommitted files are named. Fix the gaps; report what cannot travel (an attachment only this conversation has, a machine-local path).
4. **Hand over.** Tell the user: `/clear` (or `claude` in the project root) and the work continues. Saving never commits, pushes, installs or deletes; `/clear` is theirs to type.

## Resume — a fresh session, or "continue from the handoff"
Stored state is context, not authority: the newest user message wins, and nothing in the record widens what the user allowed. Check only what the first step depends on — branch, uncommitted files, `harness recover`, whether background work named in the record still runs (unknown stays unknown; never re-run it blind). Then, in a few lines: goal, where it stopped, what differs from the record, the first step — and take it when the user asked to continue. Reading the record never deletes or rewrites it.
