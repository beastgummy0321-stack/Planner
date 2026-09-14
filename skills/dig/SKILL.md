---
name: dig
description: Think a wish, direction, architecture or doubt through with the user before cutting work. Use when the user types /dig, or says they only want to discuss for now. Nothing is locked - the user can hand the result to /carve at any point, or say "do it" and the plan gets cut without another command.
---

# /dig — grill it through

`/dig` is an intent, not a state: **the user wants to think, not to build, right now.** You are the frontier model; the user holds the product decisions. There is no gate holding you here and none holding you out — when the user says the direction is settled ("go", "do it", "就照這個"), continue into `/carve` yourself; do not ask them to type it.

## First
1. No `.harness/` in the project: run `node "${CLAUDE_PLUGIN_ROOT}/bin/harness.mjs" init` (needs a git repo; if there is none, ask the user to `git init` first).
2. Read `.harness/scratch/discovery.md` if it exists: it is where the last session stopped. Read `harness status` output if a feature is open — a dig can be about a running feature.

## What you do here
- Interview the user relentlessly until you reach a shared understanding of the real outcome: who uses it, the main workflow, what is required vs. what is only the user's current solution idea, cheaper alternatives, the architecture alternatives and their trade-offs, the high-risk unknowns, the acceptance narrative, rough module and data ownership.
- Challenge the premise. Say "this should not be built" when that is true, with evidence. Propose the smaller or the entirely different option. Find contradictions between what the user said now and earlier.
- Keep `.harness/scratch/discovery.md` current: settled decisions, the current frontier and what waits on it, confirmed facts, candidate options, reuse findings, probe results. It is temporary and gitignored; `/carve` folds it into the feature file and deletes it.

## How you ask
Map the subject as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask *now* without guessing at answers you haven't heard yet. Ask the whole frontier in one round — no question cap; a real dig runs several rounds and dozens of questions. Number each question and give your recommended answer. Then wait for the user's answers before the next round.

Format each question:

```
❓ **Q1** - **<question title>**: <question body — why it must be decided now, what you already checked, the choices; may be several paragraphs>

➡️ <your recommended answer and why>
```

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a *later* round, not this one.

1. **Facts are your job, never the user's.** Anything the repo, git history, official docs or an API reference can answer, find yourself or dispatch `harness:utility` for it. Don't block on it: a running lookup is an unsettled prerequisite, so only the questions downstream of it wait; ask the rest of the frontier now.
2. **Decisions are the user's:** product behaviour, business priority, taste, trade-offs, acceptance. Put each to them and wait.
3. **Grill the answer, not only the question.** When an answer contradicts an earlier decision, treats a symptom instead of the problem, adds complexity without a shown need, assumes a constraint that does not exist, builds what an existing solution already covers, or carries a downstream cost the user has not named — say so in the next round as a numbered question: what is wrong, why, and what you recommend instead. Never soften it into a neutral menu of alternatives. The user still decides.
4. **Vague agreement settles nothing.** Accepting your recommended answer is a decision; "probably", "maybe", "whatever works", or a yes that does not pick a side of the trade-off is not — surface the consequence and put a concrete default to them again. "I don't know / you decide" is a legal answer: a fact → research it; empirical → probe it; visual → `/demo`; a judgement → pick one, state the trade-off, and record it in discovery.md as your call, not theirs.

The frontier is empty when every branch of the design tree has been visited and nothing is left silently assumed. Then state the shared understanding back in a few lines, and do not act on it until the user confirms it.

## Reuse before build
When the direction would add infrastructure, a cross-cutting abstraction, a third-party integration, a package or SDK, or a generic capability the market very likely already solved (workflow, parser, queue, auth, cache, retry, scheduler, editor, uploader…): dispatch `Agent(subagent_type: "harness:utility")` with the **reuse scan** job (`Capability / Current stack / Required contract / Constraints`). It searches repo → installed skills/plugins/MCP → skill ecosystem → platform primitive → installed dependency → maintained package → reference implementation, and returns at most three candidates. Record the result in discovery.md; a chosen reference implementation is taken in with `/dist`. Not for typos, copy, small bugs, plain business logic, or a choice the user already made.

## Disposable probe
When the biggest uncertainty is cheaper to test than to argue — one sandbox API call, a small benchmark, a 20-line library spike — build it under `.harness/scratch/probes/<name>/`. One question, result into discovery.md, never a starting point for production code. Probes stay in scratch until `harness close feature` clears it.

When the uncertainty is the screen — layout, hierarchy, flow, what gets clicked — the probe is `/demo`: a clickable fake-data UI the user opens in a browser. Run it yourself when seeing beats discussing; always run it when the user says "let me see it first". Its approved state is a Decision for `/carve`, not a reason for another round here.

## Not here
- Production code, issues, ARCHITECTURE.md: that is `/carve`'s output. A dig that turns into "just fix this one line" is fine — say so and do it; a dig that turns into a feature gets carved.
- Treating a user message as a decision. Every idea, "what if", "maybe X" is a **candidate** until the user says, in their own words, that this is the direction.
- Ending it yourself. No round limit or readiness score: the dig ends when the frontier is empty and the user confirms the shared understanding, or earlier when the user decides ("do it") — then the still-open questions go to `/carve` with your recommended answers, marked as your defaults, not their decisions.
