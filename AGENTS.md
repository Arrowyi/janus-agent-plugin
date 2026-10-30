# Maintainer Guide

## Deployment rule (non-negotiable)

This plugin ships to other users, so a deployment must be reproducible from build artifacts alone — never from this checkout.

- Build and install with `bun run install:local`: it builds `dist/`, stages `dist/` + `assets/` into the install prefix (`~/.local/share/janus-agent-plugin` by default), and verifies the result.
- Point OpenCode's `plugin` entry at the **installed** `dist/index.js`; never at `packages/opencode-adapter/src/index.ts`.
- Keep the bundle self-contained. `script/build.ts` marks nothing external and the memory MCP server resolves to the bundled `memory-mcp-server.js` sibling, so no `node_modules` ships with an install. An external runtime import breaks packaged installs.
- Source-mode entries are for this repo's own test runs only, never for a working setup or a release.

Full detail: [docs/deployment.md](docs/deployment.md#deployment-rule).

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
- Shared prompt fragments live in `assets/principles/`: `common-base.md` (all roles), `common-write.md` (write-capable roles), `research-leaf.md` (explorer/analyst/critic/arch-critic/auditor), `dispatch-hub.md` (janus/consultant/coder), and the mode/claim/source/channel/engineering fragments. The five methodology cards live in `assets/protocols/` and are prepended to a dispatch turn by `dispatch-protocol.ts`. They are injected by the adapter, not duplicated into role assets; `script/prompt-lint.test.ts` enforces budgets and duplicate-sentence discipline.

## Change checklist

1. Edit source under `packages/`, `script/`, `skill-src/`, or `assets/`; never edit the generated `dist/`, `assets/skills/*/SKILL.md`, prompt goldens by hand, or the install prefix.
2. Run `bun test` and `bun run typecheck` (plus `bun run gen:skill` after a skill change).
3. Run `bun run install:local`, then prove the installed artifact:
   `JANUS_PLUGIN_ENTRY=~/.local/share/janus-agent-plugin/dist/index.js bun run integration`.
4. Restart OpenCode so it loads the new bundle (the `config` hook re-registers agents, the memory MCP, the skill, and the command).
5. When changing `/janus-models`, update `assets/commands/janus-models.md`, `command-installer.ts`, `script/install-local.ts` (`REQUIRED_INSTALLED_FILES`), the command tests, the integration assertion, and the README/deployment docs together.

Role model defaults live in `packages/opencode-adapter/src/plugin-config.ts` (`MODEL_DEFAULTS`) and are mirrored in `docs/deployment.md`; update both, plus the assertions in `plugin.test.ts`, `agent-registration.test.ts`, and `dispatch-tool.test.ts`.

The model-routing surface is `mode_models` > `tier_models` > `<role>_model` > `MODEL_DEFAULTS`. The per-model adaptation block is injected by the `experimental.chat.system.transform` hook (`createSystemTransformHook` in `plugin.ts`), not baked into registered prompts; `janus_dispatch_continue` inherits `loaded.spec.agent_name` and `loaded.spec.model_chain` so a continuation never switches model. Protocol cards live in `assets/protocols/` and are loaded by `dispatch-protocol.ts`; `janus_dispatch` accepts optional `mode`, `tier`, and `protocol`. When changing routing, update `plugin-config.ts`, `plugin.ts`, `dispatch-tool.ts`, `dispatch-protocol.ts`, their tests, and the config reference in `docs/deployment.md`.

The current family has 11 registered agents and 10 dispatch roles: `janus` (default general entry, not dispatchable), `consultant` (evidence and document entry; seven modes — `select`, `verify`, `roadmap`, `research`, `guide`, `doc`, `design`; same-session Mode Stack), `coder` (coding entry; L3 can use a deep-tier model), `ask-lite` (economical leaf), `explorer`, `analyst`, `critic`, `arch-critic` (architecture/code-plan review), `auditor` (source influence), the scoped-write `writer` (sole author of reader-facing prose; writes only approved files under `writer_docs_roots`, default `["userdoc"]`; `[]` = read-only fallback), and `coder-lite`. There is no host `build` role. Update the role assets, registration, dispatch roles, install list, protocol cards, and docs together when changing the family.

## Author separation (writer/consultant)

- The `writer` is the sole author of reader-facing prose; the consultant never writes prose in doc mode and, in scoped-write mode, never edits files under `writer_docs_roots` — it reviews the writer's diff and requests bounded writer fixes.
- The author brief lives at `$XDG_DATA_HOME/janus-agent/author/<projectId>/<docId>/brief.md` (fixed; no config). The consultant writes it; the writer reads it and never writes it. The brief stores `writer_session_id` — the writer session captured from the first writer dispatch (`return_handle: true`), which may be the pre-approval blueprint, so the consultant retains the id until the brief is created at the outline gate — and later bounded edits for that document continue it via `janus_dispatch_continue` (one writer session per document, no cross-document reuse; a lost/foreign/busy session falls back to a fresh dispatch with the brief).
- `writer_docs_roots` (default `["userdoc"]`) is validated by `normalizeWriterDocsRoots` in `plugin-config.ts`; invalid roots fail config load. The writer's permission is built by `buildWriterPermission` (root allow rules after a `"*": "deny"` catch-all) and its prompt bindings by `buildWriterRuntimeBindings` in `agent-registration.ts`.
- When changing the doc workflow, update together: `assets/agents/writer.md`, `assets/agents/consultant.md`, `assets/agents/janus.md`, `skill-src/consultation-doc/**` (generated into `assets/skills/consultation-doc/SKILL.md`), and the writer/consultant assertions in `plugin.test.ts` and `agent-registration.test.ts`.

## Session continuation (generic dispatch reuse)

- `janus_dispatch_continue({session_id, prompt, role?})` is role-agnostic: any dispatcher may continue any dispatch role's session. `janus_dispatch({..., return_handle: true})` returns a completed envelope (`job_id`, `session_id`, `text`) on success; plain text stays the default.
- Reuse bounds enforced in `dispatch-tool.ts` + `dispatch-lifecycle.ts` (see `dispatch-tool.test.ts`, `dispatch-lifecycle.test.ts`): same caller (the target job root's parent is the tool context session), same normalized directory, dispatch-marked target (normal job root or its attempt child — never a continuation job root), idle target, terminal previous job. A continuation job root records `session_id`/`continued_from` in its spec (`dispatch-contract.ts`, `dispatch-journal.ts`); `dispatch-journal-binding.ts` accepts receipts bound to the spec target; wait/cancel work on continuation jobs unchanged.
- When changing continuation behavior, update together: `dispatch-contract.ts`, `dispatch-journal(-binding).ts`, `dispatch-attempt.ts`, `dispatch-lifecycle.ts`, `dispatch-tool.ts`, the runtime-bindings lines (`buildRuntimeBindings`, `buildCoderRuntimeBindings`, `buildJanusRuntimeBindings` in `agent-registration.ts`), the author assets above, and the continue/return_handle assertions across the dispatch tests, `plugin.test.ts`, and `evals/fixtures/consultation-cases.json` (C49+).

## Design mode (consultant → coder handoff)

`consultant` owns the `design` mode: it decides future structure layer by layer, records accepted decisions in a self-contained `design.md` under `$XDG_DATA_HOME/janus-agent/design/<projectId>/<designId>/`, and hands that record to `coder`, which implements with a reduced L2 gate and writes `plan.md` beside it. The consultant writes the record; the coder only reads it. When changing design mode, update together:

- `skill-src/consultation-design/core.md`, `skill-src/consultation/core.md`, `skill-src/consultation/policies/team-orchestration.md`, `skill-src/consultation-doc/policies/current-state-docs.md`;
- `assets/agents/{consultant,coder,janus,critic,arch-critic}.md`;
- `packages/consultation-core/src/{enums,design-brief,decision-brief,tier-router}.ts` and their tests;
- `packages/opencode-adapter/src/{agent-registration,plugin}.ts` (design state dir, `external_directory` permissions for consultant and coder, design bindings) and their tests;
- `script/skill-consistency.test.ts`, `script/prompt-lint.test.ts`, and the affected prompt goldens;
- `evals/fixtures/consultation-cases.json` (design cases C56+ and each case's `modes` array).

The design directory is created non-fatally at registration. Deleting `design.md` needs user confirmation; deleting a folded `plan.md` is the one persistent-file deletion exempt from the confirmation gate, and writes/updates to it are still listed for confirmation.
