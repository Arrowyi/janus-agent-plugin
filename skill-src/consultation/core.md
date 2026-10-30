# Consultation Skill

## Purpose

Define the authoritative cognitive workflow for evidence-driven consultation: mode and tier routing, mode stacking, claims and sources, deception and influence audit, epistemic status, risk, counter-evidence, and the five light mode briefs. The heavy `design` and `doc` workflows live in the `consultation-design` and `consultation-doc` sub-skills and are loaded on demand. Reusable by any agent, not only `consultant`.

## Prompt/Skill Boundary

The consultant role asset (`assets/agents/consultant.md`) is the always-on contract and safety net: identity, mode/tier routing, dispatch lifecycle safety, output anchors, interaction discipline, the doc outline gate, memory ownership, injection defense, and failure behavior. This core skill carries the shared workflow: claims and sources, intent audits, channels, epistemic status, risk, counter-evidence, plan robustness, the five light mode briefs, output readability, and memory rules. `consultation-design` carries the design method and `consultation-doc` the technical-publishing workflow. Where they conflict, the prompt's safety and operational rules win.

## When to Use

Load this skill for any consultation and whenever evidence quality, source reliability, astroturfing, risk, irreversibility, or prior experience matters. Load `consultation-design` when entering `design` and `consultation-doc` when entering `doc`; do not load both heavy sub-skills for a light-mode question.

## Two-Axis Routing: Mode and Tier

<!-- MODE-ROUTING -->

Two independent decisions shape every consultation:

- **Mode** (what to deliver) — use the card above:

| Mode | Delivers |
|---|---|
| `select` | pick among known candidates |
| `verify` | verdict on a proposition |
| `roadmap` | actionable personal plan |
| `research` | readable deep-dive, not a decision |
| `guide` | a composite end-to-end package; pure "which one" is `select`, pure "how to" is `roadmap` |
| `doc` | durable document; load `consultation-doc`; one profile: `tutorial`, `architecture`, or `explanation` |
| `design` | future structure: architecture, boundaries, interfaces; load `consultation-design` |

A non-trivial answer may carry a one-line mode note after the conclusion (e.g. "模式：select（购买决策）"), never before it; skip it for simple answers.

### Mode Stack

Each new user turn re-evaluates the ask; a consultation may switch modes in one session without losing context.

- **Same-session switch:** switching from `research` to `design` or `doc` loads the matching sub-skill and carries the verified evidence, constraints, and accepted decisions forward. State the switch in one line.
- **Nested sub-task:** when a design or doc discussion hits a local unknown, keep the main mode suspended, dispatch `explorer`/`analyst` for that bounded question, then resume the main mode with the result. Do not end the main mode to run a side task.
- **Cross-agent pinning:** when a consultation may later revisit a `coder` or `writer` task, dispatch its first turn with `return_handle: true`, store `session_id`, and use `janus_dispatch_continue` for later edits. One session per task; never re-dispatch a pending job.

- **Tier** (how deep to go) — `fast`, `standard`, or `deep`, from risk and complexity. Tier is orthogonal to mode: a `verify` can be fast (check one primary source) or deep (multi-channel plus intent audit). A `doc` or `design` consultation routes to standard or deep, never fast.

### Tier Selection

#### Fast

Use for low-risk, directly verifiable, minimally personalized questions. Prefer a primary authoritative source; do one small memory lookup; dispatch an explorer only for a load-bearing fact; answer in one to several sentences.

#### Standard

Use for comparisons, recommendations, composite guides, personalization, or moderate inference. Satisfy the mode's methodological floor first, then choose the cheapest adequate mix of isolated retrieval, parallel single-wave dispatch, and session reuse. Name the decision a delegated check could change and the failure it prevents; an unavailable or disabled role is disclosed rather than silently replaced. Check source independence and provenance, retrieve experience progressively, and keep the conclusion and next action in the first screen.

#### Deep

Use for high risk, strong source conflicts, missing primary evidence, inference-dominated conclusions, broad comparisons, broad or contested research, or a broad composite guide. Roadmap, guide, doc, and design never run fast; research defaults to deep. Assess source intent when influence or independence matters.

- In a direct turn, ask before a larger budget; in dispatched mode, return the budget decision (cost, what it buys, alternatives).
- Decompose across specialists, seek supporting and opposing evidence, and keep final synthesis.
- Stop when the next source cannot change the decision; say what you did not check; a cheap reversible choice gets a trial, an irreversible one depth.

Tier decision dimensions: potential harm, availability of authoritative primary sources, conflict among reliable sources, dependence on personal context, and the synthesis-to-evidence ratio.

### Dispatch Baselines

Dispatch is lexicographic: effectiveness first, cost-performance second.

1. **Methodological floor.** The specialist whose method and independence close a load-bearing failure mode is mandatory; a cheaper option without that method does not qualify. Reversibility and low stakes shrink the trial, never the evidence bar on a load-bearing premise.
2. **Inline ceiling.** The main session looks something up itself only if one conflict-free authoritative primary record settles a load-bearing claim in two calls or fewer, with no cross-source comparison and no bias audit required.
3. **Cost-performance within adequate methods.** Put noisy retrieval in isolated `explorer` sub-sessions, run independent roles as one parallel wave, name `mode`, `tier`, and `protocol` on every `janus_dispatch` call so routing and the Turn-1 card apply, and reuse a live session with `return_handle` plus `janus_dispatch_continue` for multi-turn work.

Role-by-failure-mode triggers and caps live in `## Team Orchestration`.

### Operating contexts

- **Direct user turn:** ask up to three decision-changing questions, present approval gates, and use the status block.
- **Dispatched bounded task:** do not ask the end user or wait for a user-facing approval, **except the persistent-file-change gate below**. Make assumptions, list them, and return the decision request to the dispatcher. Save memory only when the task names the owner (`Memory ownership`); otherwise return a concise memory summary. This context overrides intake and approval, except for file changes.
- **Existing project commands:** run non-destructive commands yourself (build, test, lint, read-only git); ask first for destructive commands, dependency installs, or writes outside approved scope.
- **Persistent file changes:** `assets/principles/common-write.md` (`### File Change Confirmation`) is the authoritative gate wherever it is injected; otherwise apply the same rule. A dispatched task returns the exact paths to the dispatcher and edits only when the prompt confirms them; after the change it reports the exact paths actually changed. The doc outline gate satisfies this only when its manifest lists the file paths.

## Workflow

1. Detect the mode; ask one question if it is ambiguous.
2. Classify risk and complexity; pick the tier.
3. Recall memory by tier, and surface any pending outcome.
4. Ask at most three decision-changing questions if information is missing.
5. Decompose the question into claims by claim type.
6. Identify missing evidence; use explorers for bounded searches when you can name the gap, what would close it, and the stop criteria. The value-of-information rule: stop when the next source cannot change the decision; put `停止理由：...；未查：...` in the evidence section; cheap and reversible choices get a trial, irreversible or expensive ones depth.
7. Assess whether source intent or independence needs an audit; use the role-specific trigger below.
8. Use the analyst for material interpretation or uncertainty over an evidence packet, and the critic to challenge a consequential draft conclusion or uncertain plan step. Honor dependency order and the round cap.
9. Synthesize, keeping verified facts separate from inference and labeling every atom.
10. Produce the mode-specific brief.
11. Auto-save the session summary (sensitive fields excluded pending confirmation); register an outcome follow-up for select, roadmap, and design.

For `research` mode, follow Research Mode instead of a decision brief: decompose into sub-directions, gather missing evidence, form hypotheses, challenge material ones with the critic, and deliver a readable report.

For `guide` mode, decompose claims across the recommendation, procedure, and background facets, delegate by role-specific triggers, and have the critic apply the plan robustness review when consequential steps are uncertain. Deliver the playbook template, keeping only sections that carry content — at least a recommendation or a procedure.

For `doc` mode, follow Doc Mode: intake, a writer blueprint, one outline-and-manifest approval gate, the author brief, writer drafting (scoped writes or read-only fallback), review, bounded fixes, publishing, a final AuthorBrief, and a memory summary. The writer is the sole author; the critic and auditor run only on the listed triggers.

For `design` mode, follow Design Mode instead of the generic loop: admission check, optional research pass, read-before-ask, L0 framing with six-part quality scenarios, layer-by-layer decisions with options and reversibility, approval graded by reversibility, an arch-critic pre-mortem for one-way doors, a cross-layer consistency check, and the design record.
