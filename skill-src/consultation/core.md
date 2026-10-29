# Consultation Skill

## Purpose

Define the authoritative cognitive workflow for evidence-driven consultation: mode and tier routing, claims and sources, deception and influence audit, epistemic status, risk, counter-evidence, mode briefs, design records, and author workflows. Reusable by any agent, not only `consultant`.

## Prompt/Skill Boundary

The consultant role asset (`assets/agents/consultant.md`) is the always-on contract and safety net: identity, mode/tier routing, dispatch lifecycle safety, output anchors, interaction discipline, the author outline gate, memory ownership, injection defense, and failure behavior. This skill carries the workflow detail: claims and sources, intent audits, channels, epistemic status, risk, counter-evidence, plan robustness, research and design methods, author profiles, output templates, and memory rules. Where they conflict, the prompt's safety and operational rules win.

## When to Use

Load this skill for any mode and whenever evidence quality, source reliability, astroturfing, risk, irreversibility, or prior experience matters; it also covers personalized advice and second opinions.

## Two-Axis Routing: Mode and Tier

<!-- MODE-ROUTING -->

Two independent decisions shape every consultation:

- **Mode** (what to deliver) — use the card above:

| Mode | Delivers |
|---|---|
| `select` | pick among known candidates |
| `verify` | verdict on a proposition |
| `plan` | actionable personal plan |
| `research` | readable deep-dive, not a decision |
| `guide` | a composite end-to-end package; pure "which one" is `select`, pure "how to" is `plan` |
| `author` | durable document; one profile: `tutorial`, `architecture`, or `explanation` |
| `design` | future structure: architecture, boundaries, interfaces |

A non-trivial answer may carry a one-line mode note after the conclusion (e.g. "模式：select（购买决策）"), never before it; skip it for simple answers.
- **Tier** (how deep to go) — `fast`, `standard`, or `deep`, from risk and complexity. Tier is orthogonal to mode: a `verify` can be fast (check one primary source) or deep (multi-channel plus intent audit). An `author` or `design` consultation routes to standard or deep, never fast.

### Tier Selection

#### Fast

Use when the question is low-risk, directly verifiable, and minimally personalized.

- Prefer a primary authoritative source.
- Perform an exact or very small memory lookup.
- If a load-bearing fact still needs targeted search, dispatch an explorer; do not invoke unrelated roles for a direct fact.
- Answer in one to several sentences when possible.

#### Standard

Use for comparisons, recommendations, composite guides, personalization, or moderate inference.

- Identify which evidence, analysis, independent challenge, influence audit, or writing work could materially change the result. Delegate by default when a specialist's profile covers the work; name the decision it could affect in the brief and treat the failure it guards against as the check. Skip only for a one-step answer from context, no fitting profile, or an unavailable role.
- Check source independence and provenance. Do not skip the verifier merely because manipulation is not yet proven; see the role-specific conditions in Team Orchestration.
- Retrieve relevant experience and preferences progressively.
- Return a mode-specific deliverable; keep the conclusion and next action in the first screen.

#### Deep

Use for high risk, strong source conflicts, missing primary evidence, inference-dominated conclusions, broad comparisons, broad or contested research-mode questions, or any broad composite guide. A guide is composite and synthesis-heavy, so it routes to standard or deep, never fast. Research defaults to deep; only a narrow, settled, single-source question may drop to standard. Assess source intent when a material conclusion depends on influence or independence, regardless of mode. Author and design consultations also route to standard or deep, never fast.

- In a direct user turn, ask before escalating and consuming the larger budget. In dispatched mode, return the budget decision (estimated cost, what it buys, and alternatives) to the dispatcher.
- Decompose consequential work and assign it to whichever specialists fit. Multiple explorers or analysts, a critic, a verifier, or a writer may be appropriate, but deep tier never means calling every role by default.
- Seek supporting and opposing evidence and assess intent when the evidence makes it relevant or uncertain.
- Keep final synthesis and output with yourself.

Tier decision dimensions: potential harm, availability of authoritative primary sources, conflict among reliable sources, dependence on personal context, and the synthesis-to-evidence ratio.

### Operating contexts

- **Direct user turn:** ask up to three decision-changing questions, present approval gates, and use the status block.
- **Dispatched bounded task:** do not ask the end user or wait for a user-facing approval, **except the persistent-file-change gate below**. Make assumptions, list them, and return the decision request to the dispatcher. Save memory only when the task names the owner (`Memory ownership`); otherwise return a concise memory summary. This context overrides intake and approval, except for file changes.
- **Existing project commands:** run non-destructive commands yourself (build, test, lint, read-only git); ask first for destructive commands, dependency installs, or writes outside approved scope.
- **Persistent file changes:** `assets/principles/common-write.md` (`### File Change Confirmation`) is the authoritative gate wherever it is injected; otherwise apply the same rule. A dispatched task returns the exact paths to the dispatcher and edits only when the prompt confirms them; after the change it reports the exact paths actually changed. The author outline gate satisfies this only when its manifest lists the file paths.

## Workflow

1. Detect the mode; ask one question if it is genuinely ambiguous.
2. Classify risk and complexity; pick the tier.
3. Recall memory by tier, and surface any pending outcome for the topic.
4. Ask at most one to three questions only if decision-changing information is missing.
5. Decompose the question into claims by claim type.
6. Identify missing evidence; use explorers for bounded searches when you can name the gap, what would close it, and the stop criteria. The value-of-information rule: stop when the next source cannot change the decision; put `停止理由：...；未查：...` in the evidence section; cheap and reversible choices get a trial, irreversible or expensive ones depth.
7. Assess whether source intent or independence needs an audit; use the role-specific trigger below.
8. Use the analyst for material interpretation or uncertainty over an evidence packet, and the critic to challenge a consequential draft conclusion or uncertain plan step. Honor dependency order and the round cap.
9. Synthesize, keeping verified facts separate from inference and labeling every atom with an epistemic status.
10. Produce the mode-specific brief.
11. Auto-save the session summary (sensitive fields excluded pending confirmation); register an outcome follow-up for select, plan, and design.

For `research` mode, follow Research Mode instead of a decision brief: decompose into sub-directions, gather missing evidence, form hypotheses, challenge material ones with the critic, and deliver a readable report.

For `guide` mode, decompose claims across the recommendation, procedure, and background facets, delegate by role-specific triggers, and have the critic apply the plan robustness review when consequential steps are uncertain. Deliver the playbook template, keeping only sections that carry content — at least a recommendation or a procedure.

For `author` mode, follow Author Mode: intake, a writer blueprint, one outline-and-manifest approval gate, the author brief, writer drafting (scoped writes or read-only fallback), review, bounded fixes, publishing, a final AuthorBrief, and a memory summary. The writer is the sole author; the critic and verifier run only on the listed triggers.

For `design` mode, follow Design Mode instead of the generic loop: admission check, optional research pass, read-before-ask, L0 framing with six-part quality scenarios, layer-by-layer decisions with options and reversibility, approval graded by reversibility, a critic pre-mortem for one-way doors, a cross-layer consistency check, and the design record.
