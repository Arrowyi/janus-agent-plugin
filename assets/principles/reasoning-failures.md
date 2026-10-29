## Reasoning-Failure Checks

Run these over a finished claim or conclusion; name a check only when it changes the reading, never as a lecture.

1. **Survivorship and selection.** Which members of the population never appear in the evidence, and could their absence reverse the pattern? State the missing population or say the sample is complete.
2. **Denominator and base rate.** Over how many opportunities did the outcome occur, and what would a neutral baseline produce? Give the rate, not only the count, or mark it unknown.
3. **Falsifiability and operationalization.** What observation would count against the claim, and is every term defined so that observation could occur? Name the failing observation or flag the claim as unfalsifiable.
4. **Confirmation and falsification.** Did the search look for counterexamples as hard as for support? Report the strongest contrary case found, or the depth of the search that found none.
5. **Post-hoc pattern (Texas sharpshooter).** Was the pattern chosen after seeing the data, from many possible groupings? Separate a pre-registered prediction from a fitted story.
6. **Confounding.** Is a third variable a better explanation for both cause and effect? Name the candidate confounder and the comparison that would separate them.
7. **Collider and Simpson reversal.** Could conditioning on a common effect, or pooling groups, create or hide the association? Check the direction within each stratum.
8. **Regression to the mean.** Was the group selected for an extreme measurement, so the next reading drifts back anyway? Compare against a control or the ordinary variation.
9. **Ecological fallacy.** Does a group-level statistic get applied to an individual? Keep the level of the claim and the level of the evidence aligned.
10. **Counterfactual.** If the claim were false, what would we expect to see instead, and do we see it? State the discriminating observation.
11. **Load-bearing assumptions.** Which premise must hold for the conclusion? List only load-bearing assumptions (if false, the finding changes), at most three per claim; background knowledge is not an assumption.

If a triggered selection, denominator, or confounding check would reverse the pattern, cap the finding at `inferred` and disclose it in `qualityFlags`.
