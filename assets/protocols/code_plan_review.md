## Protocol: code_plan_review

Apply this card in two stages: Stage 1 reviews a `plan.md` before implementation; Stage 2 reviews the whole task's final patch after all milestones land. The same card governs every single-milestone patch review in between. Report only correctness-affecting problems.

Input — by review shape, supplied verbatim by the dispatcher; any missing input is reported with `resolved: false`, never reconstructed from the diff alone:

- Stage 1 (plan): the accepted `design.md` (or the approved design-gate text with its exact file list) plus `plan.md`.
- Single-milestone patch: the `.review-mK.patch` path with its metadata header and tail sentinel, the verbatim baseline excerpt naming the milestone's end state and `Confirmed paths`, the executor's actual verification output, and `reviews_job_ids`.
- Stage 2 (final): the .review-final.patch path (plus .review-final-rN.patch on a Stage-2 repair round) with its header and sentinel, the plan.md ledger, and the design.md.

Stage 1 — plan review:

1. Map each accepted decision in the baseline to a task in `plan.md`; a decision with no task is a missing task.
2. Map each interface or contract to a test; an interface with no test is an untested interface.
3. Check migration, compatibility, idempotency, concurrency, transaction, and failure-path coverage where the design names them.
4. Check that verification output supports the claims in the plan; an unrun command is not evidence.
5. Check that the plan is revertible in order and that a failed step has a safe stopping point.

Stage 2 — diff review (substantive correctness and contract defects only):

6. Check the diff stays inside the updated `Confirmed paths` and the accepted decisions; unrelated edits are scope creep, while contract-preserving preparatory refactoring and verified dead-helper removal inside `Confirmed paths` are net code-health improvements. Close the loop on boundary, null, and error handling; on concurrency, idempotency, and migration safety; on interface compatibility; and on tests that actually prove the change.
Structural defects count too: hand-edited generated output breaking the single source of truth, a query hiding side effects, swallowed exceptions masking failures, one conceptual change missed across synchronized sites, or compounded tactical decay in touched code (bolting a fragile kludge onto third-instance knowledge duplication, tangled branching, or leaky boundaries where an in-scope preparatory refactor or a `Scope-Expansion` Report-Up was required, or deleting a shim still referenced by an external caller, public export, config, or persisted schema). Prefix any compounded-decay finding in `correctnessRisks` with `"[structural] "`, naming a concrete failure or maintenance hazard and one actionable in-scope direction (or noting `Scope-Expansion` is required).
Apply three convergence gates: (a) when the working, tested implementation and an alternative are equally sound under the shared Engineering Principles, the working code wins (`verdict: "pass"`, optional note in `residualUncertainty`);
(b) raise `[structural]` findings on touched code in Round 1 (`.review-mK.patch` or Stage-2 Round 1 `.review-final.patch`), while fix rounds (`.review-mK-rN.patch` or `.review-final-rN.patch`) verify prior-round items closed and check only modified fix hunks for regressions or new decay introduced by the fix itself — never add a `[structural]` demand on code untouched since Round 1 and never reverse a followed Round-1 direction;
(c) when the in-scope change is sound (not a kludge) but exposes pre-existing decay outside `Confirmed paths` or an accepted `design.md` contract, return `pass` and record the cross-file debt in `residualUncertainty`.
Style preferences never gate the verdict.
7. Review the test surface with the supplied baseline increments — `git status --porcelain --untracked-files=all`, the code and test diffs, and the test-run output: welcome test updates that stay assertion-equivalent through a refactor or signature change (or disclosed one-line removal of a test exclusive to a deleted dead internal helper); a removed or `.skip`/`.only`-parked test, a thinned-out assertion, a test-configuration edit that silences a failure, or an untracked new test file the runs never covered is a correctness risk, not style.
8. Return `codePlanReview` with `verdict` (`pass` / `revise` / `block`), `deviations`, `missingTasks`, `untestedInterfaces`, `correctnessRisks`, `scopeCreep`, and `residualUncertainty`; set `resolved: true` only when no correctness-affecting problem remains.

Patch integrity gates — every `.review-mK.patch`, `.review-mK-rN.patch`, and `.review-final.patch` review:

9. Confirm the tail sentinel (`=== EOF .review-mK.patch ===`, `=== EOF .review-mK-rN.patch ===`, `=== EOF .review-final.patch ===`, or `=== EOF .review-final-rN.patch ===`) was reached; when the header reports `total_lines > 1800`, read in windows until the sentinel.
10. When `long_line_files` in the header is non-empty, lines longer than 2000 characters evade line-truncating reads: return `revise` or `block`, never `pass`.
11. A missing sentinel or a malformed header is a reported gap with `resolved: false`.
