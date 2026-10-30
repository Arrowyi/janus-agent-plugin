# Local Deployment Guide

This guide covers installing the janus-agent plugin into a local OpenCode setup.

## Deployment Rule

**Deploy only the packaged bundle. Never point an OpenCode config at this repo's source.**

This project is distributed to other users, so a deployment must be reproducible from build artifacts alone: it may not depend on the repo checkout, its `node_modules`, or Bun's module cache. Concretely:

- Build and install with `bun run install:local`; it builds `dist/`, stages `dist/` + `assets/` into the install prefix, and verifies the result.
- Point the OpenCode `plugin` entry at the **installed** `dist/index.js`, never at `packages/opencode-adapter/src/index.ts`.
- The installed bundle must stay self-contained: `script/build.ts` marks nothing external, and the memory MCP server resolves to the bundled `memory-mcp-server.js` sibling, so no `node_modules` ships with it.
- Source-mode entries are for this repo's own test runs only (`bun test`, `bun run integration`), never for a working setup or a release.

Any change that reintroduces an external runtime import, or a config entry pointing at source, violates this rule. `bun test` guards the resolution logic and `bun run integration` proves the installed artifact registers correctly.

## Prerequisites

- **Bun >= 1.1** - the runtime and package manager. Install from <https://bun.sh>.
- **OpenCode** - the agent harness. Install from <https://opencode.ai> or your package manager. Verify with `opencode --version`.
- **Model providers** — the shipped defaults assume an **OpenCode Go subscription** for the `opencode-go/*` pool models, plus the `opencode` provider for the writer (`opencode/claude-sonnet-5-5`) and the critic/arch-critic/auditor (`opencode/gemini-3.8-flash`, Zen pay-per-use). Without these providers, the agents register but fail at model resolution when used. Non-Go users: copy the config below into `~/.config/janus-agent/config.jsonc` and set every `*_model` to a provider configured on your machine. Dispatch failures print this remediation hint with the exact field name.

  ```jsonc
  {
    "consultant_model": "<your-provider>/strong-agentic-model",
    "explorer_model": "<your-provider>/fast-cheap-model",
    "analyst_model": "<your-provider>/reasoning-model",
    "critic_model": "<your-provider>/different-family-model",
    "arch_critic_model": "<your-provider>/different-family-model",
    "auditor_model": "<your-provider>/different-family-model",
    "writer_model": "<your-provider>/writing-model",
    "coder_model": "<your-provider>/strong-coding-model",
    "ask_lite_model": "<your-provider>/fast-cheap-model",
    "coder_lite_model": "<your-provider>/mechanical-coding-model"
  }
  ```

Bun and OpenCode must be on your `PATH`.

## Step 1: Install Dependencies

Clone this repository and install its dependencies. Bun is the only package manager; never use npm, yarn, or pnpm.

```bash
git clone <repo-url> janus-agent-plugin
cd janus-agent-plugin
bun install
```

## Step 2: Build, Install, and Register

Build the bundle and install it into a stable prefix:

```bash
bun run install:local
```

The installer stages `dist/` + `assets/` into the install root (default `~/.local/share/janus-agent-plugin`; override with `JANUS_INSTALL_DIR`), writes `package.json` + `build-meta.json` for provenance, and fails if any required file is missing. It prints the exact plugin entry to add to `~/.config/opencode/opencode.json` (create the file if missing):

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///Users/you/.local/share/janus-agent-plugin/dist/index.js"]
}
```

Installed layout:

```text
<install root>/
  dist/index.js               bundled adapter plugin (self-contained)
  dist/memory-mcp-server.js   bundled memory MCP server (self-contained)
  assets/agents/*.md          agent prompts (read at startup)
  assets/model-prompts/*.md   model-adaptation blocks (keyed by model slug)
  assets/principles/*.md      common principles + shared prompt fragments
  assets/protocols/*.md       five methodology cards loaded by janus_dispatch
  assets/skills/consultation/SKILL.md          generated core skill
  assets/skills/consultation-design/SKILL.md   generated design sub-skill
  assets/skills/consultation-doc/SKILL.md      generated doc sub-skill
  assets/commands/janus-models.md
  package.json                provenance
  build-meta.json             version / git sha / build time
```

Re-running `bun run install:local` rebuilds and replaces the installed bundle. Restart OpenCode afterwards to load it. The three skill files in the install are generated from `skill-src/**`; edit the sources, never the generated assets.

The installed plugin ships every prompt it needs, including `assets/agents/writer.md`, and does not require OMO, an external janus agent, global agent files under `~/.config/opencode/agents/`, external skills, or the source checkout at runtime. A missing writer makes doc mode unavailable: the consultant discloses it and offers to enable the writer, configure a `writer_delegate_agent`, or an explicit consultant-prose fallback — it never silently writes reader-facing prose itself.

### Development only: source mode

For iterating on this repo (unit tests, the integration proof, or a throwaway session), a plugin entry may point at `packages/opencode-adapter/src/index.ts`. Bun runs TypeScript directly, so no build is needed, but this mode requires the repo checkout and its `node_modules` to be present. It must never be used for an installed deployment or a release.

## Step 3: Restart OpenCode

Restart OpenCode so it picks up the new plugin entry. On startup the plugin's `config` hook runs and:
1. registers the `consultant` primary agent (configurable name via `consultant_agent`), with `external_directory` access to the author and design state directories so it can write the author brief and `design.md`;
2. registers the `coder` coding entry (mode `all`: selectable and dispatchable), the `ask-lite` economical leaf (mode `all`, dispatch denied), and the `coder-lite` mechanical lane (mode `subagent`, steps 50, workspace edits allowed without asking, further dispatch denied);
3. registers the `ask-lite` workspace directory (`$XDG_DATA_HOME/janus-agent/lite`, configurable via `ask_lite_workspace_dir`) writable without asking; every other write asks. It creates the design state dir `$XDG_DATA_HOME/janus-agent/design` and the `coder` gets `external_directory` access to it (the coder reads `design.md` and writes `plan.md`);
4. registers the review/research subagents `explorer`, `analyst`, `critic`, `arch-critic`, `auditor` (each read-only, each on its configured model, each with shell and dispatch denied) and the scoped-write author executor `writer` (edit allowed only under `writer_docs_roots`, default `userdoc/**`; shell and dispatch denied; targeted web lookups allowed; step-capped at 80; an empty `writer_docs_roots` makes it read-only and the consultant publishes its returned prose). It also creates the author state dir `$XDG_DATA_HOME/janus-agent/author` where the consultant writes per-document briefs;
5. registers the `janus-memory` local MCP server (when memory is enabled, the default);
6. registers `janus_dispatch{role,prompt,return_handle?,mode?,tier?,protocol?}`, `janus_dispatch_wait{job_id,wait_ms?}`, `janus_dispatch_cancel{job_id}`, and `janus_dispatch_continue{session_id,prompt,role?}` for the ten dispatch roles (these do not interfere with the built-in `task` tool or other plugins). `mode`/`tier` select the model; `protocol` prepends one of the five methodology cards to the first turn;
7. installs the `consultation`, `consultation-design`, and `consultation-doc` skills and the `/janus-memory` and `/janus-models` slash commands into your OpenCode config directory.

### Recoverable team jobs

All roles share the same recoverable dispatch lifecycle; every agent resolves to a single configured model with no plugin fallback chain. Launch observes for a 300000 ms soft wait window. Expiry returns a recoverable job envelope, not specialist failure, and never aborts the child. Wait uses the same `job_id`, including after a coordinator restart; `wait_ms` is an optional integer 0..300000 (default 300000; zero is a snapshot). Pending/unknown jobs must not trigger duplicate launches, backup models, or silent inline substitution. The consultant integrates the eventual original report and discloses any unresolved independent check.

`return_handle: true` on `janus_dispatch` changes only a successful result: instead of plain text it returns a completed JSON envelope (`job_id`, `role`, `attempt`, `session_id`, `waited_ms`, `text`) whose `session_id` is reusable; pending and failed results are unchanged, and the default success result remains plain text.

`janus_dispatch_continue` reuses an existing dispatch session with a new prompt — a generic mechanism for every dispatcher and role (the consultant uses it for a document's writer feedback loop). Reuse limits: same caller, same workspace, a dispatch-marked target that is a normal job root or its attempt child (never a continuation `job_id` — use the original `session_id`), and an idle target (busy/retrying is rejected with a wait-first error); only terminal jobs are continued, a pending job is waited on. A continuation job's wait/cancel use the same `janus_dispatch_wait`/`janus_dispatch_cancel` contract. There is no new configuration for continuation — no config field, no registry, and no cross-session reuse; in doc mode the session id is stored as `writer_session_id` in the document's brief.

Cancel is explicit and may return `cancelling` until durable abort evidence confirms `cancelled`; normal completion racing cancellation wins and returns the report. Nonterminal envelopes name `janus_dispatch_wait` as their next action. Wait/cancel use the caller's parent session and workspace for ownership, not routing overrides. See [the architecture API contract](architecture.md#64-recoverable-dispatch-api).

## Step 4: Optional Plugin Configuration

The plugin reads an optional JSONC config file. Default locations (first found wins):

1. `$JANUS_CONFIG` - explicit path override
2. `$XDG_CONFIG_HOME/janus-agent/config.jsonc`
3. `~/.config/janus-agent/config.jsonc`

A missing file is fine; all fields have defaults. Create the file to override defaults:

```jsonc
{
  // 11 registered agents, 10 dispatch roles (janus is the non-dispatchable
  // primary). Legacy keys agent_model, lite_*, and verifier_* still work and
  // are normalized to consultant_model, ask_lite_*, and auditor_*.

  "janus_agent": "janus",
  "janus_model": "opencode-go/glm-5.3",
  "janus_enabled": true,

  "consultant_agent": "consultant",
  "consultant_model": "opencode-go/glm-5.3",

  "coder_agent": "coder",
  "coder_model": "opencode-go/glm-5.3",
  "coder_enabled": true,

  "ask_lite_agent": "ask-lite",
  "ask_lite_model": "opencode-go/deepseek-v4.1-flash",
  "ask_lite_enabled": true,
  // "ask_lite_workspace_dir": "~/.local/share/janus-agent/lite",

  "coder_lite_agent": "coder-lite",
  "coder_lite_model": "opencode-go/glm-5.3-flash",
  "coder_lite_enabled": true,

  "explorer_agent": "explorer",
  "explorer_model": "opencode-go/deepseek-v4.1-flash",
  "explorer_enabled": true,
  "analyst_agent": "analyst",
  "analyst_model": "opencode-go/qwen3.8-max",
  "analyst_enabled": true,
  "critic_agent": "critic",
  "critic_model": "opencode/gemini-3.8-flash",
  "critic_enabled": true,
  "arch_critic_agent": "arch-critic",
  "arch_critic_model": "opencode/gemini-3.8-flash",
  "arch_critic_enabled": true,
  "auditor_agent": "auditor",
  "auditor_model": "opencode/gemini-3.8-flash",
  "auditor_enabled": true,

  "writer_agent": "writer",
  "writer_model": "opencode/claude-sonnet-5-5",
  "writer_enabled": true,
  "writer_docs_roots": ["userdoc"],
  // "writer_delegate_agent": "host-writer",
  // "writer_delegate_model": "provider/model",

  // Optional per-mode / per-tier model routing. Precedence:
  // mode_models[mode][role] > tier_models[tier][role] >
  // <role>_model > MODEL_DEFAULTS[role].
  // Legacy mode keys plan/author map to roadmap/doc; role keys use the
  // canonical dispatch names (arch-critic, ask-lite, coder-lite).
  "mode_models": {
    "design": { "arch-critic": "provider/strong-reviewer" },
    "doc": { "writer": "provider/long-context-writer" }
  },
  "tier_models": {
    "deep": { "coder": "provider/strong-coding" }
  },

  // Global model-adaptation blocks, keyed by the provider-agnostic normalized
  // model key. A user value overrides the shipped block; "" disables it.
  // "model_prompts": { "deepseekv41flash": "…" },

  "team_caps": {
    "round_cap": 3,
    "explorer_cap": 5,
    "critic_search_cap": 5
  },

  // Advisory maximum instances per role per tier, never a required roster.
  "tier_role_caps": {
    "fast":     { "explorer": 5, "analyst": 0, "critic": 0, "arch_critic": 0, "auditor": 0, "writer": 0 },
    "standard": { "explorer": 5, "analyst": 1, "critic": 1, "arch_critic": 1, "auditor": 1, "writer": 1 },
    "deep":     { "explorer": 5, "analyst": 3, "critic": 2, "arch_critic": 2, "auditor": 2, "writer": 2 }
  },

  "cost_guard_provider_usd": 10,
  "install_skill": true,
  "install_commands": true,
  "memory_enabled": true,

  // Optional semantic retrieval via an OpenAI-compatible embedding endpoint.
  "embedding": {
    "base_url": "https://api.openai.com/v1",
    "api_key_env": "OPENAI_API_KEY",
    "model": "text-embedding-3-small",
    "dimensions": 1536
  }
}
```

### Field Reference

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `janus_agent` / `janus_model` / `janus_enabled` | string / string / boolean | `"janus"` / `opencode-go/glm-5.3` / `true` | Default general entry (mode `all`, not dispatchable) |
| `consultant_agent` / `consultant_model` | string / string | `"consultant"` / `opencode-go/glm-5.3` | Evidence and document entry; legacy `agent_model` aliases `consultant_model` |
| `coder_agent` / `coder_model` / `coder_enabled` | string / string / boolean | `"coder"` / `opencode-go/glm-5.3` / `true` | Coding entry; L3 work can use the deep-tier override |
| `ask_lite_agent` / `ask_lite_model` / `ask_lite_enabled` | string / string / boolean | `"ask-lite"` / `opencode-go/deepseek-v4.1-flash` / `true` | Economical quick-answer leaf; legacy `lite_*` keys |
| `ask_lite_workspace_dir` | string (optional) | `$XDG_DATA_HOME/janus-agent/lite` | ask-lite's pre-approved writable workspace; legacy `lite_workspace_dir` |
| `coder_lite_agent` / `coder_lite_model` / `coder_lite_enabled` | string / string / boolean | `"coder-lite"` / `opencode-go/glm-5.3-flash` / `true` | Mechanical coding lane (subagent, steps 50) |
| `explorer_agent` / `explorer_model` / `explorer_enabled` | string / string / boolean | `"explorer"` / `opencode-go/deepseek-v4.1-flash` / `true` | Read-only search specialist |
| `analyst_agent` / `analyst_model` / `analyst_enabled` | string / string / boolean | `"analyst"` / `opencode-go/qwen3.8-max` / `true` | Read-only analysis specialist |
| `critic_agent` / `critic_model` / `critic_enabled` | string / string / boolean | `"critic"` / `opencode/gemini-3.8-flash` / `true` | Counter-evidence and plan-robustness reviewer |
| `arch_critic_agent` / `arch_critic_model` / `arch_critic_enabled` | string / string / boolean | `"arch-critic"` / `opencode/gemini-3.8-flash` / `true` | One-way design pre-mortem and coder plan/diff review |
| `auditor_agent` / `auditor_model` / `auditor_enabled` | string / string / boolean | `"auditor"` / `opencode/gemini-3.8-flash` / `true` | Source influence/independence audit; legacy `verifier_*` keys |
| `writer_agent` / `writer_model` / `writer_enabled` | string / string / boolean | `"writer"` / `opencode/claude-sonnet-5-5` / `true` | Scoped-write author executor and sole prose author |
| `writer_docs_roots` | string[] | `["userdoc"]` | Project-relative writer roots; `[]` = read-only fallback |
| `writer_delegate_agent` / `writer_delegate_model` | string (optional) / string (optional) | (none) | Host-provided writer; the bundled writer is not registered when set |
| `mode_models` | object (optional) | (none) | Per-mode role→model overrides; legacy `plan`/`roadmap`, `author`/`doc` keys normalize |
| `tier_models` | object (optional) | (none) | Per-tier role→model overrides |
| `model_prompts` | object (optional) | (none) | Model-keyed adaptation blocks; `""` disables a model's block |
| `team_caps.round_cap` / `explorer_cap` / `critic_search_cap` | number | `3` / `5` / `5` | Team loop and fan-out maximums |
| `tier_role_caps.*` | object | fast `5/0/0/0/0/0`, standard `5/1/1/1/1/1`, deep `5/3/2/2/2/2` | Advisory maximum instances per role per tier (explorer/analyst/critic/arch_critic/auditor/writer) |
| `cost_guard_provider_usd` | number | `10` | Advisory stop-loss per provider |
| `install_skill` | boolean | `true` | Install the three consultation skills |
| `install_commands` | boolean | `true` | Install the `janus-memory` and `janus-models` commands |
| `memory_enabled` | boolean | `true` | Register and launch the memory MCP server |
| `embedding.*` | object (optional) | (none) | All-or-nothing OpenAI-compatible embedding configuration |

The `embedding` block is all-or-nothing: set all four sub-fields or omit the block.

Every role has one configured attempt and every agent resolves to a single model, with no plugin fallback advance. A delegate without `writer_delegate_model` uses host model selection (`null` in the durable job spec); it keeps host permissions and host-internal retry behavior. Neither wait expiry nor unknown observation authorizes a backup model.

The consultant routes bounded tasks to its review/research team: `explorer` gathers missing evidence, `analyst` interprets material disputes, `critic` challenges consequential conclusions and plan uncertainty, `arch-critic` pre-mortems one-way designs and reviews the coder's plan/diff against `design.md`, `auditor` audits unclear influence or independence of user/third-party/promotional sources, and `writer` is the sole author of doc-mode prose — it produces the blueprint before outline approval and drafts, maintains, and writes approved document files afterward (scoped write) or returns prose for the consultant to publish (read-only fallback). A check is delegated when it could materially affect the answer and the consultant can name the decision it could change and the specific failure it would catch; a role is skipped only with that reason. These roles are not a tier-dependent required roster. The plugin-owned review subagents (`explorer`, `analyst`, `critic`, `arch-critic`, `auditor`) have `permission.edit = "deny"`, `permission.bash = "deny"`, and `permission.task = "deny"`; the plugin-owned `writer` is a scoped-write leaf — `edit` is denied everywhere except `<writer_docs_roots>/**`, `bash` and `task` are denied, and `webfetch`/`websearch` are allowed for targeted lookups with a source ledger. An external `writer_delegate_agent` keeps its host-defined permissions and does not inherit these restrictions. The default consultant, analyst, critic, arch-critic, and auditor use different model families from the roles they audit where possible; the plugin does not enforce model diversity. Role caps are advisory ceilings rather than a runtime-enforced scheduler.

The author brief lives at `$XDG_DATA_HOME/janus-agent/author/<projectId>/<docId>/brief.md` (fixed location; `<projectId>` derives from the project directory). The consultant creates and updates it; the writer reads it and never writes it. In scoped-write mode the consultant does not edit files under the writer roots — it reviews the writer's diff and requests bounded writer fixes.

The consultant owns the `design` mode: it decides architecture, module boundaries, and interfaces layer by layer, records the result in `design.md`, and hands the record to `coder` for an implementation plan. The design state lives at `$XDG_DATA_HOME/janus-agent/design/<projectId>/<designId>/design.md`; `coder` reads it and writes `plan.md` in the same directory. Both agents have pre-approved `external_directory` access to `<designStateDir>/**`; neither writes design state into the project tree. The consultant may route a bounded quick-answer subtask to `ask-lite` and a bounded code example to `coder`; it does not implement production code itself. Coding is owned by `coder`: fully specified mechanical work goes to `coder-lite` (workspace edits allowed, external edits ask, further dispatch denied — its stop-and-report is a legitimate partial outcome the dispatcher integrates); judgment-heavy work stays with `coder`, and L3 work can be dispatched with `tier: "deep"` for a stronger configured model. `coder` selects L0/L1/L2/L3 process weight by task complexity and gates L2/L3 on user approval before editing.

The `janus` agent is the default general entry: it handles general questions and light tasks, and routes consulting to `consultant`, coding to `coder`, quick answers to `ask-lite`, and bounded evidence gathering to `explorer` — all through the same `janus_dispatch` mechanism. When dispatching `consultant`, janus includes `Memory ownership: consultant saves` because janus does not keep consultation memory. It does not do deep research or heavy coding itself. `consultant` and `coder` are therefore also dispatch roles (targeting their agents by name); `consultant` follows `consultant_model` (legacy `agent_model`), `coder` follows `coder_model`.

### Model-adaptation prompts

Every plugin-owned agent's prompt assembles in this order: the role asset
(`assets/agents/<agent>.md` — identity, scope, workflow, discipline), a
model-adaptation block, the shared fragments
(`assets/principles/research-leaf.md` for the five read-only review/research roles,
`assets/principles/reasoning-failures.md` for the analyst and critic, and
`assets/principles/dispatch-hub.md` for `janus`/`consultant`/`coder`), the
engineering principles (`assets/principles/engineering-principles.md` for
`coder`, `arch-critic`, and the `consultation-design` skill), the
common base (`assets/principles/common-base.md` — epistemic honesty, untrusted
input, secrets, and scope/conflict rules for every role), the common write gate
(`assets/principles/common-write.md` — persistent file-change confirmation,
omitted for read-only roles), and finally the runtime bindings (injected at the
asset's `RUNTIME-BINDINGS` placeholder). The model block is keyed by
the **model**, not the agent, and matched **provider-agnostically**: swap an
agent's model in config (even to a different provider serving the same model)
and its driving notes follow automatically; a model with no block simply gets
none.

A model id (`provider/model`) is normalized into a single match key by
`normalizeModelKey`:

1. drop the provider prefix — everything up to and including the last `/`
   (`opencode-go/deepseek-v4-pro` → `deepseek-v4-pro`);
2. lowercase the remainder;
3. keep only letters and digits — strip `-`, `.`, spaces, etc.
   (`deepseek-v4-pro` → `deepseekv4pro`).

So `deepseek/deepseek-v4-pro` and `opencode-go/deepseek-v4-pro` both resolve to
`deepseekv4pro` and share one block. Resolution, for that normalized key, is:

1. your `model_prompts` entry for the key wins (an explicit `""` disables the
   block for that model across every provider);
2. else the shipped library block `assets/model-prompts/<key>.md`;
3. else empty — the role asset runs standalone.

Eight blocks ship, each file named by its normalized key: six for the shipped
default models — `glm53.md` (GLM-5.3; default for consultant, janus, and coder),
`deepseekv41flash.md` (DeepSeek V4.1-Flash; default for ask-lite and explorer),
`qwen38max.md` (Qwen3.8-Max; default for analyst), `gemini38flash.md` (Gemini
3.8-Flash; default for critic, arch-critic, and auditor), `glm53flash.md` (GLM-5.3-Flash;
default for coder-lite), and `claudesonnet55.md` (Claude Sonnet 5.5; default
for writer) — plus `deepseekflash.md` for the direct-provider id
`deepseek/deepseek-flash` (the same V4.1-Flash model, but a different
normalized key), and `gemini4argon.md` for the optional Gemini 4 Argon
override (`opencode-go/gemini-4-argon`).

To add a block for a model that has none: name the file after the model's
normalized key — the same rule above applied to the model id — drop it at
`assets/model-prompts/<key>.md`, and add the file to `REQUIRED_INSTALLED_FILES`
in `script/install-local.ts` (a fork; installs verify the file). For example a
custom model `acme/deepseek-v4-pro` gets the key `deepseekv4pro` and file
`assets/model-prompts/deepseekv4pro.md`. On an installed plugin you cannot drop
files: point `model_prompts` at your own block text for that key instead.

Block content is model-property only — the model's capability profile,
documented failure tendencies (agentic strength, reasoning/knowledge balance,
calibration, verbosity, long-context steering, protocol precision), and
agent-actionable operating constraints that leverage strengths or control
weaknesses (when to stop, how to verify, how to re-anchor context, how to
control output). Runtime controls — thinking level, reasoning effort,
temperature, max tokens, model selection — are deployment settings, not prompt
content. It carries no role name, role assignment, role rule, price/pool
positioning, or generic output/workflow rule; those live in the agent asset,
because one block drives every agent running that model. Delegated writers
target host-owned agents and take no model prompts.

## Data, State, and Cache Paths

The memory SQLite store uses XDG Base Directory paths with environment overrides:

| Path | Default | What lives there |
|------|---------|------------------|
| Data | `$XDG_DATA_HOME/janus-agent/` (default `~/.local/share/janus-agent/`) | `memory.sqlite3` and user-controlled exports |
| State | `$XDG_STATE_HOME/janus-agent/` (default `~/.local/state/janus-agent/`) | Writer lock, pending enrichment state, operational records |
| Cache | `$XDG_CACHE_HOME/janus-agent/` (default `~/.cache/janus-agent/`) | Rebuildable query caches |

The database file defaults to `<dataDir>/memory.sqlite3`. Override with the `JANUS_DATA_DIR`, `JANUS_STATE_DIR`, and `JANUS_CACHE_DIR` environment variables when launching the MCP server.

Canonical experience records (user-approved items, claims, evidence, decisions, preferences, revisions) live in the data directory. Derived artifacts (summaries, embeddings, FTS indexes, tags) are rebuildable and live alongside canonical data but can be deleted and rebuilt without losing accepted experience.

The author state directory lives at `$XDG_DATA_HOME/janus-agent/author` (default `~/.local/share/janus-agent/author`). It holds one consultant-written brief per document at `author/<projectId>/<docId>/brief.md`; the writer has read access to it and never writes it. Removing it discards author-mode state; the consultant can rebuild a brief from a legacy document via the three-option prompt.

The design state directory lives at `$XDG_DATA_HOME/janus-agent/design` (default `~/.local/share/janus-agent/design`). It holds per-project design records at `design/<projectId>/<designId>/design.md` and the coder's `plan.md`; when a plan has no design record it lives at `design/<projectId>/<planId>/plan.md`. `design.md` is a current-state document (rewritten in place, about 200–300 lines); deleting it needs user confirmation, while deleting a folded `plan.md` does not. Removing the directory discards design state.

## Step 5: Verify the Install

1. **Entries selectable**: start OpenCode and confirm `janus`, `consultant`, `coder`, and `ask-lite` appear in the agent list.
2. **ask-lite workspace**: `~/.local/share/janus-agent/lite` exists and is the only pre-approved write location.
3. **coder-lite lane registered**: the `coder-lite` agent appears as a subagent (steps 50, workspace-allow edits, task denied).
4. **Memory MCP starts**: the `janus-memory` MCP server is registered. Its five tools (`memory_recall`, `memory_expand`, `memory_prepare`, `memory_commit`, `memory_manage`) are available to the consultant agent.
5. **Review subagents registered**: `explorer`, `analyst`, `critic`, `arch-critic`, `auditor` (read-only), and `writer` (scoped-write: edits allowed only under `userdoc/**` unless `writer_docs_roots` is changed) appear as subagents (mode `subagent`), dispatched by the consultant via the `janus_dispatch` tool.
6. **Skills present**: `consultation/SKILL.md`, `consultation-design/SKILL.md`, and `consultation-doc/SKILL.md` exist under `~/.config/opencode/skills/` (or your `$OPENCODE_CONFIG_DIR/skills/`); the design and doc sub-skills contain their mode templates.
7. **Design state**: `~/.local/share/janus-agent/design` exists; the consultant and coder prompts name the project design dir, and their permission maps allow `<designStateDir>/**`.
8. **Commands present**: `commands/janus-memory.md` and `commands/janus-models.md` exist under `~/.config/opencode/` (or your `$OPENCODE_CONFIG_DIR/commands/`).

You can also run the automated integration proof:

```bash
bun run integration
```

This spawns an isolated OpenCode server in a temp sandbox (never touching your real config or DB), loads the plugin, and asserts the agent, MCP, and skill are registered. It prints a PASS/FAIL summary per assertion. If `opencode` is not on PATH, it prints SKIP and exits 0.

By default it loads the packaged `dist/index.js`. To prove an installed bundle — the artifact the deployment rule requires — pass its path:

```bash
JANUS_PLUGIN_ENTRY=~/.local/share/janus-agent-plugin/dist/index.js bun run integration
```

## Running Tests, Typecheck, Build, and Install

```bash
bun test                     # all unit tests (co-located *.test.ts, bun:test)
bun run typecheck            # tsc --noEmit across the workspace
bun run gen:skill            # regenerate the three skills from skill-src/
bun run build                # regenerate the three skills, then bundle adapter + memory-mcp into dist/
bun run install:local        # build, then install the bundle into the install prefix
bun run integration          # isolated OpenCode integration proof (skips if opencode is absent)
bun run evals/run-evals.ts   # print the evaluation checklist (no live model calls)
```

The evaluation fixtures under `evals/fixtures/` encode the architecture verification scenarios. Deterministic cases map to package unit tests; model-graded cases print a reviewer rubric. See [evals/README.md](../evals/README.md) for details.

## Uninstall

1. **Remove the plugin entry** from your OpenCode config. Edit `~/.config/opencode/opencode.json` and remove the `file://` entry from the `plugin` array.

2. **Remove the installed bundle:**

   ```bash
   rm -rf ~/.local/share/janus-agent-plugin
   ```

   Or remove `$JANUS_INSTALL_DIR` if you set one.

3. **Remove the installed skill** (optional):

   ```bash
   rm -rf ~/.config/opencode/skills/consultation ~/.config/opencode/skills/consultation-design ~/.config/opencode/skills/consultation-doc
   ```

4. **Remove the installed commands** (optional):

   ```bash
   rm -f ~/.config/opencode/commands/janus-memory.md ~/.config/opencode/commands/janus-models.md
   ```

5. **Remove the plugin config file** (optional):

   ```bash
   rm -f ~/.config/janus-agent/config.jsonc
   ```

   Or if you used `$XDG_CONFIG_HOME`:

   ```bash
   rm -f "$XDG_CONFIG_HOME/janus-agent/config.jsonc"
   ```

6. **Remove the memory data, state, and cache** (optional, this deletes all stored experience):

   ```bash
   rm -rf ~/.local/share/janus-agent
   rm -rf ~/.local/state/janus-agent
   rm -rf ~/.cache/janus-agent
   ```

   Or with custom XDG paths:

   ```bash
   rm -rf "$XDG_DATA_HOME/janus-agent"
   rm -rf "$XDG_STATE_HOME/janus-agent"
   rm -rf "$XDG_CACHE_HOME/janus-agent"
   ```

7. **Remove ask-lite's workspace (optional):** `rm -rf ~/.local/share/janus-agent/lite`.

8. **Restart OpenCode** to confirm the plugin is no longer loaded.
