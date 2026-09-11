---
name: prototype
description: Build a clickable, fake-data UI prototype the user can open in a browser and react to, before any real implementation. Use when the user types /prototype, says "let me see it first / 先做一版可以點的 / 先給我看畫面", or when the biggest unknown of a feature is layout, hierarchy, flow or interaction rather than data or architecture. It is a disposable probe, not a lifecycle stage.
---

# /prototype — show it before building it

`/prototype` is an intent: **the cheapest way to settle a visual or interaction question is to click it.** It is a disposable probe (see `/dig`) specialised for UI. Nothing precedes it and nothing has to follow it: the user reacts in plain language, you revise in place, and when they say it is right the direction continues into `/carve` without another command. You may also decide on your own that a feature's real risk is the screen, say so in one line, and run this.

## What it is
- Lives in `.harness/scratch/prototype/<slug>/` (gitignored). It stays there — as the visual reference for the workers — until `harness close feature` clears scratch.
- **Opens by double-click.** One self-contained `index.html` (inline CSS/JS; a CDN script for Tailwind or a tiny view library is fine). No dev server, no build, no install.
- **Clickable end to end.** Every path the user would walk is walkable: navigate, open a row, edit, save, delete, empty state, error state. Persist only in memory.
- **Deterministic fake data.** Hard-coded, realistic, the same on every load. "Save" is `setTimeout` + toast, never a request.
- **Inherits the project's look.** If the repo has components, tokens, a DESIGN.md, or shipped screens, read them and reproduce their language (colours, type, density, component shapes). Never import from the project; never invent a second identity next to an established one.
- **One version by default.** Build the best single answer to what is known. Revisions are edits to that version. Produce alternatives only when the user explicitly asks for N directions.

## What it is not
- Not production code, not a starting point for it, never copied into `src/`. Workers implement from the feature's Decisions with the prototype as a reference to look at.
- No backend, API, auth, payment, migration, real DB, real `.env`. If the user asks to "wire it up", that is `/carve`.
- No queue, state file, approval JSON or CLI. Approval is the user saying so.

## Do
1. No `.harness/`: `node "${CLAUDE_PLUGIN_ROOT}/bin/harness.mjs" init` first (git repo required).
2. Collect the direction: the conversation, `.harness/scratch/discovery.md` if it exists, and the repo's existing UI language (a quick look, not an audit).
3. Dispatch `Agent(subagent_type: "harness:prototyper")` with: the slug, the target path, the outcome in one paragraph, the screens and flows to cover, the fake-data shape, and what the existing UI looks like (or "no established UI"). Do not build it in the main conversation.
4. When it returns: tell the user the file path to open, the flows that work, and the choices it made that are theirs to overturn. Ask nothing else.
5. Record in `discovery.md`: prototype slug and path, what was shown, what the user changed, what they approved. Revisions go back to the prototyper as a diff of instructions ("sidebar out, main action first, keep the rest").

## Skills are capabilities, not a checklist
Installed UI skills (an Impeccable-style critique, a design-direction generator, an art-direction skill, a component kit) are inputs the prototyper may use. Pick at most one for direction and at most one critique pass; never chain them because they exist. Established project UI → use none. New product UI with no direction → one direction pass, then build. Brand or landing page → art direction first, then build.
