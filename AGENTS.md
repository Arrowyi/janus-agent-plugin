# Maintainer Guide

## Deployment rule (non-negotiable)

This plugin ships to other users, so a deployment must be reproducible from build artifacts alone — never from this checkout.

- Build and install with `bun run install:local`: it builds `dist/`, stages `dist/` + `assets/` into the install prefix (`~/.local/share/janus-agent-plugin` by default), and verifies the result.
- Point OpenCode's `plugin` entry at the **installed** `dist/index.js`; never at `packages/opencode-adapter/src/index.ts`.
- Keep the bundle self-contained. `script/build.ts` marks nothing external and the memory MCP server resolves to the bundled `memory-mcp-server.js` sibling, so no `node_modules` ships with an install. An external runtime import breaks packaged installs.
- Source-mode entries are for this repo's own test runs only, never for a working setup or a release.

Full detail: the "部署规则" section of [docs/deployment.md](docs/deployment.md).

## What changed → which verification

| Change | Run |
|---|---|
| `assets/agents/*.md`, `assets/principles/*.md`, `assets/protocols/*.md`, or `skill-src/**` (after `bun run gen:skill`) | Review the prompt-golden diff, then `bun test` (agent-registration, dispatch-prompt, gen-skill, skill-consistency, prompt-lint) |
| `packages/consultation-core/**` | That package's tests, then full `bun test` + `bun run typecheck` |
| `packages/opencode-adapter/**` | Full `bun test` + `bun run typecheck` + `bun run install:local` + the installed-artifact integration proof |
| `packages/memory-*/**` | That package's tests, then the full suite |
| `script/**`, `evals/**` | `bun test` (the repo-level tests live here) and `bun run typecheck`; run `bun run evals/run-evals.ts` after fixture changes |
| Docs/README only | No tests |

## Generated artifacts and prompt mutations

- `skill-src/{consultation,consultation-design,consultation-doc}/**` is the source of truth for the three skills. Generate `assets/skills/{consultation,consultation-design,consultation-doc}/SKILL.md` with `bun run gen:skill` (wired into `bun run build`); never hand-edit the generated files. `script/gen-skill.test.ts` fails when any is stale.
- Every assembled role prompt has a reviewed golden under `packages/opencode-adapter/src/prompt-snapshots/`. After an intentional prompt change, review the diff and refresh with `UPDATE_PROMPTS=1 bun test packages/opencode-adapter/src/prompt-snapshots.test.ts`.
- Shared prompt fragments live in `assets/principles/`: `common-base.md` (all roles), `common-write.md` (write-capable roles), `research-leaf.md` (the seven read-only leaves: common-explorer/consultant-analyst/consultant-critic/solution-reviewer/coder-reviewer/consultant-auditor/author-reviewer), `dispatch-hub.md` (janus/consultant/tech-lead/architect/author), `user-facing-style.md` (the eight human-facing roles: janus/simple/consultant/tech-lead/architect/author/author-writer/author-reviewer — never the seven structural leaves), and the mode/claim/source/channel/engineering fragments. The five methodology cards live in `assets/protocols/` and are prepended to a dispatch turn by `dispatch-protocol.ts`. They are injected by the adapter, not duplicated into role assets; `script/prompt-lint.test.ts` enforces budgets and duplicate-sentence discipline.

## Change checklist

1. Edit source under `packages/`, `script/`, `skill-src/`, or `assets/`; never edit the generated `dist/`, `assets/skills/*/SKILL.md`, prompt goldens by hand, or the install prefix.
2. Run `bun test` and `bun run typecheck` (plus `bun run gen:skill` after a skill change).
3. Run `bun run install:local`, then prove the installed artifact:
   `JANUS_PLUGIN_ENTRY=~/.local/share/janus-agent-plugin/dist/index.js bun run integration`.
4. Restart OpenCode so it loads the new bundle (the `config` hook re-registers agents, the memory MCP, the skill, and the three commands, and prunes generated skills/commands this plugin has retired by fingerprint).
5. When changing `/janus-models`, update `assets/commands/janus-models.md`, `command-installer.ts`, `script/install-local.ts` (`REQUIRED_INSTALLED_FILES`), the command tests, the integration assertion, and the README/deployment docs together.
6. When adding, removing, or renaming a config field in `JanusPluginConfigSchema`, add or update its entry in `config-catalog.ts` (group, type, default, Chinese summary); `config-catalog.test.ts` fails on any schema/catalog drift. `/janus-config` (`assets/commands/janus-config.md`) drives the `janus_config` tool (`config-tool.ts`, writes via `config-editor.ts`), which every leaf denies through `LEAF_DISPATCH_DENY`.
7. Provider keys (`/janus-config` group 10): `provider-keys.ts` (vault at `$XDG_DATA_HOME/janus-agent/provider-keys.json`, plans, `auth.json` writes), `provider-keys-view.ts` (shared rendering), `provider-keys-tool.ts` (`janus_provider_keys`, leaf-denied, no key-value argument by design), and `provider-keys-cli.ts` (bundled to `dist/janus-keys.js`, launched via the installed `bin/janus-keys` shim; the only place a key value is entered). Never add a tool argument that accepts a key, and never print an unmasked key. `install:local` also syncs the command files into the OpenCode config dir (skip with `JANUS_SKIP_COMMAND_SYNC=1`).
8. Read [docs/design-rationale.md](docs/design-rationale.md) before changing or removing a guard, lifecycle, or state-directory mechanism it covers.

Role model defaults live in `packages/opencode-adapter/src/plugin-config.ts` (`MODEL_DEFAULTS` and the shipped `TIER_MODEL_DEFAULTS`) and are mirrored in `docs/deployment.md`; update both, plus the assertions in `plugin.test.ts`, `agent-registration.test.ts`, and `dispatch-tool.test.ts`. A shipped model with no `assets/model-prompts/<key>.md` block ships without driving notes, so add the block and its `REQUIRED_INSTALLED_FILES` entry in the same change.

The model-routing surface is `mode_models` > `tier_models` > `<role>_model` > `TIER_MODEL_DEFAULTS` > `MODEL_DEFAULTS`. A shipped tier default sits below any explicit user scalar model, so setting `<role>_model` alone also replaces that role's shipped fast default; the deep tier has no shipped defaults. `author-writer` and `author-reviewer` are two-tier seats: `tier_models.deep` entries for them fail config load and a `tier: "deep"` dispatch is rejected. The per-model adaptation block is injected by the `experimental.chat.system.transform` hook (`createSystemTransformHook` in `plugin.ts`), not baked into registered prompts; `janus_dispatch_continue` inherits `loaded.spec.agent_name` and `loaded.spec.model_chain` so a continuation never switches model.

`janus_dispatch` accepts optional `mode`, `tier`, `protocol`, `reviews_job_ids`, and `stage`. `dispatch-guard.ts` enforces the review-seat rules before a session is created:

- `coder-reviewer` always requires `reviews_job_ids`; `solution-reviewer` + `code_plan_review` requires `stage: "plan"|"final"`.
- `author-reviewer` requires `stage: "outline"|"unit"|"reader"|"final"` plus ids naming author-writer root jobs, takes no protocol, and must differ in model family from every listed writer job.
- Job specs persist the dispatched `tier` and `stage` for coder/coder-reviewer/solution-reviewer/author-writer/author-reviewer. An explicit `tier: "fast"` coder-reviewer or author-reviewer dispatch is rejected when the listed jobs include a stronger-tier job (the highest listed tier sets the floor); the author-reviewer `reader` stage, dispatches without a `tier` argument, and specs without a persisted tier are exempt.
- An author-reviewer reply without a parseable `AuthorReviewerReportSchema` report is marked unresolved by `dispatch-review-report.ts`. The 250k context watermark and the 350k coder hard ceiling are enforced at the same boundary.

The guards take effect on the first real dispatch after an OpenCode restart. When changing routing, update `plugin-config.ts`, `plugin.ts`, `dispatch-tool.ts`, `dispatch-protocol.ts`, `dispatch-guard.ts`, their tests, and the config reference in `docs/deployment.md`.

The current family has 15 registered agents and 13 dispatch roles; the role map lives in [docs/architecture.md](docs/architecture.md). Invariants a change must keep:

- `janus` and `architect` are not dispatchable. `dispatch-tool.ts` carries the caller DAG guard set `{consultant, tech-lead, author}`: a dispatched sub-session cannot dispatch any of the three.
- There is no host `build` role.
- L1/L2 milestones dispatch `coder` at `tier: "fast"`, L3 at `tier: "standard"`, each reviewed by `coder-reviewer` at the matching tier plus `solution-reviewer` for the Stage-1/2 gates. Even an L0 micro-change with persistent edits runs the `coder-reviewer` seat; there is no self-review shortcut.

Update the role assets, registration, dispatch roles, install list, protocol cards, and docs together when changing the family.

## Author separation (author/author-writer/author-reviewer)

- The `author-writer` is the sole author of reader-facing prose; `author` never writes prose in doc mode and, in scoped-write mode, never edits files under `writer_docs_roots` — it reviews the author-writer's diff and requests bounded author-writer fixes.
- Outside-root publishing: an approved document outside `writer_docs_roots` (the default roots leave `README.md`, `docs/**`, and `evals/README.md` outside) is drafted through a `writeMode: "read-only"` author-writer unit — the author writes the returned text into the confirmed file first, then runs the `author-reviewer` gate against the file on disk, and logs the change as `published` in the brief only after review passes. The delegation threshold SSOT (code-adjacent ≤2-edit syncs stay with `tech-lead`; new or ≥3-edit document work goes to `author`) lives in `skill-src/consultation-doc/core.md`.
- Document levels `D0`–`D3` scale the process; their SSOT is `### Document levels` and `### Independent review stages` in `skill-src/consultation-doc/core.md`. Prompts name tiers only; the runtime bindings of `author`, `author-writer`, and `author-reviewer` list the resolved model per tier.
- The `author-reviewer` is the documentation team's independent read-only reviewer (`buildAuthorReviewerPermission` grants `external_directory` read access to the author and design state dirs and allows `webfetch`/`websearch` under the stage lookup budgets; `edit`/`bash`/`task`/dispatch all deny). A disabled/failed reviewer is disclosed, never credited. It reports `AuthorReviewerReportSchema` (`packages/consultation-core/src/author-contracts.ts`; the brief records each round as `AuthorReviewRecordSchema`) and is not a `tier_role_caps` key.
- A `D0` meaning-preserving micro-fix (typo, punctuation, broken relative link, ≤2 edits) on a brief-less document skips the brief question via a single `briefWaived: true` fast `author-writer` dispatch, inside or outside `writer_docs_roots` (outside the roots the unit runs read-only and the author applies the patch); the protocol SSOT lives in `skill-src/consultation-doc/policies/current-state-docs.md`.
- The author brief lives at `$XDG_DATA_HOME/janus-agent/author/<projectId>/<docId>/brief.md` (fixed; no config). `author` writes it; `author-writer` reads it and never writes it. The brief stores `writer_session_id` — the session captured from the first author-writer dispatch (`return_handle: true`), which may be the pre-approval blueprint, so the author retains the id until the brief is created at the outline gate — and later bounded edits for that document continue it via `janus_dispatch_continue` (one session per document, no cross-document reuse; a lost/foreign/busy session falls back to a fresh dispatch with the brief).
- `writer_docs_roots` (default `["userdoc"]`) is validated by `normalizeWriterDocsRoots` in `plugin-config.ts`; invalid roots fail config load. Its permission is built by `buildAuthorWriterPermission` (root allow rules after a `"*": "deny"` catch-all) and its prompt bindings by `buildAuthorWriterRuntimeBindings` in `agent-registration.ts`.
- When changing the doc workflow, update together: `assets/agents/author-writer.md`, `assets/agents/author.md`, `assets/agents/author-reviewer.md`, `assets/agents/janus.md`, `skill-src/consultation-doc/**` (generated into `assets/skills/consultation-doc/SKILL.md`), `dispatch-guard.ts` and `dispatch-review-report.ts` when the stages or report change, and the author/author-writer/author-reviewer assertions in `plugin.test.ts`, `agent-registration.test.ts`, `dispatch-guard.test.ts`, and `prompt-contracts.test.ts`.

## Session continuation (generic dispatch reuse)

- `janus_dispatch_continue({session_id, prompt, role?})` is role-agnostic: any dispatcher may continue any dispatch role's session. `janus_dispatch({..., return_handle: true})` returns a completed envelope (`job_id`, `session_id`, `text`) on success; plain text stays the default.
- Reuse bounds enforced in `dispatch-tool.ts` + `dispatch-lifecycle.ts` (see `dispatch-tool.test.ts`, `dispatch-lifecycle.test.ts`): same caller (the target job root's parent is the tool context session), same normalized directory, dispatch-marked target (normal job root or its attempt child — never a continuation job root), idle target, terminal previous job. A continuation job root records `session_id`/`continued_from` in its spec (`dispatch-contract.ts`, `dispatch-journal.ts`); `dispatch-journal-binding.ts` accepts receipts bound to the spec target; wait/cancel work on continuation jobs unchanged.
- When changing continuation behavior, update together: `dispatch-contract.ts`, `dispatch-journal(-binding).ts`, `dispatch-attempt.ts`, `dispatch-lifecycle.ts`, `dispatch-tool.ts`, the runtime-bindings lines (`buildConsultantRuntimeBindings`, `buildTechLeadRuntimeBindings`, `buildJanusRuntimeBindings`, `buildArchitectRuntimeBindings`, `buildAuthorRuntimeBindings` in `agent-registration.ts`), the author assets above, and the continue/return_handle assertions across the dispatch tests, `plugin.test.ts`, and `evals/fixtures/consultation-cases.json` (C49+).

## Design mode (architect → tech-lead plan.md relay)

`architect` owns the `design` mode: it decides future structure layer by layer, records accepted decisions in a self-contained `design.md` under `$XDG_DATA_HOME/janus-agent/design/<projectId>/<designId>/`, and hands that record to `tech-lead`, which writes `plan.md` beside it, gets the `solution-reviewer` Stage-1 gate (`code_plan_review` + `stage: "plan"`), then implements by dispatching isolated dual-tier `coder` sessions milestone by milestone with per-milestone `coder-reviewer` patch reviews and a `solution-reviewer` Stage-2 final review (`stage: "final"` + `reviews_job_ids`). The architect is the sole writer of the record; the tech-lead treats `design.md` as 100% read-only and never edits any line of it. When changing design mode, update together:

- `skill-src/consultation-design/core.md`, `skill-src/consultation/core.md`, `skill-src/consultation/policies/team-orchestration.md`, `skill-src/consultation-doc/policies/current-state-docs.md`;
- `assets/agents/{consultant,architect,tech-lead,coder,author,janus,solution-reviewer,coder-reviewer}.md`;
- `packages/consultation-core/src/{enums,design-brief,decision-brief,tier-router}.ts` and their tests;
- `packages/opencode-adapter/src/{agent-registration,plugin}.ts` (design state dir, `external_directory` permissions for architect and tech-lead, design bindings) and their tests;
- `script/skill-consistency.test.ts`, `script/prompt-lint.test.ts`, and the affected prompt goldens;
- `evals/fixtures/consultation-cases.json` (design cases C56+ and each case's `modes` array).

The design directory is created non-fatally at registration. Deleting `design.md` needs user confirmation; deleting a landed `plan.md` (all milestones verified, review resolved, and the final report delivered) is the one persistent-file deletion exempt from the confirmation gate, and writes/updates to it are still listed for confirmation. The R&D session state lives in `plan.md`, which doubles as the checkpoint file `janus`/`architect` use to relay a fresh `tech-lead` session (protocol: section 4.3 of [docs/architecture.md](docs/architecture.md); rationale in [docs/design-rationale.md](docs/design-rationale.md)). The other team-native state artifacts are the documentation team's per-document `brief.md` under `$XDG_DATA_HOME/janus-agent/author/` and the consultation team's per-project candidate ledgers under `$XDG_DATA_HOME/janus-agent/ledger/`.

## Current-state discipline

Code, comments, prompts, skills, and documents describe only the current implementation — no historical-evolution notes, no deprecated-field explanations, no phase labels or decision codes (`Phase 2`, `Role Family B`, `DR8`), no "formerly X" remarks. History belongs to git. When a name, field, or behavior changes, rewrite the text in place instead of appending a migration note, and delete superseded content rather than marking it obsolete.
