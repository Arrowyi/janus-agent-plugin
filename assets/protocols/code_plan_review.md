## Protocol: code_plan_review

Apply this card to the coder's L2/L3 `plan.md`, and after implementation to the `git diff` against the accepted `design.md`. Report only correctness-affecting problems.

1. Map each accepted decision in `design.md` to a task in `plan.md`; a decision with no task is a missing task.
2. Map each interface or contract to a test; an interface with no test is an untested interface.
3. Check that the diff stays inside the approved files and decisions; unrelated edits are scope creep.
4. Check migration, compatibility, idempotency, concurrency, transaction, and failure-path coverage where the design names them.
5. Check that verification output supports the claims in the plan; an unrun command is not evidence.
6. Check that the plan is revertible in order and that a failed step has a safe stopping point.
7. Return `codePlanReview` with `verdict` (`pass` / `revise` / `block`), deviations, missing tasks, untested interfaces, correctness risks, scope creep, and residual uncertainty; set `resolved: true` only when no correctness-affecting problem remains.
