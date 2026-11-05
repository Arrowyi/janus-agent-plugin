# Evaluation Fixtures

This directory holds the evaluation fixtures for the consultation agent plugin,
derived from architecture sections 17.1 (Consultation Evaluation Cases) and 17.2
(Memory Evaluation Cases).

## Two-tier grading

Every case is marked with one of two grading tiers:

- **deterministic** - The case's executable contract is covered by a pure-function,
  store, or dispatch-lifecycle regression test. The runner prints the test file
  that covers it. Run `bun test` to verify these. No live model is needed.
- **model** - The case requires a live agent (a real model) to judge
  behavior that cannot be pinned by a pure function, such as reconciling
  conflicting sources, disclosing memory use, or honestly abstaining when
  evidence is insufficient. The runner prints `MANUAL` and the rubric question a
  reviewer must answer. The runner never calls a model.

## Files

- `fixtures/consultation-cases.json` - 89 cases: 14 from architecture 17.1, C15-C25 task-fit routing scenarios, C26-C30 recoverable lifecycle cases, C31-C39 entry routing/adaptive coder process plus terminal-output usability cases, C40-C48 doc-mode separation (author-writer/author) cases, C49-C55 author-writer-session reuse and continuation cases, C56-C59 design mode, C60-C74 the lexicographic dispatch floor, reasoning-failure/auditor/KAC (key-assumptions check)/outside-view/VOI (value-of-information stop rule)/plan pre-mortem cases, and the multi-ask/one-goal/GRADE-lite (evidence-body confidence up/downgrade)/mode-card/ACH (competing-hypothesis matrix) cases, C75-C85 the mode-stack, coder-reviewer, dynamic model routing, continuation-lock, strict unknown-key rejection, critique-contract, specialist-floor, and inline-ceiling cases, and C86-C89 the author-reviewer gate, briefWaived micro-fix, user-facing-style, and coder-lite delegation cases.
- `fixtures/memory-cases.json` - 12 cases from architecture 17.2.
- `run-evals.ts` - The runner script.

Each case has the shape (`modes` is empty for process/coding cases that exercise no consultation mode; `script/skill-consistency.test.ts` asserts every schema mode appears in at least one case):

```json
{
  "id": "C1",
  "title": "...",
  "given": "...",
  "when": "...",
  "then": "...",
  "grading": "deterministic | model",
  "modes": ["select | verify | roadmap | research | guide | doc | design"],
  "notes": "test file or rubric question"
}
```

## How to run

From the repository root:

```bash
bun run evals/run-evals.ts
```

The runner loads both fixture files, prints a per-case checklist grouped by
grading, marks deterministic cases with the covering package test file, prints
`MANUAL` plus the rubric question for model-graded cases, and exits 0. It makes
no live model calls.

`PASS (deterministic) -> <files>` means the mapping exists and its files are on
disk, not that the runner executed those tests. A printed checklist is neither
an executable test pass nor a live evaluation pass.

To actually verify the deterministic cases, run the package test suite:

```bash
bun test
```

To verify the model-graded cases, run a live agent against the
given/when/then scenario and answer the printed rubric question for each.

## Deterministic coverage map

The runner keeps an inline table mapping each deterministic case id to the
package unit test file that covers it. The mapping is a convention: the case
id encodes the scenario, and the test file encodes the function under test.

| Case | Test file |
| --- | --- |
| C1 | packages/consultation-core/src/tier-router.test.ts |
| C2 | packages/consultation-core/src/source-grading.test.ts; packages/memory-core/src/provenance.test.ts |
| C9 | packages/memory-core/src/injection.test.ts |
| C26 | packages/opencode-adapter/src/dispatch-registration.test.ts; packages/opencode-adapter/src/dispatch-lifecycle.test.ts; packages/opencode-adapter/src/dispatch-observer.test.ts |
| C27 | packages/opencode-adapter/src/dispatch-observer.test.ts; packages/opencode-adapter/src/dispatch-lifecycle.test.ts |
| C28 | packages/opencode-adapter/src/dispatch-lifecycle.test.ts |
| C29 | packages/opencode-adapter/src/dispatch-cancel.test.ts |
| C30 | packages/opencode-adapter/src/dispatch-lifecycle.test.ts; packages/opencode-adapter/src/dispatch-tool.test.ts; packages/opencode-adapter/src/dispatch-registration.test.ts |
| C41 | packages/opencode-adapter/src/agent-registration.test.ts; packages/opencode-adapter/src/plugin.test.ts |
| C54 | packages/opencode-adapter/src/dispatch-tool.test.ts; packages/opencode-adapter/src/dispatch-lifecycle.test.ts |
| C80 | packages/opencode-adapter/src/plugin-config.test.ts; packages/opencode-adapter/src/dispatch-tool.test.ts; packages/opencode-adapter/src/system-transform.test.ts |
| C81 | packages/opencode-adapter/src/dispatch-tool.test.ts; packages/opencode-adapter/src/dispatch-lifecycle.test.ts |
| C82 | packages/opencode-adapter/src/plugin-config.test.ts |
| C83 | packages/consultation-core/src/team.test.ts; packages/consultation-core/src/prompt-contracts.test.ts |
| M1 | packages/memory-sqlite/src/store.test.ts |
| M2 | packages/memory-sqlite/src/store.test.ts |
| M4 | packages/memory-sqlite/src/store.test.ts; packages/memory-core/src/retrieval-plan.test.ts |
| M6 | packages/memory-core/src/retrieval-plan.test.ts; packages/memory-sqlite/src/store.test.ts |
| M7 | packages/memory-sqlite/src/store.test.ts |
| M8 | packages/memory-sqlite/src/store.test.ts |
| M9 | packages/memory-sqlite/src/store.test.ts |
| M10 | packages/memory-sqlite/src/cli.test.ts |
| M11 | packages/memory-sqlite/src/store.test.ts |
| M12 | packages/memory-sqlite/src/multi-instance.test.ts |

Model-graded cases (C3, C4, C5, C6, C7, C8, C10, C11, C12, C13, C14, C15-C25,
C31-C40, C42-C48, C49-C53, C55, C56-C79, C84-C89, M3, M5) have no test-file mapping by design (C6, C7, C10, C11, C12, C40, C44, C45, C47, C49-C53, C55, C77, and C86-C89 carry deterministic backstops named in their notes).

## Recoverable lifecycle evaluation (C26-C30)

These five cases are deterministic **at the tool/observer contract level**:
pending-live recovery, unknown classification without resubmission, late-result
recovery through a fresh coordinator, normal completion winning cancellation,
and terminal model failure without a fallback advance. Their notes name exact regression
tests. Run the cited `bun test` files (or the full suite) to prove those contracts.
The coordinator tests use controlled SDK evidence and clocks; they are not an
installed-host restart proof. `dispatch-prompt.test.ts` separately checks
machine-readable status and next-action identifiers, not natural-language compliance.

Consultant attribution, eventual integration, and disclosure still require a
live model run reviewed against each case's `Rubric:` notes. Record this level
separately from executable results; do not promote a deterministic pass into a
live-model pass. For pending-live, inspect launch → pending → same-job wait →
original report → final integration. Independent preparation may continue within
permissions and caps but must not be credited as the awaited independent check.
For unknown, require honest unresolved-gap disclosure or same-job observation.

Adversarial rubric: **Reject “soft-wait expiry means failed”, silent inline substitution,
abort-on-expiry, and unknown-triggered backup model.** Also reject duplicate
generation presented as recovery and cancelled claims after normal completion.
Host session/message evidence, not specialist claims of being alive, determines
execution status; a consultant-auditor's evidence-quality `unknown` is not dispatch failure.
Keep private messages, credentials, raw source copies and full transcripts out
of repository evidence; retain only redacted structural observations and verdicts.

### Per-role audit matrix

All 12 dispatch roles share the identical recoverable launch/wait/cancel lifecycle:
`janus_dispatch{role,prompt}`, `janus_dispatch_wait{job_id,wait_ms?}`,
and `janus_dispatch_cancel{job_id}`. Every role has exactly one configured
attempt and resolves to a single-model chain — the plugin ships no model-fallback
advance. A delegate model may be `null` in the durable job spec (host model selection),
and its host permissions are retained, not replaced by bundled restrictions.

| Role/target | Recoverable lifecycle | Configured attempts | Audit emphasis |
| --- | --- | --- | --- |
| common-explorer | Same launch/wait/cancel | One | Recover original evidence report; no duplicated gathering on expiry |
| consultant-analyst | Same launch/wait/cancel | One | Integrate returned analysis; inline reasoning is not an independent check |
| consultant-critic | Same launch/wait/cancel | One | Await challenge before dependent synthesis; no false review credit |
| coder-reviewer | Same launch/wait/cancel | One | Await the pre-mortem/plan review before a one-way approval or implementation; no false review credit |
| simple | Same launch/wait/cancel | One | Bounded economical answer; a leaf that never dispatches |
| consultant-auditor | Same launch/wait/cancel | One | Separate execution status from evidence-quality uncertainty |
| bundled author-writer | Same launch/wait/cancel | One (single-model chain) | No fallback advance — a confirmed terminal retryable failure ends the job after one attempt; preserve outline gate and scoped-write roots (edit only under `writer_docs_roots`; `[]` or an approved path outside the roots = read-only, and `author` applies the returned prose) |
| delegate author-writer | Same launch/wait/cancel | One, pinned model or host selection | No plugin fallback advance; retain external host permissions |
| author-reviewer | Same launch/wait/cancel | One | Await the independent report before publishing an architecture/targeted/strict document; a disabled or failed reviewer is disclosed, never credited |
| coder-lite | Same launch/wait/cancel | One | Recover the original milestone result; no duplicate edits on expiry; baseline reconciliation only after the terminal return; a pending job is never credited as done |
| coder | Same launch/wait/cancel | One | Await the bounded implementation report before dependent steps; follow-ups continue the pinned session; no duplicate implementation on expiry; file changes only on confirmed paths |
| consultant | Same launch/wait/cancel | One | Integrate the returned consultation; the dispatcher owns the memory record unless the task says `Memory ownership: consultant saves`; a dispatched consultant never asks the end user |
| author | Same launch/wait/cancel | One | Await the document delivery report; dispatchable only from top-level entries (a session that was itself dispatched cannot dispatch it); outline gate, reviewer gate, and writer-session reuse stay inside its workflow |

Exercise pending/unknown/recovery/cancel for each role and both delegate model
forms. Check configured-attempt routing separately from host-internal provider
retries; the plugin cannot claim control of an external delegate's internals.

## Entry routing and adaptive coder process evaluation (C31-C39)

These cases check the entry layout and the coder's adaptive process, not model
quality. Run them with a live model and record the observed tool trace:

- **C31/C32** — bounded work goes to `simple`; spec-complete milestones and mechanical code go to `coder-lite` (serially, one milestone at a time, after a baseline snapshot); judgment code stays with `coder` (L3 can use a deep-tier model); the consultant does not implement code.
- **C33/C34** — `janus` routes consulting/coding/quick answers; direct entry to `consultant`/`coder`/`simple` does not bounce back.
- **C35/C36/C37** — coder L0 skips the plan; L2 presents the design gate and waits; L3 runs the quality gate.
- **C38** — a dispatched consultant does not ask the end user; it saves only when the task assigns `Memory ownership: consultant saves`, otherwise it returns a summary and the dispatcher owns the record.
- **C39** — a close `select` answer opens with 结论/理由/下一步, says there is no clear winner, gives a tie-break and `把握`, puts evidence after the decision, and ends with a next action.

Reject a run that uses the same process weight for every task. The expected
failure modes are process theater on L0 and skipped design on L2/L3.

## Author separation evaluation (C40-C48)

These cases check the author/author-writer split in `doc` mode and
maintenance. Run them with a live model and record the observed tool trace
plus the author-writer's child-session trace:

- **C40/C41** — all reader-facing prose (even a typo) is dispatched to `author-writer`; the author-writer writes only under `writer_docs_roots` and reports a denied outside path instead of working around it.
- **C42** — a repo-document blueprint returns the pre-outline global model (`documentSpine`, `evidenceMap`, `systemModel` grounded in the inspected source revision).
- **C43** — a legacy document without a brief triggers the three-option question with the auto-rebuild default; multiple candidates are listed with paths and titles.
- **C44** — the author-writer returns a `sourceLedger` for every web lookup and `author` verifies load-bearing claims before publishing.
- **C45** — with `writer_docs_roots: []` the author-writer returns prose, `author` publishes it, and the fallback mode is disclosed.
- **C46** — `janus` hands document work to the user-selectable `author` entry, never to `author-writer` directly, and never asks the user to choose author vs author-writer.
- **C47** — the author-writer never dispatches common-explorer; broad research returns to `author` as a `researchRequest`.
- **C48** — a structural change returns `needsConsultant`; `author` presents the manifest delta for exactly one approval, then dispatches the author-writer and updates the brief.

Reject a run where `author` edits prose itself in doc mode, where
the author-writer writes outside its roots, or where author state silently drifts
from the brief and manifest.

## Writer session reuse and generic continuation evaluation (C49-C55)

These cases check the generic session-reuse mechanism —
`janus_dispatch` with `return_handle: true` and `janus_dispatch_continue` —
both in the author workflow (author-writer session reuse) and as a role-agnostic
dispatch capability. Record the tool trace plus the brief's
`writer_session_id` field:

- **C49/C51** — the first author-writer dispatch captures the session handle
  (`return_handle: true`; completed envelope's `session_id`, or the pending
  envelope's `session_id` followed by a same-job wait) and stores it in the
  brief; the envelope `text` is used as the result and raw envelope JSON is
  never shown to the user.
- **C50** — a maintenance edit on the same document and author session
  continues the stored author-writer session (`janus_dispatch_continue`,
  role `author-writer`) with a delta-sized prompt — no fresh author-writer job root for
  that turn, no replayed full brief, and no continue while the previous
  author-writer job is pending.
- **C52** — a busy/lost/foreign stored session: wait for the active job or
  fall back to a fresh dispatch with the full brief, update the stored id,
  and disclose the fresh session only if it changes cost or behavior.
- **C53** — a different document gets a fresh author-writer session; no
  cross-document reuse of an author-writer session.
- **C54** — the mechanism is generic: a consultant-analyst session continues the same
  way (deterministic at the tool/lifecycle level; see the coverage map).
- **C55** — a first author-writer dispatch that is the pre-approval blueprint runs
  before the brief exists: `author` retains that session id in working
  context, writes it into the brief when the brief is created at the outline
  gate, and uses it for the post-approval drafting continue — no early brief,
  no lost id, no fresh author-writer session.

Adversarial rubric: **Reject a fresh `janus_dispatch` where a reusable idle
author-writer session exists for that document, a `janus_dispatch_continue` on a
pending job, a continuation `job_id` passed as `session_id`, cross-document
session reuse, and a lost session silently replaced without updating the
brief's stored id.**

## Design, dispatch-floor, and reasoning-method evaluation (C56-C74)

Model-graded. Record the tool trace and the named output fields, then answer each case's `Rubric:` note.

- **C56-C59** — a structural question routes to `design` and is decided layer by layer with reversibility labels; a coder with an accepted `design.md` shrinks its L2 gate and has the diff checked against the record; a one-way door gets a `coder-reviewer` pre-mortem (`designReview`) before approval; the record is rewritten in place at about 200–300 lines, with a cleanup proposal and confirmation before deleting any `design.md`.
- **C60** — lexicographic dispatch floor: a load-bearing evidence gap goes to `common-explorer` (isolated session, `mode`/`tier`/`protocol` named) before inline search; low stakes shorten the trial step, never waive the retrieval floor.
- **C61/C62** — reasoning-failure check (outcome selection and a missing denominator in 自古红颜多薄命); the consultant-auditor reports `signalsFired` by name and `missingObservations`, never inferring `clean` from missing data.
- **C63/C64** — KAC (key-assumptions check): at most three load-bearing `assumptions` per claim with `ifFalse` and `test`; outside view: `outsideView` (`referenceClass`, `baseRate`, `caseAdjustment`) before any case adjustment, or a plain "no usable baseline".
- **C65/C66** — VOI (value-of-information stop rule): stop with a stated stop reason when the next source cannot change the decision; go deeper on an irreversible choice with a missing key fact.
- **C67** — a three-month plan lists the top three `failureModes`, each with an observable `earlySignal`.
- **C68/C69** — a multi-ask message is split by ask and run in dependency order under one anchor pair; one end-to-end goal stays one `guide` (or `doc`).
- **C70/C71** — GRADE-lite (evidence-body confidence up/downgrade): conflicting high-grade sources cap the claim at `medium`; independent replication can raise a medium source's claim to `high`; source grade and claim confidence stay separate.
- **C72** — the mode card separates all seven modes at their boundaries.
- **C73/C74** — ACH (competing-hypothesis matrix): the consultant-analyst builds a 2–3 hypothesis matrix with `discriminatingEvidence`; the consultant-critic attacks it through `missingAlternatives` or `flaws`.

## Mode-stack, routing, and contract evaluation (C75-C85)

- **C75/C76** (model) — a research-to-design handoff carries the verified evidence into design; a nested `common-explorer`/`consultant-analyst` sub-task returns to the pending design work.
- **C77** (model) — a coder session is pinned with `return_handle: true` and a later change uses `janus_dispatch_continue` on the same session.
- **C78/C79** (model) — `coder-reviewer` with `design_premortem` returns `designReview`; with `code_plan_review` it returns `codePlanReview` with a pass/revise/block verdict.
- **C80-C83** (deterministic, see the coverage map) — `mode_models` beats `tier_models` beats the scalar model, and the system-transform hook injects the prompt for the model actually serving the turn; a continuation inherits the original `agent_name` and `model_chain`; unknown config keys fail strict config load; `CritiqueDraftSchema` carries `planReview` and a nullable `designReview`.
- **C84/C85** (model) — a `select` over biased or multi-source evidence uses `common-explorer` and `consultant-auditor` instead of ad-hoc inline search; a claim settled by one conflict-free primary record within two calls stays inline with its residual uncertainty stated.

## Reviewer gate, micro-fix, user-facing style, and delegation evaluation (C86-C89)

These cases cover the documentation team's third seat and the shared output style:

- **C86** — the `author-reviewer` gate: an independent dispatch between the writer's final pass and publishing for `architecture` documents and `targeted`/`strict` verification, returning an `AuthorReviewerReport`; `light` non-architecture documents and waived micro-fixes skip it, the writer's self-polish never substitutes, and a disabled or failed reviewer is disclosed, never credited.
- **C87** — the `briefWaived` fast path: a qualifying micro-fix (typo, punctuation, broken relative link, at most two edits) on a brief-less document under `writer_docs_roots` takes a single delta-sized `author-writer` dispatch with `briefWaived: true`, the writer refuses anything touching numbers, code, APIs, or meaning, and the author closes after the three-item diff check with no reviewer dispatch.
- **C88** — the shared user-facing style: the eight human-facing roles gloss a technical term at its first occurrence and never paraphrase exact identifiers, commands, paths, or config keys for plainness; the six structural leaves stay exempt.
- **C89** — coder-lite milestone delegation: an approved plan's spec-complete milestones go serially to `coder-lite` after a 0700 baseline snapshot, with exact-content restore, quarantine, and one bounded re-do on pollution, an ephemeral probe staying on the L0 fast path, and `coder-reviewer` held to the two Stage 1/Stage 2 gate reviews.

## Task-fit routing evaluation (C15-C25)

For each scenario, a reviewer first records which role tasks are plausibly relevant and which are demonstrably unnecessary **before** looking at the run's tool calls. The rubric grades task fit and usable output, not the total number of subagents. A second reviewer can challenge the pre-labeling when a source or user constraint changes. Preserve the exact task and model/configuration across baseline and revised runs; three independent runs of each unambiguous case are a release gate, not a statistical guarantee.

For each user turn, record the active **message** agent (not only the session label), user constraints, the reason a role is plausible or clearly unnecessary, the tool name and `janus_dispatch` input role, whether its child result contains usable text, and whether the final answer adopts or qualifies the result. Inspect chronological dependencies: gather evidence before analysis, form a candidate conclusion before critique, and approve an author outline before requesting manuscript prose. Also record final answer quality, source support, latency, token usage, and missing checks. Keep private user messages, credentials, full transcripts, and raw source copies out of this repository.

Use host session/message/part records for observational baseline examples. A prior session with zero dispatches shows what happened, **not** whether each work unit warranted a specialist or whether conversation length caused the decision. Paired live runs are required for a causal before/after comparison. In C22, begin with another primary agent for several turns, switch to consultant for the same new research request used in a fresh consultant session, and inspect `message.data.agent` per turn. In C21, use a controlled empty-child result and the dispatch-tool unit test; do not assume a provider will produce an empty reply on demand.

C16's exclusion applies only to a clearly non-promotional authoritative specification. C23 is its positive-control counterpart: the source may be official while its claim about independent reviewers still needs an influence audit. C24 must run in a separate isolated config with `consultant_auditor_enabled: false`; verify both the dispatch preflight and the final answer's disclosure. C25 checks the author-writer blueprint before the outline gate, not chapter prose before approval. If model access, quotas, or installed skill overrides prevent a live run, report the exact missing verification instead of marking it passed.
