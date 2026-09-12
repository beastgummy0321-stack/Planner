---
name: dist
description: Distill an external (GitHub, open-source) project's capability into the current project - capability transfer, not architecture transfer. Use when the user types /dist, or wants to bring in, port or borrow what an outside repo does ("蒸餾 / 導入 / 參考這個 repo 的做法"), or a reuse scan picked a reference implementation. Run the original, extract the capability, fit it into existing paths, validate against the original, then delete again.
---

# /dist — capability transfer, not architecture transfer

`/dist` is an intent: **this project gains what an outside project does, as if it had always belonged here.** The outside repo is a *reference implementation* to learn from, never a component to install. Ask "what is this repo's most valuable capability, and what is the smallest change to our system that yields the same behaviour?" — not "how do we fit this repo in?"

Run → Understand → Extract → Fit → Validate → Simplify.

## 1. Run the original
Clone it at a pinned commit into `.harness/scratch/probes/<repo>/` (a temp directory when the project has no `.harness/`). Read install scripts and hooks before running them; this project's credentials stay out of the run. Read, run and test it until you can state, from observed behaviour rather than the README:
- the problem it actually solves, and its input → processing → output;
- which behaviours are essential and which are the author's framework, CLI, config, UI or habits;
- which dependencies are core and which can go; which edge cases are real needs and which are historical baggage.

Keep the representative inputs and their observed outputs: they are the *baseline* for step 5. Done when every claim in step 2 points at something you saw run; what could not run (credentials, paid service, hardware) is marked unverified.

## 2. Extract the capability
Split what you saw into **capability** — core algorithm, key data flow, necessary contract — and **packaging** — framework wrapper, project layout, CLI, state management, configuration, adapters, abstractions, compatibility layers. Keep the capability. Packaging comes along only when this project needs the same thing for a reason of its own; upstream having it is not one.

## 3. Find the landing point
Read the current project first: its data structures, flows, abstractions, utilities, agent decision points, commands, tools, APIs. Extend an existing path; extend an existing concept rather than naming a second one. When the capability conflicts with the project, fix upstream, in this order: delete a wrong or stale rule → correct the root principle → merge duplicates → simplify the data flow or responsibility boundary → only then add. One principle that resolves several conflicts beats one exception per conflict.

## 4. Implement the smallest distillation
Only what the goal needs: a little direct code, small edits to existing modules, this project's conventions, room left for the agent's judgment. When 100 clear lines here replace 1000 upstream, write the 100 — unless the cut loses a behaviour the baseline shows matters. Credit the source where the capability lands, as SPEC.md §6 credits Table-skills: URL @ commit, licence and copyright notice when the licence requires it, what was deliberately not carried and why.

Size picks the route: a change you can finish and verify in this session is done here; a feature-sized one hands steps 1–3 (capability kept, packaging dropped, landing point, baseline) to `/carve` as Decisions, with the baseline comparisons as `verify`.

## 5. Validate against the original
Feed the same representative inputs to Original and Distilled. The core results match, the essential behaviours hold, no important edge case is lost, no unneeded side effect appears. Internals may differ freely; only the external behaviour we need must hold. A difference you chose is named in the report; one the user may depend on is their call.

## 6. Delete again
Integration is not the last step; simplification is. Look once more for a dependency that can go, a wrapper that exists only for the integration, a duplicated data structure, an old and a new flow side by side, a setting nobody needs, logic that folds straight back into an existing module. Remove them, re-run step 5, and delete the scratch clone unless an open feature names it as a reference.

## The bar for every change
Each change makes the system better in at least one way: simpler · clearer · fewer steps · less rework · fewer misjudgments · easier for the agent to decide correctly on its own · easier for the user to step in at a key point. A change that only adds control, rules, text, state or maintenance without removing a root cause is dropped. Documents, SOPs, settings, state machines, abstraction layers, commands, hooks, metadata, schemas, special-case branches and single-case mechanisms enter only when a problem in this session proved them necessary. One principle the agent understands beats ten mechanical rules.

## Report (answer only this)
```
【能力】            what the original really does, from what ran (unverified parts marked)
【帶走 / 不帶】      capability kept · packaging dropped, one line each
【落點】            the existing path it now lives in
【Original → Distilled】  per representative input: match, or the chosen difference
【再刪除】          what step 6 removed
```
