# Harness v3 — shared design

A planning capability, a Feature → Issues queue, and a scoped executor. The user controls scope; host permissions remain authoritative. WORKFLOW.md is the execution policy. This document explains the design; it is not a prerequisite read for every task.

## Boundaries
Small reversible work uses the direct path. Queued work uses one feature branch and one worktree per issue. Architecture is optional. Unsupported checkers are disclosed. Hook compatibility covers normalized shell, patch/file edits and agent dispatch; Git diffs are not a process sandbox.

Authorization is explicit and scoped, never inferred from message timestamps. Main can record an already-authorized implementation without another question. Sensitive/external actions retain their own permission boundary. A paused feature revokes further dispatch; Main must stop running host workers safely.

## State and evidence
- `.work/features/` holds Outcome, Decisions and Acceptance; queue folders hold issue state.
- `ARCHITECTURE.md` is an optional JSON-frontmatter contract plus current explanatory prose.
- `.harness/` holds temporary probes, leases, scoped authorization and verification evidence.
- Workers receive only the relevant issue/module context. Prototypes are referenced only when the feature names them.
- Ordinary red checks retain work for repair. Scope violations block; failed attempts preserve evidence. Retry identity includes the implementation base, not just plan prose.
- Foreign sessions remain active/unknown until the operator confirms they ended. Control-plane mutations must not race in-flight worker shell baselines.
- Final integration receipts bind code, feature/architecture content and issue state. Required human acceptance is recorded explicitly at close. Local closure is automatic only inside existing authorization.

## Verification
Run the cheapest effective checks, deduplicate identical commands within a gate, and retain integration checks where combining changes creates new risk. Passed checks are not repeated merely because a stage name changed. Runtime commands terminate and have bounded execution; service lifecycle belongs in a readiness-and-cleanup wrapper. Tests use temporary repositories; host-level behavior still needs native validation.

`verify.smoke_after_build` optionally runs the same smoke coverage without rebuilding, only during integration after a successful `verify.build` in the same checkout. It requires both `build` and the standalone `smoke` fallback. Merge always uses standalone smoke. Integration runs typecheck → build → full test → feature extras → smoke → runtime extras. Identical checker/verify commands are deduplicated; shell equivalence is not guessed.

Failed integration saves only the successful machine-stage prefix in ignored runtime state. `integrate feature <id> --resume` may reuse it for one hour when HEAD, tracked source, feature/issue state, commands, environment variables and runner code match. The checker and runtime acceptance run again; a partial checkpoint never permits close. Optional `verify.build_outputs` lists relative build output files/directories (no globs); missing, changed, empty or unreadable outputs force build and later stages to run again. Without declared outputs, build is never reused. Use normal integration after dependency reinstall, database/service reset, or any uncertain external-state change; `--resume` asserts those untracked prerequisites are unchanged. Successful integration removes its checkpoint.

The prose fast path is limited to root README/CONTEXT/PRODUCT/CLAUDE/AGENTS and Markdown/text in docs/. Runtime prompts, assets and ARCHITECTURE.md run normal gates. Documentation maintenance is the bounded Stage closeout in WORKFLOW.md; it is an agent responsibility, not a filesystem-mutating hook or a new report format.

## Attribution
The handoff carrier/read-back ideas were adapted from https://github.com/duoduoler-ops/Table-skills `project-handoff` @ ca51a81 (MIT, copyright 2026 duoduoler-ops). The design-tree questioning idea was adapted from https://github.com/mattpocock/skills `grilling` (MIT, copyright 2026 Matt Pocock). v3 removes mandatory question breadth and session-switch cadence from normal task flow.

Optimization reference: https://developers.openai.com/blog/rethinking-skills-and-prompts-for-gpt-6-astra — precise triggers, contextual reading, proportionate verification, explicit completion and authority. Shared instructions remain usable by Claude and Codex; model names and native APIs are host configuration.
