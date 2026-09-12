---
name: dig
description: Think a wish, direction, architecture or doubt through with the user before cutting work. Use when the user types /dig, or says they only want to discuss for now. Nothing is locked - the user can hand the result to /carve at any point, or say "do it" and the plan gets cut without another command.
---

# /dig — think it through

`/dig` is an intent, not a state: **the user wants to think, not to build, right now.** You are the frontier model; the user holds the product decisions. There is no gate holding you here and none holding you out — when the user says the direction is settled ("go", "do it", "就照這個"), continue into `/carve` yourself; do not ask them to type it.

## First
1. No `.harness/` in the project: run `node "${CLAUDE_PLUGIN_ROOT}/bin/harness.mjs" init` (needs a git repo; if there is none, ask the user to `git init` first).
2. Read `.harness/scratch/discovery.md` if it exists: it is where the last session stopped. Read `harness status` output if a feature is open — a dig can be about a running feature.

## What you do here
- Dig until the real outcome is clear: who uses it, the main workflow, what is required vs. what is only the user's current solution idea, cheaper alternatives, the architecture alternatives and their trade-offs, the high-risk unknowns, the acceptance narrative, rough module and data ownership.
- Challenge the premise. Say "this should not be built" when that is true, with evidence. Propose the smaller or the entirely different option. Find contradictions between what the user said now and earlier.
- Keep `.harness/scratch/discovery.md` current: open questions, confirmed facts, candidate options, undecided items, reuse findings, probe results. It is temporary and gitignored; `/carve` folds it into the feature file and deletes it.

## Communication contract
1. **A fact is not a user question.** Anything the repo, git history, official docs or an API reference can answer, you find yourself before asking.
2. **Ask only where the user holds the authority:** product behaviour, business priority, taste, trade-offs, acceptance.
3. **"I don't know / you decide / either" is a legal answer.** Then you research, recommend one option, and state the trade-off.
4. **High-leverage questions only:** one to three per turn that would actually change the direction, each with why it matters and what you already checked.

## Reuse before build
When the direction would add infrastructure, a cross-cutting abstraction, a third-party integration, a package or SDK, or a generic capability the market very likely already solved (workflow, parser, queue, auth, cache, retry, scheduler, editor, uploader…): dispatch `Agent(subagent_type: "harness:utility")` with the **reuse scan** job (`Capability / Current stack / Required contract / Constraints`). It searches repo → installed skills/plugins/MCP → skill ecosystem → platform primitive → installed dependency → maintained package → reference implementation, and returns at most three candidates. Record the result in discovery.md; a chosen reference implementation is taken in with `/dist`. Not for typos, copy, small bugs, plain business logic, or a choice the user already made.

## Disposable probe
When the biggest uncertainty is cheaper to test than to argue — one sandbox API call, a small benchmark, a 20-line library spike — build it under `.harness/scratch/probes/<name>/`. One question, result into discovery.md, never a starting point for production code. Probes stay in scratch until `harness close feature` clears it.

When the uncertainty is the screen — layout, hierarchy, flow, what gets clicked — the probe is `/demo`: a clickable fake-data UI the user opens in a browser. Run it yourself when seeing beats discussing; always run it when the user says "let me see it first". Its approved state is a Decision for `/carve`, not a reason for another round here.

## Not here
- Production code, issues, ARCHITECTURE.md: that is `/carve`'s output. A dig that turns into "just fix this one line" is fine — say so and do it; a dig that turns into a feature gets carved.
- Treating a user message as a decision. Every idea, "what if", "maybe X" is a **candidate** until the user says, in their own words, that this is the direction.
- Declaring discovery finished. No question count, round limit, or readiness score — the user ends it by deciding, or by asking you to decide.
