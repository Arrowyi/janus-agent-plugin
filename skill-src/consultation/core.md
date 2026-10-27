# Consultation Skill

## Purpose

Define the authoritative cognitive workflow for evidence-driven consultation: mode and tier routing, claim decomposition, source grading, deception and influence audit, epistemic status, risk thresholds, counter-evidence, mode-specific briefs, design records, and author workflows. Reusable by any agent, not only `consultant`.

## Prompt/Skill Boundary

The consultant role asset (`assets/agents/consultant.md`) is the always-on contract and safety net: identity, mode/tier routing, dispatch lifecycle safety, output anchors, interaction discipline, the author outline gate, memory ownership, injection defense, and failure behavior. This skill is the authoritative workflow detail: claims and sources, intent audits, channels, epistemic status, risk, counter-evidence, plan robustness, research and design methods, author profiles and completion checks, output templates, and memory rules. Where they conflict, the prompt's safety and operational rules win.

## When to Use

Load this skill for any of the seven modes — the `## Two-Axis Routing` list defines their triggers — and whenever evidence quality, source reliability, astroturfing, risk level, irreversibility, or prior experience materially affects the answer. It also covers personalized advice and second opinions.

## Two-Axis Routing: Mode and Tier

Two independent decisions shape every consultation:

- **Mode** (what to deliver) — detected from the question:
  - `select`: choose among candidates (shopping, comparisons, picking a tool, a course, a city).
  - `verify`: render a verdict on a proposition (a claim, rumor, or argument is true, false, or unverifiable).
  - `plan`: produce an actionable plan (fitness, body care, interpersonal, learning).
  - `research`: understand a topic deeply (open-ended investigation, "深度研究", "调查一下", topic or technology surveys) — understanding-oriented, produces a readable report, not a decision.
  - `guide`: produce a composite operational package — a curated recommendation, an actionable procedure, and the background/pitfalls — for an end-to-end goal (攻略, "X入门", "guide to X", "how do I get started with X"). Use it only when the request is composite and needs at least a recommendation or a procedure; a pure "which one" is `select`, a pure "how to" is `plan`, a pure "understand X" is `research`.
  - `author`: create a durable technical document for later reading or sharing. Select exactly one primary profile: `tutorial`, `architecture`, or `explanation`. A chat-only understanding request remains `research`; an operational package remains `guide`; a durable document request routes here.
  - `design`: decide the future structure of a system — architecture, patterns, module boundaries, or an external interface. `select` chooses among known candidates, `author` with the `architecture` profile describes existing code, `plan` is a personal action plan, and `research` explains; `design` decides what to build next.
  If the mode is ambiguous, ask one clarifying question. For a non-trivial answer, you may add a one-line mode note after the conclusion (e.g. "模式：select（购买决策）"); never put it before the conclusion. Skip the note for simple answers.
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

- Identify which evidence, analysis, independent challenge, influence audit, or writing work could materially change the result. Delegate a specialist task when you can name the decision it could change and the specific failure it would catch; if you cannot name both, skip it with that reason.
- Check source independence and provenance. Do not skip the verifier merely because manipulation is not yet proven; see the role-specific conditions in Team Orchestration.
- Retrieve relevant experience and preferences progressively.
- Return a mode-specific deliverable; keep the conclusion and next action in the first screen.

#### Deep

Use for high risk, strong source conflicts, missing primary evidence, inference-dominated conclusions, broad comparisons, any research-mode question, or any broad composite guide. A guide is composite and synthesis-heavy, so it routes to standard or deep, never fast. Assess source intent when a material conclusion depends on influence or independence, regardless of mode. Author and design consultations also route to standard or deep, never fast.

- In a direct user turn, ask before escalating and consuming the larger budget. In dispatched mode, return the budget decision (estimated cost, what it buys, and alternatives) to the dispatcher.
- Decompose consequential work and assign it to whichever specialists fit. Multiple explorers or analysts, a critic, a verifier, or a writer may be appropriate, but deep tier never means calling every role by default.
- Seek supporting and opposing evidence and assess intent when the evidence makes it relevant or uncertain.
- Keep final synthesis and output with yourself.

There is no separate deep-research agent; research mode is the deep, understanding-oriented investigation.

Tier decision dimensions: potential harm from a wrong answer, availability of authoritative primary sources, conflict among reliable sources, dependence on personal context, and proportion of synthesis versus direct evidence.

### Operating contexts

- **Direct user turn:** ask up to three decision-changing questions, present approval gates, and use the status block.
- **Dispatched bounded task:** do not ask the end user or wait for a user-facing approval, **except the persistent-file-change gate below**. Make assumptions, list them, and return the decision request to the dispatcher. Save memory only when the task names the owner (`Memory ownership`); otherwise return a concise memory summary. This context overrides intake and approval, except for file changes.
- **Existing project commands:** run existing non-destructive commands yourself (build, test, lint, read-only git, inspection); ask first for destructive commands, dependency installs, or writes outside the approved scope.
- **Persistent file changes:** `assets/principles/common.md` (`### File Change Confirmation`) is the authoritative gate wherever it is injected; otherwise apply the same rule — list the exact paths and one-line reasons, wait for explicit confirmation, and after the change report the exact paths actually changed. A dispatched task returns the list to the dispatcher; it does not edit until the dispatch prompt confirms those exact paths or says no further confirmation is needed. The author outline gate satisfies this only when its manifest lists the exact file paths.

## Workflow

1. Detect the mode; ask one question if it is genuinely ambiguous.
2. Classify risk and complexity; pick the tier.
3. Recall memory by tier, and surface any pending outcome for the topic.
4. Ask at most one to three questions only if decision-changing information is missing.
5. Decompose the question into claims by claim type.
6. Identify which evidence is missing or insufficient; use explorer subagents for bounded searches when you can name the evidence gap that could change the answer, the queries or source types that would close it, and the stop criteria.
7. Assess whether source intent or independence needs an audit. Do not skip the verifier solely because manipulation is unproven; use the role-specific trigger below.
8. Use the analyst for material interpretation or uncertainty over an evidence packet, and the critic to challenge a consequential draft conclusion or uncertain plan step. Honor dependency order and the round cap.
9. Synthesize, keeping verified facts separate from inference and labeling every atom with an epistemic status.
10. Produce the mode-specific brief.
11. Auto-save the session summary (sensitive fields excluded pending confirmation); register an outcome follow-up for select, plan, and design.

For `research` mode, follow the Research Mode section instead of producing a decision brief: decompose into sub-directions, gather missing evidence with independent explorers, form hypotheses, challenge material hypotheses with the critic, and deliver a readable report.

For `guide` mode, decompose claims across the recommendation, procedure, and background facets, delegate by role-specific triggers rather than a roster, and have the critic apply the plan robustness review when consequential steps are uncertain. A guide is composite and synthesis-heavy: standard or deep, never fast. Deliver the playbook template below, keeping only sections that carry content — at least a recommendation or a procedure.

For `author` mode, follow Author Mode: intake, scoped exploration, a writer blueprint, one outline-and-manifest approval gate, the author brief, writer drafting (scoped writes or read-only fallback), review and bounded fixes, publishing, a final AuthorBrief, and a memory summary. The writer is the sole author of reader-facing prose; the consultant writes none. The critic and verifier run only on the triggers listed there.

For `design` mode, follow the Design Mode section instead of the generic loop: admission check, optional short research pass, read-before-ask, L0 framing with six-part quality scenarios, layer-by-layer decisions with options and reversibility, approval graded by reversibility, a critic pre-mortem for one-way doors, a read-only cross-layer consistency check, and the design record. Design never routes to fast.
