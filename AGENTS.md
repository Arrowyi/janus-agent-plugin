# Maintainer Guide

## Deployment rule (non-negotiable)

This plugin ships to other users, so a deployment must be reproducible from build artifacts alone — never from this checkout.

- Build and install with `bun run install:local`: it builds `dist/`, stages `dist/` + `assets/` into the install prefix (`~/.local/share/janus-agent-plugin` by default), and verifies the result.
- Point OpenCode's `plugin` entry at the **installed** `dist/index.js`; never at `packages/opencode-adapter/src/index.ts`.
- Keep the bundle self-contained. `script/build.ts` marks nothing external and the memory MCP server resolves to the bundled `memory-mcp-server.js` sibling, so no `node_modules` ships with an install. An external runtime import breaks packaged installs.
- Source-mode entries are for this repo's own test runs only, never for a working setup or a release.

Full detail: [docs/deployment.md](docs/deployment.md#deployment-rule).

## Change checklist

1. Edit source under `packages/` (and `script/`); never edit the generated `dist/` or the install prefix by hand.
2. Run `bun test` and `bun run typecheck`.
3. Run `bun run install:local`, then prove the installed artifact:
   `JANUS_PLUGIN_ENTRY=~/.local/share/janus-agent-plugin/dist/index.js bun run integration`.
4. Restart OpenCode so it loads the new bundle (the `config` hook re-registers agents, the memory MCP, the skill, and the command).
5. When changing `/janus-models`, update `assets/commands/janus-models.md`, `command-installer.ts`, `script/install-local.ts` (`REQUIRED_INSTALLED_FILES`), the command tests, the integration assertion, and the README/deployment docs together.

Role model defaults live in `packages/opencode-adapter/src/plugin-config.ts` (`MODEL_DEFAULTS`) and are mirrored in `docs/deployment.md`; update both, plus the assertions in `plugin.test.ts`, `agent-registration.test.ts`, and `dispatch-tool.test.ts`.

The current role family is `janus` (default general entry), `consultant` (evidence and document entry), `coder` (coding entry), `lite` (economical leaf), the four read-only research subagents (`explorer`, `analyst`, `critic`, `verifier`), the scoped-write `writer` (sole author of reader-facing prose; writes only approved files under `writer_docs_roots`, default `["userdoc"]`; `[]` = read-only fallback), and `coder-lite`; `build` is an optional host delegation target. Update the role assets, registration, dispatch roles, install list, and docs together when changing the family.

## Author separation (writer/consultant)

- The `writer` is the sole author of reader-facing prose; the consultant never writes prose in author mode and, in scoped-write mode, never edits files under `writer_docs_roots` — it reviews the writer's diff and requests bounded writer fixes.
- The author brief lives at `$XDG_DATA_HOME/janus-agent/author/<projectId>/<docId>/brief.md` (fixed; no config). The consultant writes it; the writer reads it and never writes it. The brief stores `writer_session_id` — the writer session captured from the first writer dispatch (`return_handle: true`), which may be the pre-approval blueprint, so the consultant retains the id until the brief is created at the outline gate — and later bounded edits for that document continue it via `janus_dispatch_continue` (one writer session per document, no cross-document reuse; a lost/foreign/busy session falls back to a fresh dispatch with the brief).
- `writer_docs_roots` (default `["userdoc"]`) is validated by `normalizeWriterDocsRoots` in `plugin-config.ts`; invalid roots fail config load. The writer's permission is built by `buildWriterPermission` (root allow rules after a `"*": "deny"` catch-all) and its prompt bindings by `buildWriterRuntimeBindings` in `agent-registration.ts`.
- When changing the author workflow, update together: `assets/agents/writer.md`, `assets/agents/consultant.md`, `assets/agents/janus.md`, `assets/skills/consultation/SKILL.md`, and the writer/consultant assertions in `plugin.test.ts` and `agent-registration.test.ts`.

## Session continuation (generic dispatch reuse)

- `janus_dispatch_continue({session_id, prompt, role?})` is role-agnostic: any dispatcher may continue any dispatch role's session. `janus_dispatch({..., return_handle: true})` returns a completed envelope (`job_id`, `session_id`, `text`) on success; plain text stays the default.
- Reuse bounds enforced in `dispatch-tool.ts` + `dispatch-lifecycle.ts` (see `dispatch-tool.test.ts`, `dispatch-lifecycle.test.ts`): same caller (the target job root's parent is the tool context session), same normalized directory, dispatch-marked target (normal job root or its attempt child — never a continuation job root), idle target, terminal previous job. A continuation job root records `session_id`/`continued_from` in its spec (`dispatch-contract.ts`, `dispatch-journal.ts`); `dispatch-journal-binding.ts` accepts receipts bound to the spec target; wait/cancel work on continuation jobs unchanged.
- When changing continuation behavior, update together: `dispatch-contract.ts`, `dispatch-journal(-binding).ts`, `dispatch-attempt.ts`, `dispatch-lifecycle.ts`, `dispatch-tool.ts`, the runtime-bindings lines (`buildRuntimeBindings`, `buildCoderRuntimeBindings`, `buildJanusRuntimeBindings` in `agent-registration.ts`), the author assets above, and the continue/return_handle assertions across the dispatch tests, `plugin.test.ts`, and `evals/fixtures/consultation-cases.json` (C49+).
