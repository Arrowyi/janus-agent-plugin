# janus-agent-plugin

Janus is a daily-driver agent family for [OpenCode](https://opencode.ai) — three teams share one plugin: a consultation team (`consultant`), an R&D team (`architect` + `coder`), and a documentation team (`author` with `author-writer` and `author-reviewer`), with `janus` as the default front desk, `simple` as the economical quick-answer leaf, and a shared local memory.

## What you get

| Agent | Default model | What it does |
|-------|---------------|--------------|
| `janus` (primary/all) | `opencode-go/glm-5.3-flash` | Default front desk, not dispatchable. Handles general questions and light tasks, and routes: quick answers to `simple`, evidence to `consultant`, design to `architect` (you switch), coding, code comments, `AGENTS.md`, and ≤ 2-edit doc syncs to `coder`, and substantive documentation to `author` (`janus_dispatch` with `role="author"`, or you switch). Does not do deep research, design, documentation, or heavy coding itself |
| `simple` (primary/all) | `opencode-go/deepseek-v4.1-flash` | Economical quick-answer leaf: facts, concepts, simple how-to. Never dispatches; escalates evidence to `consultant`, design to `architect`, coding to `coder`, documents to `author` |
| `consultant` (primary) | `opencode-go/gemini-4-argon` | Consultation-team entry for five evidence modes: `select`, `verify`, `roadmap`, `research`, `guide`. Leads `common-explorer`, `consultant-analyst`, `consultant-critic`, and `consultant-auditor`; hands design to `architect` and documents to `author` |
| `architect` (primary) | `opencode-go/gemini-4-argon` | R&D-team design entry, not dispatchable. Runs brainstorming ⇄ convergence ⇄ system/module design; dispatches `common-explorer`, `coder-reviewer` (design pre-mortem), `consultant-analyst`, `consultant-auditor`, and `simple` for evidence and review, `coder` to implement an accepted `design.md`, and `author` for substantive architecture/design documentation. It is the sole author of `design.md`; the coder treats the record as read-only |
| `coder` (primary/all) | `opencode-go/glm-5.3` | R&D-team coding entry. Starts from a bug/feature/refactor or an accepted `design.md`; picks L0–L3 process weight, dispatches `coder-lite`, `coder-reviewer` (plan/diff review), and `common-explorer`, and escalates architecture work to `architect`. Hands substantive documentation to `author`; code, tests, comments, `AGENTS.md`, and ≤ 2-edit doc syncs stay in R&D. L3 can use a deep-tier model override (`opencode-go/kimi-k3.1-pro`) |
| `author` (primary) | `opencode-go/gemini-4-argon` | Documentation-team entry. Owns doc profiles, the outline gate, the author brief, verification, and publishing; dispatches `author-writer` for prose, `author-reviewer` for the independent post-draft review, `common-explorer` for research, `coder` for L0 executable verification, `consultant-critic`, and `simple`. Dispatchable for substantive documentation from top-level entries (`janus_dispatch` with `role="author"`), but not from a session that was itself dispatched |
| `common-explorer` (subagent) | `opencode-go/deepseek-v4.1-flash` | Shared research floor for all three teams: external documentation, open-source practice, and bounded codebase survey. Read-only leaf |
| `consultant-analyst` (subagent) | `opencode-go/kimi-k3.1-pro` | Consultation-team reasoning: causal mechanism, outside view, assumption checks, competing hypotheses |
| `consultant-critic` (subagent) | `opencode/claude-sonnet-5-5` | Consultation-team challenger: counter-evidence, hypothesis matrices, plan robustness |
| `consultant-auditor` (subagent) | `opencode-go/grok-4.7` | Consultation-team source-intent audit: shilling, smear campaigns, undisclosed sponsorship |
| `coder-reviewer` (subagent) | `opencode/claude-sonnet-5-5` | R&D-team reviewer: one-way design pre-mortems for `architect`, and `plan.md`/diff review for `coder` |
| `author-writer` (subagent) | `opencode/claude-sonnet-5-5` | Documentation-team's sole author of reader-facing prose. Writes directly under `writer_docs_roots` (default `userdoc`); for an approved path outside the roots (such as `README.md` or `docs/**`), or when the roots are `[]`, it returns prose or a patch in read-only mode and `author` applies it. Never writes source, config, build files, or `AGENTS.md` |
| `author-reviewer` (subagent) | `opencode-go/kimi-k3.1-pro` | Documentation-team's independent read-only reviewer: after the final draft it checks facts and sources against the source ledger, alignment with the brief, and readability. Required for `architecture` documents and for `targeted`/`strict` verification; skipped for `light` non-architecture documents and `briefWaived` micro-fixes |
| `coder-lite` (subagent) | `opencode-go/glm-5.3-flash` | Junior/mid engineer lane for planned milestones and spec-complete coding: unit tests, batch edits, formatting/lint fixes. Workspace edits allowed; project-native build/test commands allowed with VCS-write/destructive guardrails; stops and reports up on ambiguity |
| `janus-memory` (MCP: Model Context Protocol, a local tool-server interface) | — | Local SQLite memory shared across the family: auto-saved consultation records, recall, edit, delete, outcome feedback |
| `janus-models` (command) | — | Model-rotation entry: inventory the 14 agents, evaluate model/prompt fit, and apply approved model or routing changes to the user-level Janus config |
| `janus-handoff` (command) | — | Cross-team handoff operator: list (newest first, top 10), view, use (`use`/`继续`), delete, export, and import stateless `handoff.md` documents for topics moving between the primary entries |
| `janus-config` (command) | — | Guided editor for the plugin config file: browse every setting by group, see its current value, default, and choices, then set, clear, reset, or validate it with a preview and confirmation |

That is 14 agents: 6 primary entries (`janus`, `simple`, `consultant`, `architect`, `coder`, `author`) and 8 subagents. Twelve are dispatchable; only `janus` and `architect` are not.

### Which agent should I use?

```text
General question / unsure          -> janus
Evidence, comparison, verify,
research, personal roadmap, guide  -> consultant
System/module/interface design     -> architect
Bug, feature, refactor, tests      -> coder
Tutorial, course, durable document -> author
Quick fact / how-to                -> simple
```

Start at `janus` when unsure; start directly at the specialist when you already know the task type. `coder-lite` is normally dispatched by `coder`, not selected directly.

Every agent's model is configurable (`*_model` fields), and every prompt layers a role asset with an optional model-adaptation block keyed by the model (`model_prompts` map overrides the shipped `assets/model-prompts/` library, extendable by dropping a file) — swap a model, keep the role, and the driving notes follow the model. The block describes the model, never the role: a model profile plus agent-actionable operating notes for using its strengths and controlling its weaknesses; runtime settings stay in config, and the same block serves every agent running that model. Blocks are matched **provider-agnostically**: a model id is normalized by dropping the provider prefix (everything before the last `/`), lowercasing, and keeping only letters and digits, so `deepseek/deepseek-v4-pro` and `opencode-go/deepseek-v4-pro` both resolve to the same key `deepseekv4pro` (see the "模型适配提示词" section of [docs/deployment.md](docs/deployment.md)).

## Prerequisites

- [OpenCode](https://opencode.ai) (the agent harness)
- [Bun](https://bun.sh) >= 1.1 (runs the local memory MCP server and the installer)
- The shipped model defaults assume an **OpenCode Go (Go Plus) subscription** for the `opencode-go/*` pool models, plus the `opencode` provider (Zen pay-per-use) for `consultant-critic`, `coder-reviewer`, and `author-writer` (`claude-sonnet-5-5`). Without these, set every `*_model` to a provider configured on your machine — see the [non-Go example](docs/deployment.md) in the deployment guide. Dispatch failures print a remediation hint naming the exact config field.

## Install

```bash
git clone https://github.com/Arrowyi/janus-agent-plugin.git
cd janus-agent-plugin
bun install

# Build and install the packaged bundle into ~/.local/share/janus-agent-plugin
bun run install:local
```

Register the printed entry in `~/.config/opencode/opencode.json` (create if missing):

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///home/you/.local/share/janus-agent-plugin/dist/index.js"]
}
```

Restart OpenCode. The plugin registers the 14 agents, the memory MCP, the `consultation`, `consultation-design`, `consultation-doc`, and `handoff` skills, the `/janus-memory`, `/janus-models`, `/janus-handoff`, and `/janus-config` commands, the four dispatch tools (`janus_dispatch`, `janus_dispatch_wait`, `janus_dispatch_cancel`, `janus_dispatch_continue`), and the `janus_config` and `janus_provider_keys` tools automatically. The install also stages the `bin/janus-keys` terminal tool, the only place a provider key value is entered.

## Usage

**Ask the consultant.** It detects the mode and delivers the matching answer. For non-trivial answers it may add a one-line mode note after the conclusion (e.g. “模式：select（购买决策）”), never before it:

| Mode | Triggers on | You get |
|------|--------------|---------|
| `select` | choosing among candidates — 买哪个、选课、选工具 | the pick (or "no clear winner" with a tie-break), 2–3 reasons, and a trial/switch action; evidence is folded away |
| `verify` | checking a claim or rumor — 这说法是不是真的 | true / false / unverifiable first, then the key reasons, what would change the verdict, and the next evidence step |
| `roadmap` | an actionable personal plan — 健身、保养、学习路线 | feasibility first (可行 / 有条件可行 / 不建议), then constraints, steps, stop/rollback, and an alternative |
| `guide` | a composite end-to-end package — 攻略、X入门 | the shortest path, steps, pitfalls, completion check, and a recommendation/alternative only when there are real choices |
| `research` | understanding a topic deeply — 深度研究、调查一下 | a bottom line, 3–5 plain-language points, what it means for you, and what is still uncertain; no forced recommendation |
| `doc` | a durable document to keep or share — 教程、架构分析文档、write-up | a document delivery brief (status, location, scope, verification, next action); the document itself is the artifact |
| `design` | deciding the future structure — 架构设计、模块设计、接口设计 | the decision record: layer, goal/constraints, quality scenarios, options and trade-offs, recommendation, risks/reversibility, open questions — written to `design.md` and handed to `coder` for an implementation plan |

Answers are terminal-first: a full answer opens with `结论 / 理由 / 下一步`, ends with `一句话 / 下一步`, and puts evidence under `证据与来源（可跳过）`. Short answers skip the repetition. Facts are separated from inference and labeled with an epistemic status.

**Daily questions go to `simple`.** Select the `simple` agent for quick lookups and explanations at a fraction of the cost; it escalates to `consultant` (one line, with a reason) when a question needs multi-source adversarial verification or is high-stakes, to `architect` for design, and to `author` for documents. **Coding goes to `coder`**, which picks the lightest process that fits: a direct fix for a one-line change, a brief plan for a small feature, and a design gate plus quality gate for multi-file or correctness-critical work.

**Memory.** Consultations auto-save (question + conclusion summaries — never transcripts). Browse and manage them with the `/janus-memory` command or the `janus-memory` CLI. Prior experience and preferences surface in later consultations, with an outcome-feedback loop.

**Models.** Run `/janus-models` for an explicit, interactive model-rotation workflow. With no arguments it inventories every suite agent's effective model and prompt source, then offers a menu: model evaluation, `model_prompt` evaluation, a combined recommendation, or execution. Model and prompt changes are written only to the user-level Janus config; the command shows an exact diff and waits for confirmation before writing. `/janus-models 帮助` lists the argument forms.

**Settings.** Run `/janus-config` to change any plugin setting without touching JSON. With no arguments it shows the config file path and nine numbered groups (role switches and names, role models, advanced routing, model prompts, team caps, document writer, simple workspace, memory/embedding, install), plus group 10 for provider keys. Pick a group to see every field with its current value, default, and source. Pick a field to get numbered choices for its type; model fields list candidates from `opencode models`. Every write goes through the plugin's `janus_config` tool: it validates against the config schema, shows a preview diff, waits for your confirmation, keeps your comments, and leaves a `.bak` backup. Shortcuts such as `/janus-config 设 author_writer_enabled false`, `/janus-config 清除 team_caps.round_cap`, and `/janus-config 校验` skip the menus.

**Provider keys.** Group 10 of `/janus-config` (or `/janus-config key`) manages OpenCode's provider API keys. It lists the providers that have a key, which named key is active, how many candidates each one has, and whether a switch is waiting for a restart. It can also search the full provider catalog. Each provider can hold several named keys, for example `work` and `personal`. You can switch between them, rename them, or delete them. Switching writes the chosen key into OpenCode's `auth.json` (backed up first) and needs a full OpenCode restart; the command prints the exact steps to confirm the switch and to roll it back. On first use it offers to save your existing unnamed keys under the name `default`, and it will not switch away from an unnamed key, so no key is ever lost. Keys are added only in a terminal, so a key never enters the conversation: `~/.local/share/janus-agent-plugin/bin/janus-keys add <provider> <name> --use` prompts twice with hidden input. It also accepts `--stdin` (for example `pbpaste | …`) or `--env VAR`. Candidates live in `~/.local/share/janus-agent/provider-keys.json` (mode 600), and every output masks keys as `sk-…ab12`.

**Documents.** A durable document is produced by a three-seat loop. `author` owns intake, evidence, the outline approval, the brief, verification, and publishing. `author-writer` is the sole author of reader-facing prose. `author-reviewer` is an independent read-only reviewer that audits the finished draft (facts and sources against the source ledger, brief alignment, readability) before publishing; it is required for `architecture` documents and for `targeted`/`strict` verification, and skipped for `light` non-architecture documents and `briefWaived` micro-fixes. If it is disabled or fails, the delivery says so instead of claiming a review. Under `writer_docs_roots` (default `userdoc`), `author-writer` writes the approved files itself. For an approved path outside the roots (such as `README.md` or `docs/**`), or with `writer_docs_roots: []`, it runs read-only and returns prose or a patch; `author` applies it to disk, and `author-reviewer` audits the written file. A typo, punctuation fix, or broken relative link (at most two mechanical edits) on a brief-less document under `writer_docs_roots` takes the `briefWaived` fast path: one delta-sized `author-writer` dispatch plus an `author` diff check, with no reviewer. Substantive documentation reaches `author` from `janus`, `architect`, or `coder` (`janus_dispatch` with `role="author"`) or by you switching to it; a session that was itself dispatched cannot dispatch `author`. Code comments, `AGENTS.md`, and ≤ 2-edit doc syncs tied to a code change stay with `coder` or inline. A document's writer session is reused across its feedback turns: the first author-writer dispatch captures a session handle (`return_handle: true`), the brief stores it as `writer_session_id`, and later bounded edits continue that session via `janus_dispatch_continue`.

**Design.** A structural decision goes to `architect` (architecture, module boundaries, interfaces), not to `select` or a doc-mode architecture write-up. The architect loads `consultation-design` and works layer by layer: each decision brings at least two real options, a recommendation, what would change it, and a one-way/two-way reversibility label; one-way doors are approved individually and get a `coder-reviewer` pre-mortem, two-way doors get a default and one batch approval per layer. The result is a self-contained `design.md` at `~/.local/share/janus-agent/design/<projectId>/<designId>/design.md` — the architect is its sole writer, the `coder` treats it as 100% read-only, writes its `plan.md` beside it, then implements with a reduced L2 gate and a plan↔design check, and deletes the landed temporary `plan.md` without confirmation. Both roles have pre-approved access to that directory only; nothing is written into your project tree. See the "数据、状态与缓存路径" section of [docs/deployment.md](docs/deployment.md).

**Cross-team handoff.** When a topic moves between primary entries (`consultant -> architect -> coder -> author`, including a coder escalation to `architect`), the current entry records a stateless `handoff.md` at `~/.local/share/janus-agent/handoff/<projectId>/<handoffId>/handoff.md` — created or updated only at the end of a turn that explicitly initiates a handoff, never on pickup. The file carries a ≤ 80-line `## 1. 背景与当前定论` (settled `[C]` conclusions, open `[Q]` questions, link-only artifact pointers) plus a newest-first `## 2. 交接记录与下一跳指引` in which only the newest hop keeps its `建议下一跳` and `默认接力任务`; a receiver reads the first 120 lines read-only, and every turn that writes the file ends with `交接单: <handoff-id>`. The `handoff` skill carries the portable contract (OpenCode, Cursor, Claude Code). Run `/janus-handoff` to list (newest first, top 10), view, use, delete, export, or import handoffs; the five primary entries share write access to the directory, leaf subagents never write it.

**Configuration.** Optional JSONC config at `~/.config/janus-agent/config.jsonc` (or `$JANUS_CONFIG` / XDG): per-agent names/models/enable flags, `mode_models` and `tier_models` routing overrides, model-prompt overrides/disable markers, `writer_docs_roots`, team caps, memory and embedding settings. The full field reference lives in [docs/deployment.md](docs/deployment.md).

**Verify your install:**

```bash
JANUS_PLUGIN_ENTRY=~/.local/share/janus-agent-plugin/dist/index.js bun run integration
```

The isolated integration proof spawns a sandboxed OpenCode server and asserts the 14 agents, the memory MCP, the four skills, the installation and contract content of the `janus-models.md`, `janus-handoff.md`, and `janus-config.md` command files, the state directories, and the host dispatch primitives work — it never touches your real config or data (all four slash commands and the six tools are covered by `plugin.test.ts`).

## Development

```bash
bun test                     # all unit tests
bun run typecheck            # tsc --noEmit
bun run build                # regenerate the skills, then bundle adapter + memory MCP into dist/
bun run gen:skill            # regenerate the four skills from skill-src/
bun run install:local        # build + install the bundle (replaces the installed one)
bun run integration          # isolated OpenCode integration proof
bun run evals/run-evals.ts   # print the evaluation checklist
```

TypeScript strict, zod, SQLite FTS5 (SQLite full-text search), five-package Bun workspace, no native dependencies. Harness-neutral core packages (`consultation-core`, `memory-core`); host-specific code stays in the adapters.

The four skills are generated: edit `skill-src/consultation/**`, `skill-src/consultation-design/**`, `skill-src/consultation-doc/**`, and `skill-src/handoff/**`, run `bun run gen:skill`, and never hand-edit `assets/skills/*/SKILL.md` (`gen-skill.test.ts` fails on drift). Shared prompt fragments live in `assets/principles/`; every assembled role prompt has a reviewed golden under `packages/opencode-adapter/src/prompt-snapshots/`, refreshed with `UPDATE_PROMPTS=1 bun test packages/opencode-adapter/src/prompt-snapshots.test.ts` after reviewing the diff.

**Deployment rule:** always deploy the packaged bundle — never point an OpenCode config at the repo source. The installed bundle is self-contained (no `node_modules` required at runtime).

## Documentation

- [docs/deployment.md](docs/deployment.md) — install, full configuration reference, model prerequisites, uninstall
- [docs/architecture.md](docs/architecture.md) — architecture specification
- [docs/design.md](docs/design.md) — reference design for the agents, their models and permissions
- [evals/README.md](evals/README.md) — evaluation fixtures and grading
