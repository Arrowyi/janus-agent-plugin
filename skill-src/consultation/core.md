# Consultation Skill

## Purpose

Define the authoritative cognitive workflow for evidence-driven consultation. Route every question to one of six modes (select, verify, plan, research, guide, author), decompose it into claims, grade evidence, audit user-generated sources for deliberate deception, classify risk, run counter-evidence checks, label every atom with an epistemic status, and produce a concise mode-specific decision brief, a readable research report, or a durable technical document behind one outline-approval gate. Reusable by any agent, not only `consultant`.

## Prompt/Skill Boundary

The consultant role asset (`assets/agents/consultant.md`) is the always-on contract and safety net: identity, mode and tier routing, dispatch lifecycle safety, output anchors, interaction discipline, the author outline gate, memory ownership, injection defense, and failure behavior. This skill is the authoritative detailed workflow: claim decomposition, source evaluation, the deception intent audit, channel strategy, epistemic status, risk thresholds, counter-evidence, plan robustness, research mode, author profiles and completion checks, output templates, and memory record rules. If the two ever conflict, the prompt's safety and operational rules win; workflow detail lives here.

## When to Use

Load this skill when the user asks for a recommendation, comparison, or option choice (`select`); a check on a claim, rumor, or argument (`verify`); an actionable plan for lifestyle, fitness, body care, interpersonal, or learning goals (`plan`); a composite operational guide that fuses a recommendation, a procedure, and background for an end-to-end goal (攻略, X入门, guide to X, how do I get started with X) (`guide`); a deep investigation or topic survey (`research`); a durable technical document to keep or share — a tutorial, course, architecture analysis, or technical explanation (教程, 课程, 架构分析, write-up) (`author`); personalized advice; or a second opinion — and whenever evidence quality, source reliability, astroturfing, risk level, or prior experience materially affects the answer.

## Two-Axis Routing: Mode and Tier

Two independent decisions shape every consultation:

- **Mode** (what to deliver) — detected from the question:
  - `select`: choose among candidates (shopping, comparisons, picking a tool, a course, a city).
  - `verify`: render a verdict on a proposition (a claim, rumor, or argument is true, false, or unverifiable).
  - `plan`: produce an actionable plan (fitness, body care, interpersonal, learning).
  - `research`: understand a topic deeply (open-ended investigation, "深度研究", "调查一下", topic or technology surveys) — understanding-oriented, produces a readable report, not a decision.
  - `guide`: produce a composite operational package — a curated recommendation, an actionable procedure, and the background/pitfalls — for an end-to-end goal (攻略, "X入门", "guide to X", "how do I get started with X"). Use it only when the request is composite and needs at least a recommendation or a procedure; a pure "which one" is `select`, a pure "how to" is `plan`, a pure "understand X" is `research`.
  - `author`: create a durable technical document for later reading or sharing. Select exactly one primary profile: `tutorial`, `architecture`, or `explanation`. A chat-only understanding request remains `research`; an operational package remains `guide`; a durable document request routes here.
  If the mode is ambiguous, ask one clarifying question. For a non-trivial answer, you may add a one-line mode note after the conclusion (e.g. "模式：select（购买决策）"); never put it before the conclusion. Skip the note for simple answers.
- **Tier** (how deep to go) — `fast`, `standard`, or `deep`, from risk and complexity. Tier is orthogonal to mode: a `verify` can be fast (check one primary source) or deep (multi-channel plus intent audit). An `author` consultation routes to standard or deep, never fast.

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

Use for high risk, strong source conflicts, missing primary evidence, inference-dominated conclusions, broad comparisons, any research-mode question, or any broad composite guide. A guide is composite and synthesis-heavy, so it routes to standard or deep, never fast. Assess source intent when a material conclusion depends on influence or independence, regardless of mode. An author consultation also routes to standard or deep, never fast.

- In a direct user turn, ask before escalating and consuming the larger budget. In dispatched mode, return the budget decision (estimated cost, what it buys, and alternatives) to the dispatcher.
- Decompose consequential work and assign it to whichever specialists fit. Multiple explorers or analysts, a critic, a verifier, or a writer may be appropriate, but deep tier never means calling every role by default.
- Seek supporting and opposing evidence and assess intent when the evidence makes it relevant or uncertain.
- Keep final synthesis and output with yourself.

Deep work is done by the consultant's own team; there is no separate deep-research agent. Research mode is how a deep, understanding-oriented investigation runs.

Tier decision dimensions: potential harm from a wrong answer, availability of authoritative primary sources, conflict among reliable sources, dependence on personal context, and proportion of synthesis versus direct evidence.

### Operating contexts

- **Direct user turn:** ask up to three decision-changing questions, present approval gates, and use the status block.
- **Dispatched bounded task:** do not ask the end user or wait for a user-facing approval, **except the persistent-file-change gate below**. Make assumptions, list them, and return the decision request to the dispatcher. Memory saving follows the task's `Memory ownership` line; absent it, return a concise memory summary and do not save. This context overrides the intake and approval instructions below, except for file changes.
- **Persistent file changes:** before creating, editing, or deleting a file (scratch/temporary files are exempt), list the exact paths and one-line reasons and wait for the user's explicit confirmation. A dispatched task returns the proposed file list to the dispatcher; it does not edit until the dispatch prompt confirms those exact paths or says no further confirmation is needed. The author outline gate satisfies this only when its manifest lists the exact file paths. After the change, report the exact paths actually changed and note anything unverified or outside the confirmed scope; omit this when no files changed.

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
11. Auto-save the session summary (sensitive fields excluded pending confirmation); register an outcome follow-up for select and plan.

For `research` mode, follow the Research Mode section instead of producing a decision brief: decompose into sub-directions, gather missing evidence with independent explorers, form hypotheses, challenge material hypotheses with the critic, and deliver a readable report.

For `guide` mode, decompose claims across all three facets (recommendation, procedure, background). Delegate evidence, analysis, counter-evidence, and source-intent tasks according to their role-specific triggers, not because a guide must fill a roster. Have the critic apply the plan robustness review when consequential procedure steps are uncertain. A guide is composite and synthesis-heavy, so it routes to standard or deep, never fast. Deliver the operational playbook template below, keeping only the sections that carry content — a guide must carry at least a recommendation or a procedure.

For `author` mode, follow the Author Mode section instead of the generic loop: intake (audience, delivery, scope), scoped exploration of load-bearing claims, a writer blueprint, one outline-and-manifest approval gate, the author brief, writer drafting and writing of approved files (scoped) or returning prose (read-only fallback), consultant review and verification, bounded writer fixes, publishing, a cross-file check, a final AuthorBrief, and a memory summary. The writer is the sole prose author; the consultant does not write reader-facing prose. Adversarial roles are proportionate, never default: the critic and verifier run only on the triggers listed in Author Mode.
