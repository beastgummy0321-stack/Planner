---
name: retro
description: End-of-session workflow correction. Use when the user types /retro, says "覆盤 / 這次哪裡卡 / review how this session went", or is wrapping up a session that had friction with the harness workflow itself. It looks only at what actually happened this session, finds root causes, and changes the workflow only when a reusable root-cause failure is proven. Not a lessons-learned journal, not a place to add rules.
---

# /retro — correct the workflow only when the session proved it wrong

`/retro` is a judgment, not a deliverable. **Never optimize the workflow merely because a session ended.** Most sessions end with `NO WORKFLOW CHANGE REQUIRED`, and that is the correct output. A positive change means: the same mistake becomes less likely next time, without adding process, cognitive load or maintenance cost.

The trap this guards against is rule accretion — one rule today, one exception tomorrow, one command the day after — until the workflow is a pile of historical debt. Execute → notice friction → find the root cause → decide whether it is the workflow's → smallest fix → the next session verifies it naturally. Not: execute → must find a problem → must write a lesson → must update a file.

## Do
1. **Collect only what actually happened this session.** Which moments cost result quality, time, communication or a decision? No forecasting of future scenarios; nothing gets a defence because it "might happen".
2. **Trace each symptom to its root.** Decide which it is: a missing principle · unclear responsibility boundary · wrong decision order · broken information flow · incomplete feedback loop · two rules in conflict · friction the workflow itself creates · or a one-off execution error. A one-off execution error does not change the workflow.
3. **Classify:** one-off execution problem · local problem · fundamental workflow problem. Only the third one is, in principle, worth a change.
4. **Fix upstream, not downstream.** If one principle fixes several symptoms, change that principle. Never a rule per special case. Order of preference: delete a wrong rule → correct an existing principle → merge duplicates → only then add.
5. **Reverse-check the fix.** Does it add a document, a rule, a special case, decision load for the agent, or limit autonomy that was reasonable? Does it treat a symptom rather than the root? If yes, simplify again or drop it.
6. **Land it or drop it.** A real fix is the smallest edit to the existing principle (`SPEC.md`, a `skills/*/SKILL.md`, an `agents/*.md`, or the project's `CLAUDE.md`). No retro file, no journal, no lessons-learned document: the change itself is the record, git is the history.

## Not without proof from this session
New Markdown or SOP documents · settings or parameters · state machines · abstraction layers · commands · hooks · metadata · schemas · special-case branches · a permanent mechanism for a single case · a simple principle split into many rules. A "complete" workflow is not the goal; the fewest principles that let the agent decide correctly are.

## Output (answer only this)
```
【實際問題】  what really hurt result, efficiency, communication or a decision this session
【根因】      the underlying cause once symptoms are stripped away
【是否值得修改工作流】  one-off · local · fundamental
【最小修正】  the smallest edit that removes the root cause (existing principle first)
【反向檢查】  documents / rules / special cases / decision load / autonomy / symptom-only — re-simplify if any is hit

KEEP    what proved to work; leave alone
FIX     the root problem and its minimal correction
REMOVE  existing design this session proved redundant, wrong, duplicated or frictional
```
If nothing qualifies, output only: `NO WORKFLOW CHANGE REQUIRED`.
