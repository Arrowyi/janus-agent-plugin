## Protocol: design_premortem

Apply this card to a one-way design decision before approval. Report only correctness-affecting problems.

1. Assume the decision was implemented and failed. Name the concrete failure modes and the mechanism behind each.
2. Check every prioritised quality-attribute scenario: is it measurable, and is it actually served by the recommendation? Name any scenario the design leaves uncovered.
3. Check reversibility: is the one-way/two-way label right, and is the approval path consistent with it?
4. Name missing options, or deferred decisions whose trigger has already fired.
5. Check the incentive surface: Goodhart effects, perverse incentives, second-order effects, path dependence, and lock-in.
6. Do not restate the design, add stylistic preferences, or re-grade options the dispatcher already rejected with a stated reason.
