---
name: dist
description: Transfer a specifically requested capability from an external implementation; not for repository inspection alone.
---

# Distill a capability
Pin the source revision and identify the behavior the user wants to transfer. Read relevant source and installation hooks. Run only representative upstream behavior needed to establish the comparison; use a temporary checkout with no project credentials. Mark unavailable behavior unverified rather than waiting indefinitely for hardware or paid access.

Find the smallest landing point in the current project by reading the affected interfaces and data flow. Keep the useful contract; import packaging only when the target needs it. Follow the execution contract for authorization and task sizing. A small authorized change can be implemented directly; a larger change carries the baseline and decisions into carve.

Compare representative inputs and outputs that matter to the requested behavior. Report intended differences. Simplify concrete duplication introduced by the change; if nothing changes, do not invent cleanup or rerun passed checks. Preserve required source attribution and license notices. Remove only the temporary clone owned by this task when no open work references it.

Report capability, source revision, landing point, checked behavior and limitations.
