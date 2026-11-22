# janus-agent-plugin

Janus is a daily-driver agent family for [OpenCode](https://opencode.ai) — three teams share one plugin: a consultation team (`consultant`), an R&D team (`architect` + `tech-lead` with a dual-tier `coder` and the `solution-reviewer`/`coder-reviewer` gates), and a documentation team (`author` with `author-writer` and `author-reviewer`), with `janus` as the default front desk, `simple` as the economical quick-answer leaf, and a shared local memory.

## What you get

| Agent | Default model | What it does |
|-------|---------------|--------------|
| `janus` (primary/all) | `opencode-go/glm-5.3-flash` | Default front desk, not dispatchable. Handles general questions and light tasks, and routes: quick answers to `simple`, evidence to `consultant`, design to `architect` (you switch), coding, code comments, `AGENTS.md`, and ≤ 2-edit doc syncs to `tech-lead`, and substantive documentation to `author` (`janus_dispatch` with `role="author"`, or you switch). Does not do deep research, design, documentation, or heavy coding itself |
| `simple` (primary/all) | `opencode-go/deepseek-v4.1-flash` | Economical quick-answer leaf: facts, concepts, simple how-to. Never dispatches; escalates evidence to `consultant`, design to `architect`, coding to `tech-lead`, documents to `author` |
| `consultant` (primary) | `opencode-go/gemini-4-argon` | Consultation-team entry for five evidence modes: `select`, `verify`, `roadmap`, `research`, `guide`. Leads `common-explorer`, `consultant-analyst`, `consultant-critic`, and `consultant-auditor`; hands design to `architect` and documents to `author` |
| `architect` (primary) | `opencode-go/gemini-4-argon` | R&D-team design entry, not dispatchable. Runs brainstorming ⇄ convergence ⇄ system/module design; dispatches `common-explorer`, `solution-reviewer` (design pre-mortem), `consultant-analyst`, `consultant-auditor`, and `simple` for evidence and review, `tech-lead` to implement an accepted `design.md`, and `author` for substantive architecture/design documentation. It is the sole author of `design.md`; the tech-lead treats the record as read-only |
| `tech-lead` (primary/all) | `opencode-go/glm-5.3` | R&D-team thin controller, dispatchable as `role: "tech-lead"`. Reads an accepted `design.md` (100% read-only) or the raw requirement, writes `plan.md` beside it, then schedules isolated `coder` and reviewer sessions milestone by milestone — it never writes business code itself. Code comments, `AGENTS.md`, and ≤ 2-edit doc syncs stay in R&D; substantive documentation goes to `author` |
| `coder` (subagent, dual-tier) | `opencode-go/glm-5.3` (`tier: "fast"` → `opencode-go/glm-5.3-flash`, `tier: "standard"` → `opencode-go/deepseek-v4.1-flash`) | Dual-tier execution leaf dispatched by `tech-lead`, 80-step cap. `tier: "standard"` (Senior) writes L3 high-risk core logic and its red-green tests; `tier: "fast"` (Junior) writes L1/L2 spec-complete modules, CRUD/schema/glue code, unit tests from a scenario checklist, and one-off probes. Workspace edits allowed; project-native build/test commands allowed with VCS-write/destructive guardrails; stops and reports up on ambiguity |
| `author` (primary) | `opencode-go/gemini-4-argon` | Documentation-team entry. Owns doc profiles, the outline gate, the author brief, verification, and publishing; dispatches `author-writer` for prose, `author-reviewer` for staged independent reviews scaled by document level (`D0`–`D3`), `common-explorer` for research, `coder` for L0 executable verification, `consultant-critic`, and `simple`. Dispatchable for substantive documentation from top-level entries (`janus_dispatch` with `role="author"`), but not from a session that was itself dispatched |
| `common-explorer` (subagent) | `opencode-go/deepseek-v4.1-flash` | Shared research floor for all three teams: external documentation, open-source practice, and bounded codebase survey. Read-only leaf |
| `consultant-analyst` (subagent) | `opencode-go/kimi-k3.1-pro` | Consultation-team reasoning: causal mechanism, outside view, assumption checks, competing hypotheses |
| `consultant-critic` (subagent) | `opencode/claude-sonnet-5-5` | Consultation-team challenger: counter-evidence, hypothesis matrices, plan robustness |
| `consultant-auditor` (subagent) | `opencode-go/grok-4.7` | Consultation-team source-intent audit: shilling, smear campaigns, undisclosed sponsorship |
| `solution-reviewer` (subagent) | `opencode/claude-sonnet-5-5` | R&D-team independent gate: one-way design pre-mortems for `architect`, Stage-1 plan review (`stage: "plan"`) of the tech-lead's `plan.md`, and Stage-2 final review (`stage: "final"`) of the integrated diff. Read-only leaf with design-directory read access |
| `coder-reviewer` (subagent) | `opencode-go/kimi-k3.1-pro` (`tier: "fast"` → `opencode-go/claude-haiku-5-5`) | R&D-team milestone reviewer: reviews each `tech-lead` milestone's patch against the plan, at the tier matching the milestone's `coder` |
| `author-writer` (subagent, two-tier) | `opencode/claude-sonnet-5-5` (`tier: "fast"` → `opencode-go/claude-haiku-5-5`) | Documentation-team's sole author of reader-facing prose; only `fast` and `standard` tiers exist. Writes directly under `writer_docs_roots` (default `userdoc`); for an approved path outside the roots (such as `README.md` or `docs/**`), or when the roots are `[]`, it returns prose or a patch in read-only mode and `author` applies it. Never writes source, config, build files, or `AGENTS.md` |
| `author-reviewer` (subagent, two-tier) | `opencode-go/kimi-k3.1-pro` (`tier: "fast"` → `opencode-go/deepseek-v4.1-flash`) | Documentation-team's independent reviewer, `fast` and `standard` tiers only. Runs up to four stages by document level — `outline`, `unit`, `reader`, `final` — checking facts and sources against the source ledger, alignment with the brief, and readability. Read-only (no edit, shell, or dispatch) with budgeted `webfetch`/`websearch` lookups per stage; `D0` micro-fixes are not reviewed |
| `janus-memory` (MCP: Model Context Protocol, a local tool-server interface) | — | Local SQLite memory shared across the family: auto-saved consultation records, recall, edit, delete, outcome feedback |
| `janus-models` (command) | — | Model-rotation entry: inventory the 15 agents, evaluate model/prompt fit, and apply approved model or routing changes to the user-level Janus config |
| `janus-config` (command) | — | Guided editor for the plugin config file: browse every setting by group, see its current value, default, and choices, then set, clear, reset, or validate it with a preview and confirmation |

That is 15 agents: 6 primary entries (`janus`, `simple`, `consultant`, `architect`, `tech-lead`, `author`) and 9 subagents. Thirteen are dispatchable; only `janus` and `architect` are not. Dispatched sub-sessions can never dispatch the three coordinating roles (`consultant`, `tech-lead`, `author`).

### Which agent should I use?

```text
General question / unsure          -> janus
Evidence, comparison, verify,
research, personal roadmap, guide  -> consultant
System/module/interface design     -> architect
Bug, feature, refactor, tests      -> tech-lead
Tutorial, course, durable document -> author
Quick fact / how-to                -> simple
```

Start at `janus` when unsure; start directly at the specialist when you already know the task type. Coding work flows through `tech-lead`, which plans the milestones and dispatches isolated `coder` sessions; the `coder` leaf is normally dispatched by `tech-lead`, not selected directly.

Every agent's model is configurable (`*_model` fields), and every prompt layers a role asset with an optional model-adaptation block keyed by the model (`model_prompts` map overrides the shipped `assets/model-prompts/` library, extendable by dropping a file) — swap a model, keep the role, and the driving notes follow the model. Blocks are matched **provider-agnostically**: the key drops the provider prefix, lowercases, and keeps only letters and digits, so `deepseek/deepseek-v4-pro` and `opencode-go/deepseek-v4-pro` both resolve to `deepseekv4pro` (see the "模型适配提示词" section of [docs/deployment.md](docs/deployment.md)).

## Prerequisites

- [OpenCode](https://opencode.ai) (the agent harness)
- [Bun](https://bun.sh) >= 1.1 (runs the local memory MCP server and the installer)
- The shipped model defaults assume an **OpenCode Go (Go Plus) subscription** for the `opencode-go/*` pool models, plus the `opencode` provider (Zen pay-per-use) for `consultant-critic`, `solution-reviewer`, and `author-writer` (`claude-sonnet-5-5`); the Senior `coder-reviewer` ships on the Go Plus pool (`opencode-go/kimi-k3.1-pro`). Without these, set every `*_model` to a provider configured on your machine — see the [non-Go example](docs/deployment.md) in the deployment guide. Dispatch failures print a remediation hint naming the exact config field.

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

Restart OpenCode. The plugin registers the 15 agents, the memory MCP, the `consultation`, `consultation-design`, and `consultation-doc` skills, the `/janus-memory`, `/janus-models`, and `/janus-config` commands, the four dispatch tools (`janus_dispatch`, `janus_dispatch_wait`, `janus_dispatch_cancel`, `janus_dispatch_continue`), and the `janus_config` and `janus_provider_keys` tools automatically; the install also prunes generated skills and command files this plugin has retired (user-modified and foreign files are kept). The install stages the `bin/janus-keys` terminal tool, the only place a provider key value is entered.

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
| `design` | deciding the future structure — 架构设计、模块设计、接口设计 | the decision record: layer, goal/constraints, quality scenarios, options and trade-offs, recommendation, risks/reversibility, open questions — written to `design.md` and handed to `tech-lead` for an implementation plan |

Answers are terminal-first: a full answer opens with `结论 / 理由 / 下一步`, ends with `一句话 / 下一步`, and puts evidence under `证据与来源（可跳过）`. Short answers skip the repetition. Facts are separated from inference and labeled with an epistemic status.

**Daily questions go to `simple`.** Select the `simple` agent for quick lookups and explanations at a fraction of the cost; it escalates to `consultant` (one line, with a reason) when a question needs multi-source adversarial verification or is high-stakes, to `architect` for design, and to `author` for documents. **Coding goes to `tech-lead`**, which plans the lightest process that fits: a direct `coder` dispatch for a one-line change, a brief plan for a small feature, and a design gate plus quality gate (Stage-1/Stage-2 reviews) for multi-file or correctness-critical work — every line of code lands in an isolated dual-tier `coder` session, reviewed by `coder-reviewer` (per milestone) and `solution-reviewer` (plan/final gates).

**Memory.** Consultations auto-save (question + conclusion summaries — never transcripts). Browse and manage them with the `/janus-memory` command or the `janus-memory` CLI. Prior experience and preferences surface in later consultations, with an outcome-feedback loop.

**Models.** Run `/janus-models` for an explicit, interactive model-rotation workflow. With no arguments it inventories every suite agent's effective model and prompt source, then offers a menu: model evaluation, `model_prompt` evaluation, a combined recommendation, or execution. Model and prompt changes are written only to the user-level Janus config; the command shows an exact diff and waits for confirmation before writing. `/janus-models 帮助` lists the argument forms.

**Settings.** Run `/janus-config` to change any plugin setting without touching JSON. With no arguments it shows the config file path and nine numbered groups (role switches and names, role models, advanced routing, model prompts, team caps, document writer, simple workspace, memory/embedding, install), plus group 10 for provider keys. Pick a group to see every field with its current value, default, and source. Pick a field to get numbered choices for its type; model fields list candidates from `opencode models`. Every write goes through the plugin's `janus_config` tool: it validates against the config schema, shows a preview diff, waits for your confirmation, keeps your comments, and leaves a `.bak` backup. Shortcuts such as `/janus-config 设 author_writer_enabled false`, `/janus-config 清除 team_caps.round_cap`, and `/janus-config 校验` skip the menus.

**Provider keys.** Group 10 of `/janus-config` (or `/janus-config key`) manages OpenCode's provider API keys. It lists the providers that have a key, which named key is active, how many candidates each one has, and whether a switch is waiting for a restart. It can also search the full provider catalog. Each provider can hold several named keys, for example `work` and `personal`. You can switch between them, rename them, or delete them. Switching writes the chosen key into OpenCode's `auth.json` (backed up first) and needs a full OpenCode restart; the command prints the exact steps to confirm the switch and to roll it back. On first use it offers to save your existing unnamed keys under the name `default`, and it will not switch away from an unnamed key, so no key is ever lost. Keys are added only in a terminal, so a key never enters the conversation: `~/.local/share/janus-agent-plugin/bin/janus-keys add <provider> <name> --use` prompts twice with hidden input. It also accepts `--stdin` (for example `pbpaste | …`) or `--env VAR`. Candidates live in `~/.local/share/janus-agent/provider-keys.json` (mode 600), and every output masks keys as `sk-…ab12`.

**Documents.** A durable document is produced by a three-seat loop. `author` owns intake, evidence, the outline approval, verification, and publishing. `author-writer` is the sole author of reader-facing prose. `author-reviewer` independently checks facts and sources, alignment with the agreed brief, and readability; it cannot edit files. The process scales with the document level: a `D0` micro-fix (typo, punctuation, broken link) gets a quick fix and diff check with no review, while `D1` local edits, `D2` standard documents, and `D3` large sets add an outline approval and progressively more review stages. If a review is disabled, fails, or returns no valid report, the delivery says so instead of claiming a review. Under `writer_docs_roots` (default `userdoc`), `author-writer` writes the approved files itself; for an approved path outside the roots (such as `README.md` or `docs/**`), or with `writer_docs_roots: []`, `author` writes the returned text to disk and the reviewer checks the written file. Substantive documentation reaches `author` from `janus`, `architect`, or `tech-lead`, or by you switching to it. Code comments, `AGENTS.md`, and ≤ 2-edit doc syncs tied to a code change stay with `tech-lead`.

**Design.** A structural decision goes to `architect` (architecture, module boundaries, interfaces), not to `select` or a doc-mode architecture write-up. The architect loads `consultation-design` and works layer by layer: each decision brings at least two real options, a recommendation, what would change it, and a one-way/two-way reversibility label; one-way doors are approved individually and get a `solution-reviewer` pre-mortem, two-way doors get a default and one batch approval per layer. The result is a self-contained `design.md` at `~/.local/share/janus-agent/design/<projectId>/<designId>/design.md` — the architect is its sole writer, the `tech-lead` treats it as 100% read-only, writes its `plan.md` beside it, gets a Stage-1 plan review, then schedules isolated dual-tier `coder` sessions milestone by milestone with per-milestone `coder-reviewer` patch reviews, and deletes the landed temporary `plan.md` without confirmation. Both roles have pre-approved access to that directory only; nothing is written into your project tree. See the "数据、状态与缓存路径" section of [docs/deployment.md](docs/deployment.md).

**Team state, outside your project tree.** Each team keeps its session state in its own directory under `~/.local/share/janus-agent/`, and nothing is written into your project tree. The R&D team holds `design.md` (the architect's decision record) and the tech-lead's `plan.md` beside it under `design/`; `plan.md` doubles as a checkpoint, so a long coding task resumes in a fresh `tech-lead` session and stops for you when it is blocked or needs a decision. The documentation team keeps one `brief.md` per document under `author/`; the consultation team keeps its per-project candidate ledgers under `ledger/`. Startup installs prune generated skills and commands this plugin has retired by fingerprint — user-modified and foreign files are always kept.

**Configuration.** Optional JSONC config at `~/.config/janus-agent/config.jsonc` (or `$JANUS_CONFIG` / XDG): per-agent names/models/enable flags, `mode_models` and `tier_models` routing overrides, model-prompt overrides/disable markers, `writer_docs_roots`, team caps (`tier_role_caps` sizes the five consultation-team roles; documentation seats are sized by document level), memory and embedding settings. Shipped fast-tier defaults sit below any explicit `<role>_model`, so changing one tier of a role needs a `tier_models` entry; `tier_models.deep` rejects `author-writer` and `author-reviewer`. The full field reference lives in [docs/deployment.md](docs/deployment.md).

**Verify your install:**

```bash
JANUS_PLUGIN_ENTRY=~/.local/share/janus-agent-plugin/dist/index.js bun run integration
```

The integration proof spawns a sandboxed OpenCode server and checks that the installed bundle registers the agents, the memory MCP, the skills, and the commands; it never touches your real config or data.

## Development

```bash
bun test                     # all unit tests
bun run typecheck            # tsc --noEmit
bun run build                # regenerate the skills, then bundle adapter + memory MCP into dist/
bun run gen:skill            # regenerate the three skills from skill-src/
bun run install:local        # build + install the bundle (replaces the installed one)
bun run integration          # isolated OpenCode integration proof
bun run evals/run-evals.ts   # print the evaluation checklist
```

TypeScript strict, zod, SQLite FTS5 (SQLite full-text search), five-package Bun workspace, no native dependencies. Harness-neutral core packages (`consultation-core`, `memory-core`); host-specific code stays in the adapters.

Contributor rules (generated skills, prompt goldens, change → verification map) live in [AGENTS.md](AGENTS.md).

**Deployment rule:** always deploy the packaged bundle — never point an OpenCode config at the repo source. The installed bundle is self-contained (no `node_modules` required at runtime).

## Documentation

- [docs/deployment.md](docs/deployment.md) — install, full configuration reference, model prerequisites, uninstall
- [docs/architecture.md](docs/architecture.md) — architecture specification
- [docs/design.md](docs/design.md) — reference design for the agents, their models and permissions
- [evals/README.md](evals/README.md) — evaluation fixtures and grading
