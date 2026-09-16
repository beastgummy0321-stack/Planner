---
name: carve
description: Plan a feature and its issues when implementation needs a queue, or revise an existing feature plan.
---

# Carve
Read [the execution contract](../../WORKFLOW.md) when entering queued work; reuse it within the session.

Start from the latest request and relevant confirmed decisions. Read discovery only to recover missing context; read the current feature and affected issues for a re-plan. A small local change takes the direct path. Initialize the harness only when creating a queue.

Plan locally, or delegate using the planner role when the work benefits from a separate context. Use an existing UI as the direction; prototype only if a material visual uncertainty is cheaper to test than decide. Inspect local helpers, installed dependencies and platform primitives before an external reuse search; stop when a suitable option is established.

Create/update ARCHITECTURE.md only when module boundaries or ownership matter. Use `harness validate` for its schema. If a supported checker is needed, `adapter plan` shows the change. Existing authorization covering that exact local dependency/config change suffices for `apply --approved`; otherwise present it with the plan once. Apply already checks; run prove only for new or materially changed checker behavior. An unsupported adapter is a disclosed limitation, not a planning prerequisite.

Write one `.work/features/F01.md` with JSON frontmatter `id, title, branch, verify[], runtime[], human[], closed:false` and Outcome, Decisions, Acceptance sections. Decisions distinguish user-confirmed constraints from agent choices and unresolved questions. Runtime commands must terminate; boot services with readiness checks and cleanup. Human items are only judgments that actually require a person.

Write `.work/ready/F01-I01.md` with `id, feature, after[], touch[], do_not_touch[], verify[], privileged[], review, interface_change` and Objective, Done, Verify, Blocked if sections. Optional `deps[], legacy_migration, group` describe actual changes. Include affected tests in touch. Use `review: planner` for material public-interface, schema, permission, money, ownership or dependency risks. A worker must not have to invent an unresolved product or interface decision. Split at meaningful ownership, dependency, rollback or verification boundaries; same context and verification usually stays together.

For frontend/backend parallel work, settle the shared semantic contract first; use a fake adapter only where it enables useful independent work. Do not force every feature into frontend/backend/wiring issues.

Run validate once after the coherent plan is written. Request one independent challenge only for unresolved high-impact assumptions; ordinary review flags do not automatically require it. Share the concise outcome, scope and unresolved decisions. If implementation is already authorized and no material question remains, record authorize, start the feature, and continue with crank in the same turn. Otherwise stop at the requested planning boundary. Delete discovery only after its useful content is preserved.
