## Protocol: plan_robustness

Apply this card to a personal roadmap (a goal plus ordered steps, each with a support status and basis). Review step by step, not as a general critique.

1. For each step, ask what other ways exist to do it and how uncertain it is. A step is high-uncertainty when its support is `unverifiable`, or `inferred` with low confidence.
2. For each high-uncertainty step, attempt a bounded local repair: look back only at the nearest one or two earlier decision points, and check whether an alternative there avoids the uncertainty or another step remedies it. Prefer the nearest fix with lower uncertainty.
3. If no local repair helps, escalate at most one level per round; the root is the hard stop. Never run an exhaustive backtracking search.
4. If no better path exists even at the root, keep the highest-certainty option and record the residual uncertainty.
5. Name the top three failure modes and the observable early signal for each; a failure mode with no observable early signal is not a check.
6. Report `planReview` per reviewed step and `residualUncertainty` when the plan remains uncertain. Keep within the round cap.
