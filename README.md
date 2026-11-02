# janus-agent-plugin

Janus is a daily-driver agent family for [OpenCode](https://opencode.ai) — three teams share one plugin: a consultation team (`consultant`), an R&D team (`architect` + `coder`), and a documentation team (`author`), with `janus` as the default front desk, `simple` as the economical quick-answer leaf, and a shared local memory.

## What you get

| Agent | Default model | What it does |
|-------|---------------|--------------|
| `janus` (primary/all) | `opencode-go/glm-5.3-flash` | Default front desk. Handles general questions, light tasks, and routing to `simple`, `consultant`, `architect`, `coder`, or `author`. Does not do deep research, design, documentation, or heavy coding itself |
| `simple` (primary/all) | `opencode-go/deepseek-v4.1-flash` | Economical quick-answer leaf: facts, concepts, simple how-to. Never dispatches; escalates evidence to `consultant`, design to `architect`, coding to `coder`, documents to `author` |
| `consultant` (primary) | `opencode-go/gemini-4-argon` | Consultation-team entry for five evidence modes: `select`, `verify`, `roadmap`, `research`, `guide`. Leads `common-explorer`, `consultant-analyst`, `consultant-critic`, and `consultant-auditor`; hands design to `architect` and documents to `author` |
| `architect` (primary) | `opencode-go/gemini-4-argon` | R&D-team design entry. Runs brainstorming ⇄ convergence ⇄ system/module design, dispatches `common-explorer` and `coder-reviewer` (design pre-mortem), and is the sole author of `design.md`'s decisions (the coder flips only its lifecycle line) |
| `coder` (primary/all) | `opencode-go/glm-5.3` | R&D-team coding entry. Starts from a bug/feature/refactor or an accepted `design.md`; picks L0–L3 process weight, dispatches `coder-lite` and `coder-reviewer`, and escalates architecture work to `architect`. L3 can use a deep-tier model override |
| `author` (primary) | `opencode-go/gemini-4-argon` | Documentation-team entry. Owns doc profiles, the outline gate, the author brief, verification, and publishing; dispatches `author-writer` for prose and `coder` for executable verification |
| `common-explorer` (subagent) | `opencode-go/deepseek-v4.1-flash` | Shared research floor for all three teams: external documentation, open-source practice, and bounded codebase survey. Read-only leaf |
| `consultant-analyst` (subagent) | `opencode-go/kimi-k3.1-pro` | Consultation-team reasoning: causal mechanism, outside view, assumption checks, competing hypotheses |
| `consultant-critic` (subagent) | `opencode/claude-sonnet-5-5` | Consultation-team challenger: counter-evidence, hypothesis matrices, plan robustness |
| `consultant-auditor` (subagent) | `opencode-go/grok-4.7` | Consultation-team source-intent audit: shilling, smear campaigns, undisclosed sponsorship |
| `coder-reviewer` (subagent) | `opencode/claude-sonnet-5-5` | R&D-team reviewer: one-way design pre-mortems for `architect`, and `plan.md`/diff review for `coder` |
| `author-writer` (subagent) | `opencode/claude-sonnet-5-5` | Documentation-team's scoped-write executor and sole author of reader-facing prose; writes only under `writer_docs_roots` (default `userdoc`) |
| `coder-lite` (subagent) | `opencode-go/glm-5.3-flash` | Mechanical coding lane: fully specified bulk edits, formatting/lint fixes, boilerplate. Workspace edits allowed, everything else asks; stops and reports up on ambiguity |
| `janus-memory` (MCP) | — | Local SQLite memory shared across the family: auto-saved consultation records, recall, edit, delete, outcome feedback |
| `janus-models` (command) | — | Model-rotation entry: inventory the 13 agents, evaluate model/prompt fit, and apply approved model or routing changes to the user-level Janus config |
| `janus-handoff` (command) | — | Cross-team handoff operator: list, view, mount (`use`), archive, delete, export, and import `handoff.md` documents for topics moving between the primary entries |

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

Restart OpenCode. The plugin registers the agents, the memory MCP, the `consultation`, `consultation-design`, and `consultation-doc` skills, the `/janus-memory`, `/janus-models`, and `/janus-handoff` commands, and the dispatch tools automatically.

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

**Documents.** Doc-mode documents are produced by an author + author-writer pair: `author` owns intake, evidence, the outline approval, the brief, verification, and publishing; `author-writer` is the sole author of reader-facing prose and (unless `writer_docs_roots` is empty) the sole writer of approved document files under the configured roots (default `userdoc`). With `writer_docs_roots: []` the author-writer returns prose and the author publishes it. A document's writer session is reused across its feedback turns: the first author-writer dispatch captures a session handle (`return_handle: true`), the brief stores it as `writer_session_id`, and later bounded edits continue that session via `janus_dispatch_continue`.

**Design.** A structural decision goes to `architect` (architecture, module boundaries, interfaces), not to `select` or a doc-mode architecture write-up. The architect loads `consultation-design` and works layer by layer: each decision brings at least two real options, a recommendation, what would change it, and a one-way/two-way reversibility label; one-way doors are approved individually and get a `coder-reviewer` pre-mortem, two-way doors get a default and one batch approval per layer. The result is a self-contained `design.md` at `~/.local/share/janus-agent/design/<projectId>/<designId>/design.md` — the architect writes its decisions, the `coder` reads it, writes its `plan.md` beside it, then implements with a reduced L2 gate and a plan↔design check, and flips the record's lifecycle line once the work is verified and accepted. Both roles have pre-approved access to that directory only; nothing is written into your project tree. See the "数据、状态与缓存路径" section of [docs/deployment.md](docs/deployment.md).

**Cross-team handoff.** When a topic moves between primary entries (`consultant -> architect -> coder -> author`, including a coder escalation to `architect`), the current entry lazily creates a `handoff.md` at `~/.local/share/janus-agent/handoff/<projectId>/<handoffId>/handoff.md` and appends every subsequent hop to the same document — across sessions, with no automatic completion. The file carries only a ≤ 80-line current truth snapshot (labeled facts with in-place `supersedes`, open questions, link-only artifact pointers to `design.md`/`plan.md`/`brief.md`) plus a newest-first hop ledger, so a receiver reads the first 120 lines and holds the full state; team-internal discussion never enters it. Run `/janus-handoff` to list, view, mount (`use`), archive, delete, export, or import handoffs; the five primary entries share write access to the directory, leaf subagents never write it.

**Configuration.** Optional JSONC config at `~/.config/janus-agent/config.jsonc` (or `$JANUS_CONFIG` / XDG): per-agent names/models/enable flags, `mode_models` and `tier_models` routing overrides, model-prompt overrides/disable markers, `writer_docs_roots`, team caps, memory and embedding settings. The full field reference lives in [docs/deployment.md](docs/deployment.md).

**Verify your install:**

```bash
JANUS_PLUGIN_ENTRY=~/.local/share/janus-agent-plugin/dist/index.js bun run integration
```

The isolated integration proof spawns a sandboxed OpenCode server and asserts the agents, MCP, skills, commands, and dispatch tools register correctly — it never touches your real config or data.

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

TypeScript strict, zod, SQLite FTS5, five-package Bun workspace, no native dependencies. Harness-neutral core packages (`consultation-core`, `memory-core`); host-specific code stays in the adapters.

The three skills are generated: edit `skill-src/consultation/**`, `skill-src/consultation-design/**`, and `skill-src/consultation-doc/**`, run `bun run gen:skill`, and never hand-edit `assets/skills/*/SKILL.md` (`gen-skill.test.ts` fails on drift). Shared prompt fragments live in `assets/principles/`; every assembled role prompt has a reviewed golden under `packages/opencode-adapter/src/prompt-snapshots/`, refreshed with `UPDATE_PROMPTS=1 bun test packages/opencode-adapter/src/prompt-snapshots.test.ts` after reviewing the diff.

**Deployment rule:** always deploy the packaged bundle — never point an OpenCode config at the repo source. The installed bundle is self-contained (no `node_modules` required at runtime).

## Documentation

- [docs/deployment.md](docs/deployment.md) — install, full configuration reference, model prerequisites, uninstall
- [docs/architecture.md](docs/architecture.md) — architecture specification
- [docs/design.md](docs/design.md) — reference design for the agents, their models and permissions
- [evals/README.md](evals/README.md) — evaluation fixtures and grading
