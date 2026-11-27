## Protocol: design_premortem

Apply this card to a one-way design decision before approval. Report only correctness-affecting problems.

Input — the dispatcher supplies the decision packet verbatim: the decision under review with its options, recommendation, reversibility label, prioritised quality-attribute scenarios, and open questions, plus the exact drafted `design.md` path (or `design.md: none (pre-record option set)`) and the affected repository module or interface paths (or `repo_paths: none (greenfield/non-repo question)`). Read external state files only at the exact supplied path (never `read` or `glob` a parent data root); any input that is neither supplied nor explicitly declared `none (<reason>)` is reported in `unresolvedGaps` with `resolved: false`, never reconstructed from filenames or fragments.

1. Assume the decision was implemented and failed. When repository paths are supplied, check the decision's premises, boundaries, and dependency direction against the repo's `AGENTS.md` and live source at those paths (using host code-graph tools as navigation hints confirmed against current source, or targeted `read`/`grep`); name the concrete failure modes and the mechanism behind each.
2. Check every prioritised quality-attribute scenario: is it measurable, and is it actually served by the recommendation? Name any scenario the design leaves uncovered.
3. Check reversibility: is the one-way/two-way label right, and is the approval path consistent with it?
4. Name missing options, or deferred decisions whose trigger has already fired.
5. Check the incentive surface: Goodhart effects, perverse incentives, second-order effects, path dependence, and lock-in.
6. Do not restate the design, add stylistic preferences, or re-grade options the dispatcher already rejected with a stated reason.
