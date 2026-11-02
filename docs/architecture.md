# Janus Agent Plugin Architecture

The living architecture specification for the janus-agent plugin, describing the current implementation and mechanism. Harness: OpenCode. The core is harness-neutral; Codex, Senpi, and other hosts plug in through thin adapters. Change history lives in git, not in this document.

## 1. Executive Decision

Build an independent Janus agent plugin with a harness-neutral consultation core, a harness-neutral memory core, a local SQLite store, a local MCP interface, and a thin OpenCode adapter.

The public experience is a 13-role family across three teams plus two independent entries: `janus` (default front desk/routing) and `simple` (economical quick answers). The **consultation team** is `consultant` plus `common-explorer`, `consultant-analyst`, `consultant-critic`, and `consultant-auditor`; it owns evidence-driven advice in five modes — `select`, `verify`, `roadmap`, `research`, `guide`. The **R&D team** is `architect` plus `coder` and the `coder-reviewer`/`coder-lite` lanes; `architect` owns system design and the `design.md` record, `coder` owns implementation with adaptive L0–L3 process weight, and `coder-reviewer` pre-mortems one-way designs and reviews the coder's plan/diff. The **documentation team** is `author` plus `author-writer`; `author` owns intake, evidence, the outline approval, the author brief, verification, and publishing, and writes no reader-facing prose; `author-writer` is the sole author of reader-facing prose and, in scoped-write mode, the sole writer of approved files under `writer_docs_roots`. `consultant`, `architect`, and `author` hand work off rather than swallowing another team's lane.

The memory system stores only user-approved experience packages. It does not automatically persist complete conversations. Canonical experience records remain independent of classification schemes, summarization models, embedding models, and storage indexes. Every derived view can be rebuilt.

Implementation must occur in a separate repository or directory selected by the user. No plugin code belongs in the current oh-my-openagent repository.

## 2. Product Goals

1. Give concise, human-friendly answers — a decision brief for decision questions, a readable report for understanding questions.
2. Resist rumors, correlated sources, marketing pressure, astroturfing, and unsupported consensus.
3. Apply different evidence standards to different claim types and risk levels.
4. Detect deliberate deception (paid shilling, coordinated smearing) in user-generated sources.
5. Preserve token efficiency through bounded research and progressive memory disclosure.
6. Accumulate user-approved experience without turning previous model conclusions into circular evidence.
7. Keep the core portable across agent harnesses and model providers.
8. Preserve provenance, revisions, deletion rights, and migration safety.

## 3. Non-Goals

The first version will not:

- join or modify the oh-my-openagent product architecture;
- support concurrent writers from multiple harnesses;
- synchronize memory across machines;
- create an account system or remote memory service;
- save full transcripts (only inductive summaries of consultation records);
- treat old recommendations as independent evidence;
- provide professional medical, legal, financial, or safety decisions;
- ship or require a separate `research-director` agent — deep research is a `research` mode of the consultant;
- make every consultation use multiple subagents.

## 4. Architecture Overview

```mermaid
flowchart TB
    U[User] --> OA[OpenCode Adapter]
    OA --> A[Consultant Agent]
    A --> S[Consultation Skill]
    S --> CC[Consultation Core]
    CC --> MR[Memory Port]
    MR --> MCP[Memory MCP]
    MCP --> MC[Memory Core]
    MC --> DB[(SQLite Canonical Ledger)]
    MC --> IDX[Rebuildable Indexes]
    CC --> SP[Search and Source Ports]
```

### 4.1 Proposed Repository Shape

```text
janus-agent-plugin/
├── packages/
│   ├── consultation-core/
│   ├── memory-core/
│   ├── memory-sqlite/
│   ├── memory-mcp/
│   └── opencode-adapter/
├── skill-src/consultation/    # skill sources (never shipped)
├── assets/
│   ├── agents/consultant.md
│   ├── principles/*.md        # common base/write + shared prompt fragments
│   └── skills/consultation/SKILL.md   # generated from skill-src/
├── evals/
├── docs/
└── package.json
```

This is one installable product with internal package boundaries. It is not a collection of separately configured user projects.

### 4.2 Dependency Direction

```text
consultation-core  memory-core
        ^              ^
        |              |
        +------ memory-sqlite
        |              ^
        +------ memory-mcp
        |
        +------ opencode-adapter
```

Core packages must not import OpenCode or the MCP SDK. Adapters translate host and transport concepts into core ports.

## 5. Component Responsibilities

### 5.1 Consultant Agent

The `consultant` primary agent owns the evidence workflow and final expression for the five consultation modes. `janus` is the default front desk; `simple` is the economical leaf; `architect` owns design; `coder` owns coding; `author` owns durable documents. The consultant routes each request to one of `select`, `verify`, `roadmap`, `research`, or `guide`, and a tier (fast, standard, or deep; `roadmap` and `guide` never use fast). It:

- detects the mode from intent and chooses the tier;
- identifies decision-changing missing information;
- asks at most one to three initial questions when needed;
- invokes search, memory, and the consultation team (`common-explorer`, `consultant-analyst`, `consultant-critic`, `consultant-auditor`);
- retains final synthesis and verification over delegated research without writing prose or production code;
- returns a mode-specific decision brief, a readable research report, or a composite guide;
- hands `design` work to `architect` and durable documents to `author`;
- recognizes natural-language memory intents.

It does not directly implement persistence or source grading rules.

### 5.1.1 Mode Stack and on-demand playbooks

The consultant keeps one session across its five evidence modes: each turn re-evaluates the ask and carries verified evidence, constraints, and accepted decisions forward. A switch to `design` or `doc` is a handoff to `architect` or `author`, which load `consultation-design` or `consultation-doc`; a nested local unknown suspends the main mode, dispatches a bounded `common-explorer`/`consultant-analyst` task, then resumes. A `coder` or `author-writer` task that may be revisited is dispatched with `return_handle: true` and continued through `janus_dispatch_continue` by its owning entry. Only the core `consultation` skill is always relevant; the heavy playbooks are loaded on demand.

### 5.2 Consultation Skill

The reusable core `consultation` skill defines the shared cognitive workflow; `consultation-design` and `consultation-doc` carry the heavy design and document playbooks and are loaded on demand:

- claim decomposition;
- evidence and source evaluation;
- risk classification;
- counter-evidence requirements;
- decision preference handling;
- confidence language;
- short output structure;
- the design method (admission, layered decisions, quality scenarios, reversibility gates, the design record);
- memory preview and save behavior.

The skills are reusable by agents other than `consultant`. The agent prompt may preload the core skill, but the skill remains the authoritative workflow source. `skill-src/{consultation,consultation-design,consultation-doc}/**` is the source of truth and `script/gen-skill.ts` generates the three `assets/skills/*/SKILL.md` files (wired into the build); a freshness test fails on drift. `script/skill-consistency.test.ts` checks the seven-mode schema against the consultant prompt, the generated skills, and the eval `modes` metadata, and `script/prompt-lint.test.ts` enforces per-skill word budgets and duplicate-sentence discipline.

### 5.3 Consultation Core

The consultation core provides deterministic contracts and policy helpers. It owns:

- validated classifications and policy decisions;
- consultation intensity rules;
- risk rules;
- evidence packet schemas;
- fact, inference, preference, and prediction distinctions;
- output contracts;
- research budget enforcement;
- source and memory provenance requirements;
- ports for reasoning, search, memory, and clock.

Reasoning remains model-driven. The core validates structured model output and enforces rules that must not depend on prompt compliance.

### 5.4 Memory Core

The memory core owns:

- canonical experience schemas;
- revision and status transitions;
- progressive retrieval planning;
- taxonomy and tag relationships;
- provenance and validity rules;
- sensitive-field policies;
- forget and cascade-delete semantics;
- import, export, and rebuild contracts.

It does not know OpenCode sessions, MCP transports, or SQLite statements.

### 5.5 Memory SQLite Adapter

The SQLite adapter owns:

- schema migrations;
- transactions and idempotency;
- multi-process safety (WAL, busy timeout, write transactions);
- canonical record persistence;
- FTS indexes;
- derived summaries and embedding records;
- backup, recovery, and rebuild support.

### 5.6 Memory MCP

The local stdio MCP server exposes a stable cross-harness memory boundary. It remains thin and delegates all domain behavior to memory core.

### 5.7 OpenCode Adapter

The first adapter:

- registers the six entries — `janus` (front desk), `simple` (economical leaf), `consultant` (consultation team), `architect` (R&D design), `coder` (R&D implementation), and `author` (documentation);
- registers the consultation subagents — `common-explorer`, `consultant-analyst`, `consultant-critic`, and `consultant-auditor` (read-only, shell-denied, and dispatch-denied);
- registers the R&D subagents `coder-reviewer` (read-only review) and `coder-lite` (mechanical coding lane, leaf, step-capped), and the documentation subagent `author-writer` (edit allowed only under the configured `writer_docs_roots`, default `userdoc`; an empty roots array selects the read-only fallback; shell and dispatch denied; step-capped at 80);
- creates the fixed author state directory (`$XDG_DATA_HOME/janus-agent/author`) where `author` writes per-document briefs, and the design state directory (`$XDG_DATA_HOME/janus-agent/design`) where `architect` writes `design.md`; `author` gets access to the author and design dirs, `architect` to the design dir, and `coder` to the design dir (it reads `design.md`, writes `plan.md`); `consultant` has no business-state directory permission;
- makes the core consultation skill and its design/doc sub-skills available;
- registers or launches the bundled local memory MCP;
- maps OpenCode session IDs into namespaced core IDs;
- exposes model and provider configuration;
- installs the `janus-memory` browse command;
- assembles each prompt from the role asset, model block, shared fragments (`research-leaf`, `reasoning-failures`, `dispatch-hub`), the common base, the common write gate (skipped for read-only roles), and runtime bindings, with a reviewed golden snapshot per role;
- does not contain evidence, recommendation, or persistence logic.

## 6. Consultation Workflow

```mermaid
flowchart TD
    Q[User Question] --> MODE[Detect Mode: select / verify / plan / research / guide / author / design]
    MODE --> T[Choose Tier: fast / standard / deep]
    T --> M[Recall Memory + Surface Pending Outcomes]
    M --> C{Decision-Changing Info Missing?}
    C -->|Yes| ASK[Ask 1-3 Questions]
    C -->|No| D[Decompose Claims]
    ASK --> D
    D --> R[Identify missing evidence + task-fit roles]
    R --> G[Gather + Grade Evidence via Channel Ladder]
    G --> V{Source influence uncertain or relevant?}
    V -->|Yes| IA[Verifier: Bounded Intent Audit]
    V -->|No| A{Material interpretation uncertain?}
    IA --> A
    A -->|Yes| AN[Analyst: Independent Analysis]
    A -->|No| X{Consequential conclusion needs challenge?}
    AN --> X
    X -->|Yes| CE[Critic: Counter-Evidence]
    X -->|No| SYN[Synthesize]
    CE --> SYN
    SYN --> O[Mode-Specific Brief or Readable Report]
    O --> SAVE[Auto-Save Consultation Record + Register Outcome]
```

`doc` consultations run a dedicated state machine behind one outline-approval gate, with a strict author separation — the `author-writer` is the sole author of reader-facing prose and `author` writes none:

```text
route -> intake (audience/delivery/scope) -> explore load-bearing claims
-> author-writer blueprint -> outline + file manifest -> one approval -> create the brief
-> author-writer produces bounded approved chapter drafts (and writes the approved
   files itself in scoped-write mode; returns prose or patches in read-only
   fallback) -> consultant reviews and verifies -> bounded author-writer fixes -> publish
-> proportionate verification -> cross-file check -> final AuthorBrief -> memory summary
```

The brief is the document's external state file at `<authorStateDir>/<projectId>/<docId>/brief.md` (fixed author state dir, stable project id): `author` creates it at the outline gate, updates it at structural changes, and appends a change log; `author-writer` reads it and never writes it. The brief also records `writer_session_id` — the reusable author-writer session for this document, captured from the first author-writer dispatch's `return_handle` completed envelope (or the pending envelope's `session_id`) and absent until then. That first dispatch may be the pre-approval blueprint, before the brief exists: `author` retains the id in working context and writes it into the brief when the brief is created at the outline gate. Document-scoped session reuse is a policy on top of the generic continuation mechanism: `author` continues the same author-writer session for that document's later bounded tasks (`janus_dispatch_continue` with only the change request, affected section, and new evidence — not the whole brief), one session per document with no cross-document reuse, continue only after the previous job is terminal, and a lost/foreign/busy session falls back to a fresh dispatch with the full brief and an updated id. In this mode adversarial roles are proportionate, never a fixed roster: `consultant-critic` runs for `strict` verification, conflicting evidence, high-risk material, failed execution, or material uncertainty it could resolve, and `consultant-auditor` audits user-generated, promotional, or purportedly independent evidence when influence or provenance is relevant or uncertain; a source-independence audit is routed through `consultant`. After outline approval `author-writer` may produce complete section/chapter prose from a bounded evidence packet and do targeted web lookups within a search budget, logging a source ledger; broad or contested research stays with `author`, which routes it to `common-explorer` (the author-writer never dispatches). `author` verifies load-bearing claims against the author-writer's source ledger, checks cross-file consistency, and requests bounded author-writer fixes — in scoped-write mode (`writer_docs_roots` non-empty, default `["userdoc"]`) it does not edit files under the author-writer roots; in read-only fallback (`writer_docs_roots: []`) it applies and publishes the author-writer's returned text and discloses the mode. A delegated author-writer's host permissions are separate and are not enforced by this plugin.

### 6.1 Consultation Tiers

#### Fast

Use when the question is low-risk, directly verifiable, and minimally personalized.

- Prefer a primary authoritative source.
- Perform an exact or very small memory lookup.
- Do not invoke a subagent by default.
- Answer in one to several sentences when possible.

#### Standard

Use for comparisons, recommendations, personalization, or moderate inference.

- Check source independence and provenance.
- Search for counter-evidence.
- Retrieve relevant experience and preferences progressively.
- Dispatch a specialist when its check could materially affect the answer and you can name the decision it could change and the specific failure it would catch. Skip only with that reason; standard tier does not prescribe a roster.
- Return a mode-specific deliverable with the conclusion and next action in the first screen.

#### Deep

Use for high risk, strong source conflicts, missing primary evidence, inference-dominated conclusions, broad comparisons, or any research-mode question.

- Ask the user before escalating.
- Decompose consequential work and route to the specialists whose evidence, interpretation, independent challenge, influence audit, or authoring is relevant or uncertain. Deep tier does not require calling every role.
- Seek supporting and opposing evidence; audit source intent when influence or independence is relevant or uncertain.
- Keep final synthesis and output with the consultant agent.

Deep work is done by the consultant's own team. There is no separate deep-research provider; the `research` mode (§8) is the deep, understanding-oriented path.

### 6.2 Tier Decision Dimensions

The router evaluates:

1. potential harm from a wrong answer;
2. availability of authoritative primary sources;
3. conflict among reliable sources;
4. dependence on personal context;
5. proportion of synthesis versus direct evidence.

### 6.3 Team Roles and Tier Caps

The consultant leads four consultation subagent roles through `janus_dispatch`: `common-explorer`, `consultant-analyst`, `consultant-critic`, and `consultant-auditor`. Its skills are the authoritative task-fit policy: assign bounded work when a role could materially change the result and the consultant can name the decision it could change and the specific failure it would catch; skip only with that reason. Independent gathering may fan out; analysis follows evidence and critique follows a draft conclusion. Design review, code review, and documentation prose belong to their own teams.

Entries are separate from this research roster: `janus` (front desk), `simple` (economical leaf), `consultant` (consultation team), `architect` (design), `coder` (implementation), and `author` (documentation) are user-selectable. `coder` owns the `coder-lite` mechanical lane; `architect` and `coder` share `coder-reviewer`; `author` owns `author-writer`. The tier caps below span the family and are advisory maximums.

| Role | Purpose |
|---|---|
| `common-explorer` | gather and grade evidence (fan-out up to 5 instances) |
| `consultant-analyst` | independent reasoning pass over evidence (model diversity is a runtime property) |
| `consultant-critic` | adversarial counter-evidence pass and plan-robustness review; protocol cards for counter-evidence, hypothesis matrix, and plan robustness |
| `coder-reviewer` | one-way-door design pre-mortem and independent review of the coder's `plan.md`/diff against `design.md`; applies the shared engineering principles |
| `consultant-auditor` | bounded audit of manipulation or opaque independence in user/third-party/promotional evidence; missing observations produce `unknown` |
| `author-writer` | sole author of reader-facing prose for `doc` — blueprint before approval, section/chapter prose and maintenance after approval, coherence passes; targeted web lookups with a source ledger. Plugin-owned: shell and dispatch denied; edit allowed only under `writer_docs_roots` (read-only fallback when empty) |

Per-tier **maximum** instance counts (`TIER_ROLE_CAPS`, mirrored by the adapter's validated `tier_role_caps` config), never minimums or a required team roster:

| Tier | common-explorer | consultant-analyst | consultant-critic | coder-reviewer | consultant-auditor | author-writer |
|---|---|---|---|---|---|---|---|
| fast | 5 | 0 | 0 | 0 | 0 | 0 |
| standard | 5 | 1 | 1 | 1 | 1 | 1 |
| deep | 5 | 3 | 2 | 2 | 2 | 2 |

`doc` never runs at fast tier. `author-writer` is optional (`author_writer_enabled`, default true); when it is disabled or unavailable, doc mode is unavailable — `author` discloses which author-writer work is missing and offers to enable the author-writer, configure a delegate, or an explicit author-prose fallback the user accepts; it does not silently write reader-facing prose. The caps are passed to the consultant as configuration, not enforced by a per-turn runtime scheduler; zero means the role is unavailable at that tier and the consultant must disclose a material gap.

### 6.4 Recoverable Dispatch API

All roles share the same recoverable dispatch lifecycle; every agent resolves to a single configured model with no plugin fallback chain.

| Tool | Arguments | Contract |
|---|---|---|
| `janus_dispatch` | `{role, prompt, return_handle?, mode?, tier?, protocol?}`; role is one of the ten dispatch roles (`common-explorer`, `consultant-analyst`, `consultant-critic`, `coder-reviewer`, `consultant-auditor`, `author-writer`, `simple`, `coder-lite`, `coder`, `consultant`); `mode`/`tier` select the model and `protocol` prepends one of the five methodology cards | Launch a durable host-session job and observe within a soft wait window; with `return_handle: true` a success returns a completed JSON envelope (`job_id`, `role`, `attempt`, `session_id`, `waited_ms`, `text`) instead of plain text, pending/failed unchanged |
| `janus_dispatch_wait` | `{job_id, wait_ms?}` | Recover/observe the same job; optional integer `wait_ms` is 0..300000, default 300000; zero performs a snapshot |
| `janus_dispatch_cancel` | `{job_id}` | Request explicit cancellation and reconcile durable completion/abort evidence |
| `janus_dispatch_continue` | `{session_id, prompt, role?}` | Send a new prompt to an existing dispatch session (`session_id` from a `return_handle` completed envelope or a pending envelope); role is inferred from the target's job spec and validated when supplied. The continuation inherits the spec's `agent_name` and `model_chain`, so it never switches model. Returns the response text or a recoverable pending envelope keyed by the continuation job id |

Model selection follows `mode_models[mode][role] > tier_models[tier][role] > <role>_model > TIER_MODEL_DEFAULTS[tier][role] > MODEL_DEFAULTS[role]`; the one shipped tier default is `deep.coder`. The per-model adaptation block is injected per request by the `experimental.chat.system.transform` hook using the model actually serving the turn, so a mode/tier override or a continuation keeps the matching block. A continuation inherits the original job spec's `agent_name` and `model_chain`; it never re-resolves them from current config. A `protocol` argument prepends one of the five methodology cards (`counter_evidence`, `hypothesis_matrix`, `plan_robustness`, `design_premortem`, `code_plan_review`) as the first bytes of the turn-1 task message.

Launch uses a 300000 ms soft observation window, not a specialist execution deadline. Completed usable reports remain plain text and confirmed failures use `Error:` text. Nonterminal JSON envelopes identify `job_id`, `session_id`, `role`, `attempt`, `status` (`pending`, `unknown`, or `cancelling`) and `next: "janus_dispatch_wait"`. A `cancelled` envelope requires confirmed abort evidence; normal completion racing cancellation wins and preserves the original report. The `return_handle` completed envelope adds a `text` field and drops `reason`/`next` — the job is terminal — and is the only shape change `janus_dispatch` can produce.

Session continuation is a generic, role-agnostic dispatch mechanism, not an author-writer feature: any dispatcher (consultant, janus, coder) may continue any dispatch role's session. Reuse is deliberately bounded: the same caller (the target job root's parent must be the current tool context's session), the same normalized workspace directory, a dispatch-marked target session (job root or attempt child of a normal job root — never a continuation job root, whose journal carries `session_id`), and an idle target (a `busy`/`retry` target is rejected with a wait-first error). A continuation creates a new job root whose durable spec records `session_id` (the reused target) and `continued_from` (the original job root); its attempt 0 prompts the reused target session, while a retry creates a fresh attempt child as usual. Wait and cancel work on a continuation job through the same receipt-driven machinery, because the journal binding accepts a receipt whose session is the spec's `session_id` target. Only a terminal job may be continued; a pending job is waited on. Transient read failures while resolving the target session, its dispatch journal, or its status return a retryable error instead of a not-found/not-owned/idle result, so a transport blip never silently triggers a fresh session. There is no cross-session reuse and no registry — the caller holds the session id (the author brief stores it as `writer_session_id`).

Expiry or an observation-context abort stops waiting, not the child job. Pending means work remains active; unknown means available host evidence does not establish the outcome, not confirmed failure. Keep the same job ID for later waits, including through a fresh coordinator after restart, without a duplicate generating request. Wait/cancel enforce the caller's parent session and workspace ownership. Only explicit cancellation requests may abort work; cancellation remains `cancelling` until reconciled.

Each job is a durable host session rooted under the caller's session (`[consultation-dispatch:v1] <role>`). The first attempt's generation runs directly in that job session, so the dispatched prompt and the specialist's live messages are visible there; journal records are written as ignored/synthetic user messages and stay out of the conversation. Every job is a single attempt.

The consultant may do independent preparation within existing permissions and caps while waiting, but must integrate the eventual specialist report before dependent synthesis and cannot silently substitute inline work or claim an independent check that did not return. Execution status comes from host session/message evidence, not from specialist liveness assertions. A consultant-auditor's evidence-quality `unknown` is distinct from a dispatch execution `unknown`.

Every role has one configured attempt and every agent resolves to a single model; no failure kind — pending, unknown, non-retryable, or confirmed retryable — triggers a plugin fallback advance. A delegated author-writer also has one configured attempt, with either a pinned model or host model selection (`null` in the durable spec), and retains host-defined permissions. This describes plugin model resolution, not the external host's internal retry policy. See [the per-role audit matrix and verification levels](../evals/README.md#per-role-audit-matrix).

### 6.5 Design Mode and the Handoff to Coding

`design` decides the future structure of a system — architecture, patterns, module boundaries, external interfaces — at standard or deep tier, never fast. It admits only decisions that change future structure and are not one obvious reversible edit; everything else goes to the coder as L1/L2. The architect reads the repository and `AGENTS.md` first (at most five questions per round), frames L0 with goal, non-goals, and prioritised six-part quality scenarios, and decides layer by layer (C4 as zoom): L1 system, L2 module, L3 interface.

Every decision carries at least two genuinely different options, a recommendation, what would change it, a one-way/two-way reversibility label, and a deferral trigger where relevant. One-way doors are approved individually and get a coder-reviewer pre-mortem (the coder-reviewer's `designReview`: pre-mortem failures, unmet quality scenarios, reversibility problems, missing options); two-way doors get a default value and one batch approval per layer. A read-only cross-layer consistency check runs before each approval and before handoff, and the accepted result is written to `design.md`.

The record lives at `<designStateDir>/<projectId>/<designId>/design.md` (`$XDG_DATA_HOME/janus-agent/design` by default) and is self-contained: MADR-shaped decisions with only proposed/accepted states, one line per rejected option, fitness functions for load-bearing quality attributes, and open questions with triggers. It is a current-state document, rewritten in place at roughly 200–300 lines. The architect writes it; the coder only reads it.

The handoff to coding is explicit. An accepted `design.md` is the approved spec: the coder skips brainstorming's spec conversation, shrinks the L2 design gate to the implementation details the record does not cover plus the exact file list, and plans a lean ExecPlan (milestones, verification/rollback, decision log, unexpected and findings) at `design/<projectId>/<designId>/plan.md`. Approving the plan confirms its listed files; at L2 the coder self-checks every accepted decision has a task, every interface has a test, and the order is revertible (L3 adds an independent plan review), and after implementation `coder-reviewer` compares the diff with `design.md`. A deviation touching a one-way-door decision returns to `architect`. In a bounded design turn the architect returns only the current layer's decision requests.

## 7. Epistemic Model

### 7.1 Claim Types

Every consultation is decomposed at claim level, not only by domain:

- verifiable fact;
- causal or efficacy claim;
- experiential judgment;
- future prediction;
- value preference and decision.

The domain determines relevant sources. The claim type determines verification method.

### 7.2 Source Evaluation

Sources are graded relative to the claim using:

- primary versus secondary status;
- expertise or legal accountability for the claim;
- transparent and reproducible method;
- independence and original provenance;
- commercial or ideological conflicts;
- recency, region, and applicability;
- independent support or contradiction.

Grades are `high`, `medium`, `low`, and `lead_only`. Numerical trust percentages are prohibited unless backed by real calibrated data.

Niche sources, forums, and social platforms are normally leads, counterexamples, or experience reports. Obscurity is never a credibility bonus.

Reliability grading assumes honest-but-flawed sources. Deliberate deception and opaque independence (water armies, coordinated smearing, undisclosed sponsorship, astroturfing, and purportedly independent promotional evidence) receive a bounded `consultant-auditor` audit when potentially relevant, not only after manipulation is proved: each source is annotated `clean`, `suspect_shill`, `suspect_smear`, or `unknown` from observable signals (temporal bursts, cross-account phrase repetition, account history, disclosure, reviewer target concentration, publisher affiliation, and others). Missing account, sponsorship, or comparison data require `unknown`, not an unsupported `clean`. Suspicion is graded with a stated basis, never ground truth. Common-explorer and consultant still verify the underlying factual claim.

### 7.3 Facts and Inference

The selected reasoning policy is balanced:

- verified facts and synthesized inferences must be presented separately;
- every atom (claim, candidate, step) carries an epistemic status: `verified`, `refuted`, `inferred`, or `unverifiable`;
- `inferred` and `unverifiable` must carry a `basis` recording the reasoning chain ("inferred Y from X") — a bare conclusion is forbidden;
- multiple independent reports and a plausible mechanism may justify a provisional inference;
- synthesis cannot create missing facts;
- correlated reposts count as one source chain;
- important conclusions require a counter-evidence pass;
- insufficient evidence is an acceptable result.

### 7.4 Risk Policy

#### Low Risk

Low cost, reversible, and unlikely to cause persistent harm. Weak evidence may support a cautious trial with clear stopping conditions.

#### Medium Risk

Meaningful cost or side effects. Ask for relevant context, require stronger evidence, and provide an exit strategy.

#### High Risk

Medical treatment, medication, vehicle safety, law, major financial consequences, or irreversible effects. Weak evidence cannot support a recommendation. The agent provides evidence and options but does not replace a qualified professional or make the decision for the user.

Health threshold: recommend consulting a professional only on a hard trigger (medical intervention, prescription/OTC dosage, chronic-condition management, pregnancy or nursing, minors, interaction with an existing condition or medication, irreversible or high-risk body procedure). On a soft trigger — a health or body side effect with low evidence confidence — add one line suggesting a professional consult or starting low. Otherwise give the advice plainly; do not reflexively disclaim.

### 7.5 Decision Model

Evidence and preference are separate layers:

- evidence establishes attributes and uncertainty;
- user preferences assign decision weight;
- missing preferences use explicit defaults;
- outputs state what condition would change the recommendation;
- the agent may conclude that there is no reliable unique winner.

### 7.6 Confidence Model

Use two qualitative dimensions:

- **Evidence confidence:** high, medium, or low
- **Recommendation stability:** stable, conditional, or provisional

Do not output invented numerical confidence.

## 8. Research Mode

Deep, understanding-oriented investigation is a `research` mode of the consultant, not a separate agent or external provider. The consultant detects understanding-seeking intent (open-ended questions, "深度研究", topic surveys) and runs the mode with its own team:

- decompose the question into sub-directions;
- gather missing or uncertain evidence with independent common-explorer instances, parallelizing only independent searches;
- compare consensus, disagreements, and gaps;
- form multiple hypotheses with confidence, actively seeking counterexamples;
- challenge consequential hypotheses with a consultant-critic pass when you can name a counterexample or alternative that would change the report;
- synthesize a readable report (bottom line up front, plain language, evidence and disagreements under `证据与来源（可跳过）`).

The research report is a validated contract (`ResearchBriefSchema`): a one-line bottom line, plain-language key points, an implications line, and confidence, with hypotheses, disagreements, residual uncertainty, and sources under `证据与来源（可跳过）`. There is no separate deep-research provider or `research-director` agent.

## 9. Canonical Memory Model

### 9.1 Stored Entities

| Entity | Purpose |
|---|---|
| `SessionExperience` | One user-approved experience package per host session |
| `ExperienceItem` | A distinct topic inside a session package |
| `Claim` | A proposition with time, region, and applicability |
| `Evidence` | Source metadata and a necessary lawful excerpt |
| `EvidenceLink` | Supports, refutes, qualifies, or supersedes a claim |
| `Decision` | The conclusion, assumptions, preferences, and confidence at that time |
| `Revision` | Why a later conclusion changed the previous state |
| `UserPreference` | A user-confirmed stable preference or constraint |
| `TaxonomyNode` | A versioned category node |
| `TagMembership` | A many-to-many classification link |
| `DerivedSummary` | A rebuildable summary with model and prompt version |

### 9.2 Canonical Versus Derived Data

Canonical data includes user-approved experience records, source metadata, necessary excerpts, decisions, preferences, and revision events.

Derived data includes:

- classifications;
- tags;
- summaries;
- embeddings;
- graph projections;
- ranking caches.

Derived data must record schema, model, prompt, and generation time. It must be safe to delete and rebuild without losing accepted experience.

### 9.3 Revision States

- `active`: eligible for normal retrieval and recommendation
- `superseded`: retained for historical explanation
- `refuted`: used only for contradiction and misinformation checks
- `retired`: excluded from default retrieval
- `forgotten`: canonical and derived content has been erased

An old recommendation is a counter-hypothesis, not counter-evidence. Only its underlying source or recorded outcome can act as evidence.

## 10. Memory Capture Protocol

### 10.1 Natural-Language Intents

The agent recognizes intent rather than fixed commands.

Examples:

- “Summarize what we learned” means preview only.
- “Remember this experience” means preview, sensitive-field review, then commit.
- “Forget that preference” means identify the target, confirm destructive scope, then erase.

### 10.2 One Package Per Session

A session has one `SessionExperience`, but that package may contain several topic-specific `ExperienceItem` records.

Repeated saves:

- update the same session package;
- add a new item for a new topic;
- create a revision for a changed conclusion;
- remain idempotent under retries;
- do not create duplicate ranking candidates.

### 10.3 Save Preview

The preview shows:

- what conclusions and evidence will be saved;
- applicable time, region, and conditions;
- proposed categories and tags;
- user preferences;
- sensitive fields requiring explicit confirmation.

The complete transcript is not saved by default.

### 10.4 Auto-Save

At the end of every consultation the consultant automatically saves the consultation record(s) — no user instruction required. The saved unit is one consultation: a question summary plus a conclusion summary, with the supporting claims, evidence (provenance and grade), and preferences. If a conversation held several distinct questions, each becomes its own record; if it was one question explored in depth, it is one record with a refined conclusion. Before saving, prior consultations are recalled; a very similar new consultation updates the prior record (conclusion changes go through a revision) instead of duplicating.

Never saved: the full transcript, unverified search fragments, hidden chain-of-thought, duplicate sources, ordinary conversation, or credentials. Sensitive fields are excluded from auto-save and persist only after itemized confirmation.

## 11. Memory Organization and Retrieval

### 11.1 Hybrid Organization

Use three overlapping structures:

1. a small versioned top-level taxonomy with dynamic descendants;
2. many-to-many tags and evidence relationships;
3. global lexical and semantic indexes as a recall safety net.

Cross-category experience is linked to multiple categories without copying canonical content.

### 11.2 Progressive Disclosure

Retrieval levels are:

1. index title, time, status, and one-line summary;
2. claim, applicability, and current decision;
3. supporting and opposing evidence plus revision history;
4. lawful source excerpt and full stored reasoning summary.

The default query retrieves level 1 and only the necessary level 2 records. Levels 3 and 4 require explicit expansion by the agent or user.

### 11.3 Hybrid Recall

Candidate generation combines:

- taxonomy branch selection;
- SQLite FTS;
- configurable embedding similarity;
- support, refute, and revision relationships;
- time, region, and applicability filters;
- user preference relevance.

Results are deduplicated by canonical identity and source provenance.

Initial benchmark defaults:

- return at most eight level-1 candidates;
- expand at most three candidates without another decision;
- cap injected memory at approximately 1,200 tokens for standard consultation;
- broaden retrieval only when confidence is low, candidates conflict, or recall is insufficient.

These are tuning defaults, not persistence or API contracts.

### 11.4 Retrieval by Consultation Tier

- Fast: exact or minimal lookup only
- Standard: automatic taxonomy and hybrid recall
- Deep: include prior disputes, refuted claims, and historical revisions as research leads

The user can disable memory for a single consultation.

If stored memory materially changes the recommendation, the answer must disclose which preferences or experience were used. Sensitive memory usage must always be disclosed.

## 12. MCP Surface

Keep the agent-facing surface small:

1. `memory_recall`
2. `memory_expand`
3. `memory_prepare`
4. `memory_commit`
5. `memory_manage`

Maintenance operations (export, import, migration, integrity checks, reindexing) and offline browsing of the consultation record (list, show, search, delete, forget) belong in the CLI rather than permanent agent tool definitions. The database is opened in WAL mode with a busy timeout and every write runs in a short transaction, so the CLI and any number of live memory MCP servers (one per OpenCode window) can use the store concurrently.

The MCP transport is local stdio. The server contains no consultation policy and no model-specific reasoning.

The memory server is registered globally on the host config (`config.mcp`), so it is agent-agnostic — any agent in the session can call the memory tools, not only the `consultant`. Memory is a shared service, not bound to one agent.

## 13. Storage Architecture

### 13.1 Default Paths

Use XDG paths with configurable overrides:

```text
$XDG_DATA_HOME/janus-agent/memory.sqlite3
$XDG_STATE_HOME/janus-agent/
$XDG_CACHE_HOME/janus-agent/
```

The database and user-controlled exports belong in data. Locks, pending enrichment state, and operational records belong in state. Rebuildable query caches belong in cache.

The final product slug can change when the independent repository is named, but the config/data/state separation is fixed.

### 13.2 SQLite Policy

The first version uses SQLite because it provides local transactions, atomic commits, schema constraints, FTS, and crash recovery without a separate service.

Required rules:

- one active author-writer enforced by a lock;
- multiple readers may be allowed by SQLite;
- every save is transactional and idempotent;
- foreign keys and integrity constraints are enabled;
- canonical writes complete before deferred enrichment;
- the database is not supported on network filesystems;
- migrations create a backup and support recovery;
- interrupted derived work remains retryable.

### 13.3 Model Independence

The summarization model and embedding model are configurable separately. The raw accepted record never depends on either model. A model change creates new derived artifacts and leaves canonical data untouched.

## 14. Privacy, Deletion, and Source Safety

### 14.1 Sensitive Data

Sensitive fields are not persisted by default. If the user requests persistence, the preview lists each field separately and requires confirmation.

Users can inspect, modify, retire, or erase stored preferences. The system must not create a sensitive profile through silent inference.

### 14.2 Retire Versus Forget

`retire` preserves audit history but removes a memory from normal retrieval.

`forget` deletes canonical content and all derived summaries, embeddings, tags, and caches. Remaining relationships may retain only a content-free tombstone needed for structural integrity.

### 14.3 External Sources

Store by default:

- URL or stable source identifier;
- title, author or institution, publication date, and access date;
- only the necessary lawful excerpt;
- a content fingerprint;
- how the source supported or challenged a claim.

Do not mirror a complete page or paid report unless the user is authorized and explicitly requests it.

### 14.4 Prompt Injection

All external sources and remembered content are untrusted data, never instructions.

The system must:

- ignore embedded attempts to alter agent policy;
- block requests to execute commands or expose local data;
- prevent malicious source text from becoming a system instruction;
- lower source trust when manipulation is detected;
- warn the user for confirmed attacks or when a source must be excluded;
- avoid repeating the full malicious payload.

## 15. Failure Handling

| Failure | Required Behavior |
|---|---|
| Memory MCP unavailable | Continue without memory and state that saving is unavailable |
| Retrieval error | Do not claim that no prior experience exists |
| Embedding unavailable | Fall back to taxonomy and FTS |
| Search unavailable | State that current factual verification could not be completed |
| Summary or classification fails | Keep the canonical record pending enrichment |
| Another process holds the write lock | Wait up to the busy timeout, then fail with a retryable database-locked error |
| Save request retried | Return the existing idempotent result |
| Migration fails | Roll back the migration transaction, leave the database unchanged, and stop |
| Prompt injection detected | Block it, log a sanitized event, and notify according to severity |

## 16. User-Facing Output Contract

The output is terminal-first and length adapts to decision complexity, not tier alone.

### Double anchor

Full answers start with `结论 / 理由 / 下一步` and end with `一句话 / 下一步` as the last two lines. The mode body sits between them. Evidence, grades, disagreements, and confidence rationale go under `证据与来源（可跳过）` before the bottom anchor, so a reader who jumps to the end still lands on the conclusion. Short answers use the top anchor only.

### Confidence and alternatives

Use `把握：高 / 中 / 低 — why` when confidence is not high or the top alternatives are close. Never present medium/low confidence as certain. `select` and `guide` may say "没有明显赢家" and give a tie-break instead of forcing a winner. `roadmap` starts with `可行 / 有条件可行 / 不建议` and names the condition and failure mode. `verify` may conclude `无法核实` and name the missing evidence.

### Mode bodies

- **select** — selection criteria → candidate short reviews → trial/switch. Short: conclusion + 2–3 reasons + one trial.
- **verify** — key reasons → what would change the verdict → contested-claim details. Short: verdict + 2 reasons + what would settle it.
- **plan** — feasibility → constraints/risks → steps → stop/rollback → alternative. Short: feasibility + 3–5 steps + stop condition.
- **research** — bottom line → 3–5 key points → what it means → disagreements/uncertainty. No forced recommendation.
- **guide** — shortest path → suitability/prerequisites → recommendation (when real choices) → steps → pitfalls → completion check. Carries at least a recommendation or a procedure.
- **author** — status/location → scope → document map → verification → next action. The chat output is a delivery brief, not the document body.
- **design** — conclusion/reasons/next step → layer, goal and constraints, options and trade-offs, recommendation, risks and reversibility, open questions, relation to the layer above → evidence (skippable) → bottom anchor. The record's own home is `design.md`.

### Terminal conventions

Paragraphs are 1–3 sentences; bullet depth is at most 2; headings are at most 3. Tables are at most 3–4 columns with short cells; wider or sentence-heavy tables become `label: value` lines. 100–120 characters is a comfort zone, not a hard limit. No academic filler or method narration before the answer. Every answer ends with an action, even when abstaining.

The exact templates live in the `consultation` skill. `AuthorBrief` remains the validation/memory unit; authored files are caller-approved side products referenced by the brief, not stored in memory.

## 17. Verification Strategy

### 17.1 Consultation Evaluation Cases

- a simple authoritative fact routes to fast consultation;
- multiple articles with one original source count as one chain;
- official and independent measurements are reconciled by conditions;
- a popular unsupported claim is not repeated as fact;
- weak evidence can support only a low-risk, reversible trial;
- high-risk advice does not replace a professional decision;
- changing a user preference changes the ranking when expected;
- insufficient evidence leads to honest abstention;
- prompt injection is blocked and reported;
- deep consultation asks before consuming the larger budget;
- a composite end-to-end request routes to the guide mode and carries at least a recommendation or a procedure;
- a durable tutorial or course request routes to the doc mode with the correct profile instead of research or guide;
- a large author request presents an outline and file manifest and waits for exactly one approval before drafting chapters;
- targeted author verification checks representative code without invoking the consultant-critic or consultant-auditor by default;
- a structural design question routes to `design` (not `select`, a doc architecture write-up, or `roadmap`) and returns per-layer decision requests with reversibility labels;
- a coder with an accepted `design.md` shrinks the L2 gate to uncovered details plus the file list and checks its plan against the record;
- a one-way-door decision gets an coder-reviewer pre-mortem (`designReview`) before approval;
- the design record is rewritten in place, not appended, and old designs get a cleanup proposal.

The fixtures carry an explicit `modes` array per case; `script/skill-consistency.test.ts` asserts every schema mode is exercised by at least one case.

### 17.2 Memory Evaluation Cases

- cross-category experience is recalled;
- a misclassified record remains discoverable through FTS or semantics;
- semantically equivalent wording retrieves the same experience;
- refuted memory never enters positive recommendation ranking;
- material preference use is disclosed;
- progressive disclosure stays within its token budget;
- repeated session saves do not duplicate experience;
- sensitive fields remain absent without confirmation;
- forget removes canonical and derived content;
- indexes rebuild after model changes;
- interrupted enrichment does not damage canonical records;
- a second author-writer cannot corrupt the database.

### 17.3 Integration Verification

Run a real isolated OpenCode instance and prove:

- the plugin loads;
- the consultant agent is selectable;
- the skill instructions are active;
- the local memory MCP starts;
- preview does not persist;
- commit persists and survives restart;
- repeated commit updates one session package;
- recall uses progressive disclosure;
- no data is written into the plugin installation directory;
- the consultant and coder permission maps carry the design state dir, and both prompts name the project design dir.

## 18. First-Version Scope

The first version includes:

- independent plugin packaging, including the seven-mode consultation skill set;
- the `janus` default entry, `consultant` evidence entry, `coder` coding entry, and `simple` economical leaf;
- the four read-only research subagents, the scoped-write author-writer, and the `coder-lite` mechanical lane;
- the reusable core consultation skill and its design/doc sub-skills;
- consultation and memory core packages;
- SQLite persistence with FTS;
- configurable semantic retrieval;
- five memory MCP operations;
- one session experience package with topic items;
- preview, commit, revise, retire, and forget;
- evaluation fixtures and isolated OpenCode integration tests.

Future versions may add:

- Codex and Senpi adapters;
- safe concurrent writers;
- cross-device synchronization;
- optional graph database projections;
- scheduled outcome follow-up;
- remote shared memory services.

## 19. Industry and Platform Rationale

The design follows these documented patterns:

- OpenCode plugins can register tools, mutate configuration, and ship as npm packages or local plugin modules: <https://opencode.ai/docs/plugins>
- OpenCode custom agents support primary and subagent modes with permission rules: <https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/agents.mdx>
- The MCP TypeScript SDK recommends stdio for local client-spawned servers and separates transports from server capabilities: <https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/docs/server.md>
- The XDG Base Directory specification separates configuration, durable data, state, cache, and runtime files: <https://specifications.freedesktop.org/basedir/latest/>
- SQLite documents atomic commit behavior and crash recovery: <https://sqlite.org/atomiccommit.html>
- SQLite WAL supports concurrent readers with a single author-writer, while retaining one-author-writer semantics: <https://www.sqlite.org/wal.html>
- Letta documents tiered context and progressive loading rather than injecting all memory: <https://docs.letta.com/guides/core-concepts/memory/context-hierarchy/>
- Graphiti preserves episode provenance and temporal validity for derived facts: <https://github.com/getzep/graphiti/blob/main/README.md>
- LangMem distinguishes immediate and deferred memory formation: <https://langchain-ai.github.io/langmem/guides/delayed_processing/>
- LangGraph stores use namespaces, metadata filters, and semantic search for long-term memory: <https://docs.langchain.com/oss/python/langgraph/stores>
- Mem0 documents extracted, scoped memory and explicit memory operations: <https://docs.mem0.ai/core-concepts/how-it-works>

The architecture borrows ideas, not runtime dependencies. The first version remains a small local TypeScript plugin rather than adopting Letta, LangGraph, Graphiti, or Mem0 as its application runtime.

## 20. Pre-Implementation Input

Before implementation begins, the user must provide:

1. the independent repository URL or a local parent directory in which to create it;
2. the final product and npm package name.

The consultant's configured model is the default summarization model. An embedding model is optional; without one, retrieval remains functional through taxonomy, relationships, and FTS.

No implementation should begin in the oh-my-openagent repository.
