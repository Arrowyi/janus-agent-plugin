## Protocol: code_plan_review

Apply this card in two stages: Stage 1 reviews the coder's L2/L3 `plan.md` before implementation; Stage 2 reviews the `git diff` after implementation. Report only correctness-affecting problems.

Baseline — the dispatcher supplies one of two, verbatim: the accepted `design.md`, or, for a standalone L2/L3 task with no design record, the approved design-gate text (goal, constraints, options, recommendation) with its exact approved file list, plus `plan.md`. If neither arrives verbatim, report the missing input and leave `resolved: false`; do not reconstruct a baseline from the diff alone.

Stage 1 — plan review:

1. Map each accepted decision in the baseline to a task in `plan.md`; a decision with no task is a missing task.
2. Map each interface or contract to a test; an interface with no test is an untested interface.
3. Check migration, compatibility, idempotency, concurrency, transaction, and failure-path coverage where the design names them.
4. Check that verification output supports the claims in the plan; an unrun command is not evidence.
5. Check that the plan is revertible in order and that a failed step has a safe stopping point.

Stage 2 — diff review (substantive correctness and contract defects only):

6. Check the diff stays inside the updated `Confirmed paths` and the accepted decisions; unrelated edits are scope creep. Close the loop on boundary, null, and error handling; on concurrency, idempotency, and migration safety; on interface compatibility; and on tests that actually prove the change. Structural defects count too: hand-edited generated output breaking the single source of truth, a query hiding side effects, swallowed exceptions masking failures, or one conceptual change missed across synchronized sites. Style preferences never gate the verdict.
7. Return `codePlanReview` with `verdict` (`pass` / `revise` / `block`), `deviations`, `missingTasks`, `untestedInterfaces`, `correctnessRisks`, `scopeCreep`, and `residualUncertainty`; set `resolved: true` only when no correctness-affecting problem remains.
