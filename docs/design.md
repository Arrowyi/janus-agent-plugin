# Janus Agent Plugin — Reference Design

- Date: 2026-10-27
- Status: current (Role Family B)
- Scope: the shipped agent family, prompt assembly, routing, permissions, and verification.

## 1. Positioning

The plugin ships one default entry and three direct-entry shortcuts:

- `janus` — default general entry. Handles general questions, light tasks, and routing.
- `consultant` — evidence entry. Owns the seven consultation modes (`select`, `verify`, `plan`, `research`, `guide`, `author`, `design`) and the research team.
- `coder` — coding entry. Owns coding, debugging, refactoring, tests, and the quality gate.
- `lite` — economical quick-answer leaf. Handles low-risk facts, concepts, and simple how-to.

A user who already knows the task type can start at `consultant`, `coder`, or `lite`; a user who is unsure starts at `janus`. The specialist entries are not peers of the default: `janus` is the router, and `consultant`/`coder` also serve as dispatch targets for bounded work.

## 2. Role map

| Role | Layer | Mode | Owns | Does not own |
|---|---|---|---|---|
| `janus` | entry | all | general questions, light tasks, routing | deep evidence, heavy coding, memory records |
| `consultant` | entry | primary | evidence grading, decisions, research, personal plans, design decisions and the design record, author-mode documents (intake, outline approval, verification, the author brief, publishing) | code implementation, daily coding, reader-facing prose authoring (writer-owned) |
| `coder` | entry | all | coding, debugging, refactoring, tests, repo work, quality gate; implements from an accepted design record | consulting/selection, source grading, research reports, editing the design record (consultant-owned) |
| `lite` | entry | all | quick facts, concepts, simple how-to | multi-source evidence, coding, complex planning |
| `explorer` | research | subagent | source gathering, metadata, initial grade | interpretation, final recommendation |
| `analyst` | research | subagent | independent interpretation pass | gathering, final answer |
| `critic` | research | subagent | counter-evidence, alternatives, conclusion challenge | source-intent audit, final answer |
| `verifier` | research | subagent | source intent and independence audit | fact-checking, final answer |
| `writer` | authoring | subagent | all reader-facing prose: blueprints, drafts, maintenance, coherence; writes approved document files under `writer_docs_roots` (scoped) | evidence gathering, outline approval, the brief, memory, publishing (consultant-owned); broad research |
| `coder-lite` | coding | subagent | fully specified mechanical coding/file tasks | judgment, debugging, cross-module, security-sensitive work |
| `build` | delegation | host | optional stronger-model coding escalation | plugin policy, final answer |

`build` is not a plugin-registered agent. It is a dispatch role that targets the host's build agent by name and optionally pins a model.

## 3. Routing

```text
janus       -> consultant / coder / lite / explorer (bounded evidence gathering)
consultant  -> explorer / analyst / critic / verifier / writer
consultant  -> lite (bounded quick answer)
consultant  -> coder (bounded code example; a design record hands off to implementation)
coder       -> coder-lite / build (optional)
lite        -> none (leaf)
research    -> none (leaf)
coder-lite  -> none (leaf)
build       -> none (host agent)
```

`coder` never dispatches `consultant`; that would create a cycle. Evidence flows to the consultant, code flows to the coder. `lite` is a leaf and never dispatches. `janus` is the only entry that can reach both hubs. Document tasks (new documents, edits, feedback, maintenance) route to `consultant` from `janus`; `janus` never dispatches `writer` directly and never asks the user to choose between consultant and writer. System design (architecture, module boundaries, interfaces) routes to consultant `design`; an implementation plan for a codebase routes to `coder`; read-only document Q&A routes to `lite`.

## 4. Coder process weight

The coder selects the lightest process that fits and announces it in one line before working.

| Weight | Triggers | Process | User gate |
|---|---|---|---|
| L0 Direct | one-line fix, typo, rename, formatting/lint, config value, small test, copy-adapt; diff describable in one sentence | read target + nearest pattern; minimal edit; nearest verification; report diff/output | file list confirmed; no design approval |
| L1 Brief plan | one/few files; clear requirements; existing pattern; reproducible bug; local design choice | 3-5 bullet plan; TDD for behavior changes; implement; targeted verification; report | file list confirmed; plan shared |
| L2 Design + plan | multi-file/module; API/schema/migration; unfamiliar code; more than one plausible design | explore; design gate (Goal/Context/Constraints/Done-when + 2-3 options + recommendation + files + risks + verification) — reduced to the uncovered implementation details plus the exact file list when an accepted `design.md` exists; lean ExecPlan with a plan↔design self-check; small steps; independent review; full verification | design block + file list; wait for approval before editing; approving the plan confirms its listed files |
| L3 Quality gate | concurrency, idempotency, replay, transactions, distributed failure, DB migration/constraints, auth, money/billing, data deletion, production config, crypto/keys; irreversible/high blast radius | L2 plus four-column pre-analysis, reference pattern, schema/constraint read, idempotency/concurrency/failure analysis, red-green proof, diff against pattern, independent review, destructive-action approval | design + quality-gate plan + file list; wait for approval |

The weight is revised upward when new information appears; it is never silently downgraded because a task is taking longer than expected. Skills are selected by weight: L0 uses none; L1 uses TDD/systematic-debugging/verification when relevant; L2 adds brainstorming/writing-plans/requesting-code-review; L3 adds the full quality gate. A skill's default gate does not override the L0/L1 direct path.

A universal file-change gate sits above this table: before any persistent file change (create, edit, delete; scratch/temporary files are exempt), the agent lists the exact paths and one-line reasons and waits for explicit user confirmation. L0/L1 do not bypass it. A user's "no further confirmation this round" covers only the scope they stated; a new path or expanded scope needs a new confirmation.

When `coder` is dispatched with a bounded task, it does not ask the end user questions. If the dispatch prompt does not already confirm the exact file paths, it returns the proposed file list and reasons to the dispatcher and stops; the dispatcher obtains user confirmation and re-dispatches with the confirmed paths. Once paths are confirmed, it makes assumptions, uses the lightest process, and returns the diff, verification output, and residual risks.

## 5. Prompt assembly

Every plugin-owned agent prompt is assembled in this order:

1. **Role asset** — `assets/agents/<agent>.md`: identity, ownership, process, interaction, failure behavior.
2. **Model-adaptation block** — `assets/model-prompts/<normalized-model-key>.md`: model traits and operating notes. The block is keyed by model, not role, and is provider-agnostic. A model with no block gets none.
3. **Shared fragments** — `assets/principles/research-leaf.md` for the four read-only research roles, `assets/principles/reasoning-failures.md` for the analyst and critic after the leaf fragment, and `assets/principles/dispatch-hub.md` for the dispatching hubs (`janus`, `consultant`, `coder`); `assets/principles/engineering-principles.md` reaches `coder` here and enters the consultation skill at the design mode's marker.
4. **Common base** — `assets/principles/common-base.md`: epistemic honesty, untrusted input and secrets, and scope/conflict rules, injected into every role.
5. **Common write** — `assets/principles/common-write.md`: the persistent file-change confirmation gate, its dispatched-mode rule, and the post-change file summary. Read-only roles omit this layer.
6. **Runtime bindings** — injected at the role asset's `RUNTIME-BINDINGS` placeholder: the agent's model, dispatch targets, job-tool discipline, memory availability, caps, namespace, and the author/design state bindings where relevant.

Role assets are model-agnostic and fragment-free; model-specific traits never live in a role asset, and role rules never live in a model block. Role-specific exceptions and deltas stay in the role asset.

For `consultant`, the role asset is the always-on contract and safety net, while the consultation skill carries the detailed workflow (tier selection, per-tier caps, mode templates, author profiles, the design method). The skill is generated: edit `skill-src/consultation/**`, then run `bun run gen:skill` (wired into the build); never hand-edit `assets/skills/consultation/SKILL.md`. `script/gen-skill.test.ts` fails when the generated file is stale. `script/prompt-lint.test.ts` enforces per-layer word budgets and cross-file duplicate-sentence discipline, and `script/skill-consistency.test.ts` keeps the schema, prompt, skill, and eval `modes` in agreement.

Every assembled role prompt has a reviewed golden file under `packages/opencode-adapter/src/prompt-snapshots/`. After an intentional prompt change, review the diff and refresh with `UPDATE_PROMPTS=1 bun test packages/opencode-adapter/src/prompt-snapshots.test.ts`.

## 6. Config and models

Defaults:

| Role | Default model |
|---|---|
| `janus` | `opencode-go/glm-5.3` |
| `consultant` | `opencode-go/glm-5.3` |
| `coder` | `opencode-go/glm-5.3` |
| `lite` | `opencode-go/deepseek-v4.1-flash` |
| `explorer` | `opencode-go/deepseek-v4.1-flash` |
| `analyst` | `opencode-go/qwen3.8-max` |
| `critic` | `opencode/gemini-3.8-flash` |
| `verifier` | `opencode/gemini-3.8-flash` |
| `writer` | `opencode/claude-sonnet-5-5` |
| `coder-lite` | `opencode-go/glm-5.3-flash` |
| `build` | host default (optional `build_model`) |

Every role resolves to a single configured model. There is no plugin fallback chain. A user can override any role with `<role>_model` in `~/.config/janus-agent/config.jsonc`. The writer's writable document roots are configured with `writer_docs_roots` (default `["userdoc"]`, project-relative paths such as `docs/guides` allowed; an empty array selects the read-only fallback where the writer returns prose and the consultant publishes).

The intended cross-family audit is consultant (GLM) ≠ analyst (Qwen) ≠ critic (Gemini). If a user overrides those roles onto one model family, the independence of the audit is reduced; the plugin does not enforce model diversity.

## 7. Permissions and dispatch

- `janus` is a full execution seat with host-default permissions. `coder` is a full execution seat plus `external_directory` read/write access to the design state dir (it reads `design.md` and writes `plan.md`).
- `consultant` is a primary evidence seat; it owns the author brief, the design record, and publishing but does not implement production code, and in author mode it does not write reader-facing prose (the writer does). Its `external_directory` permission covers the author state dir and the design state dir.
- `lite` can read/search, write only inside its workspace, and cannot dispatch (`task: deny`).
- Four research subagents (`explorer`, `analyst`, `critic`, `verifier`) are read-only leaf nodes: `edit: deny`, `bash: deny`, `task: deny`.
- The `writer` is a scoped-write leaf node: `edit` is denied everywhere except `<writer_docs_roots>/**` (default `userdoc/**`; `"*": "deny"` first, root allow rules after — emitted both project-relative and anchored to the project directory in absolute form, because the host matches edit patterns literally against the submitted file path and the writer's tools submit realpath'd absolute paths), `bash: "deny"`, `task: "deny"`, `webfetch`/`websearch` allowed, plus read access to the fixed author state dir via `external_directory`. Setting `writer_docs_roots: []` makes the writer read-only (`edit: "deny"`) — the writer then returns prose or patches and the consultant publishes them. The writer is step-capped at 80.
- `coder-lite` can edit the workspace, asks for external edits, and cannot dispatch (`task: deny`); it is step-capped at 50.

All dispatch roles use the recoverable lifecycle: `janus_dispatch` (optional `return_handle: true` for a completed envelope carrying `session_id`), `janus_dispatch_wait`, `janus_dispatch_cancel`, and `janus_dispatch_continue`. Pending/unknown is not failure; wait on the same job. There is no automatic fallback model.

`janus_dispatch_continue({session_id, prompt, role?})` is the generic session-reuse mechanism, role-agnostic and available to every dispatcher: it sends a new prompt to an existing dispatch session so later turns reuse the specialist's accumulated context (the consultant reuses a writer session across a document's feedback turns; analyst/coder/etc. sessions reuse the same way). A continuation creates a new job root whose spec records the reused `session_id` and `continued_from`; attempt 0 prompts the reused target, and a retry still creates a fresh attempt child. Reuse is bounded to the same caller, the same workspace, a dispatch-marked target (a normal job root or its attempt child — never a continuation job root), and an idle target; only terminal jobs are continued. The role family, permissions, and configuration are unchanged — no new config field, no registry, no cross-session reuse.

### 7.1 Author state and the brief

Author-mode state lives in one file per document: the brief at `$XDG_DATA_HOME/janus-agent/author/<projectId>/<docId>/brief.md` (fixed location; `projectId` is the sanitized project basename plus a short stable hash of the absolute project directory). The consultant creates and updates the brief; the writer reads it and never writes it. The brief also stores `writer_session_id`, the writer session captured from the first writer dispatch (`return_handle: true`) — which may be the pre-approval blueprint, so the consultant retains the id until the brief is created at the outline gate — and reused per document through `janus_dispatch_continue` for that document's later bounded tasks — one writer session per document, no cross-document reuse, and a lost/foreign/busy session falls back to a fresh dispatch with the full brief. The brief never lives in `userdoc/` or the published document tree. In scoped-write mode the consultant does not edit the writer roots — it reviews the writer's diff and requests bounded writer fixes; in read-only fallback the consultant applies and publishes the writer's returned text and discloses the fallback.

### 7.2 Design state and the record

Design decisions live outside the project tree at `$XDG_DATA_HOME/janus-agent/design/<projectId>/<designId>/design.md` (or `.../<planId>/plan.md` when a plan has no design). The consultant writes and maintains `design.md`; the coder only reads it and writes its own `plan.md` beside it. Both agents receive `external_directory` access to `<designStateDir>/**`, and runtime bindings name the design base dir `<designStateDir>/<projectId>` using the same stable project id as the author brief. `design.md` is a current-state document: the consultant rewrites it in place, keeps it around 200–300 lines, and asks before deleting it. `plan.md` is temporary: after folding into `design.md`, deleting it is the one persistent-file deletion that needs no confirmation.

## 8. Memory

`consultant` and `lite` share the consultation memory namespace. Both auto-save one consultation record when serving the user directly; a dispatched bounded task saves only when the task names that agent as the memory owner (`Memory ownership: consultant saves` or `Memory ownership: lite saves`), otherwise the dispatcher owns the record. `janus` does not attach to consultation memory, so a `janus -> consultant` dispatch must include `Memory ownership: consultant saves`; without it the consultant returns a memory summary and no record is saved. `coder` and `coder-lite` do not attach to consultation memory; coding sessions use the repo's `AGENTS.md` and project docs.

## 9. Verification

The shipped gate is:

```bash
bun test
bun run typecheck
bun run install:local
JANUS_PLUGIN_ENTRY=~/.local/share/janus-agent-plugin/dist/index.js bun run integration
```

The integration proof loads the installed artifact in an isolated OpenCode sandbox and asserts the agent keys, the memory MCP, the skill, the lite workspace, the dispatch primitives, the design/author state permissions, and the design bindings in the consultant and coder prompts. Assembled prompts are locked by the golden snapshots, and the generated skill by `gen-skill.test.ts`; `skill-consistency.test.ts` checks the seven-mode schema against the prompt, skill, and eval `modes` metadata. Model-graded behavior (routing, adaptive process, dispatched-mode discipline, design gates) is covered by `evals/fixtures/consultation-cases.json` and requires a live-model review.
