# janus-agent-plugin

Janus is a daily-driver agent family for [OpenCode](https://opencode.ai) — `janus` is the default entry, `consultant` owns evidence-graded advice, `coder` owns coding with an adaptive process weight, `lite` is the economical quick-answer leaf, and a shared local memory learns from every consultation.

## What you get

| Agent | Default model | What it does |
|-------|---------------|--------------|
| `janus` (primary/all) | `opencode-go/glm-5.3` | Default daily entry. Handles general questions, light tasks, and routing: consulting → `consultant`, coding → `coder`, quick answers → `lite`. Does not do deep research or heavy coding itself |
| `consultant` (primary) | `opencode-go/glm-5.3` | Evidence-driven consultations in seven modes: `select`, `verify`, `plan`, `guide`, `research`, `author`, `design`. Leads the four read-only research specialists and the scoped-write writer, and owns design records |
| `coder` (primary/all) | `opencode-go/glm-5.3` | Coding entry and execution specialist. Selects L0/L1/L2/L3 process weight by task complexity, gates design on user approval for L2/L3, and runs the correctness-critical quality gate |
| `lite` (primary/all) | `opencode-go/deepseek-v4.1-flash` | Economical quick-answer leaf: facts, concepts, simple how-to. Never dispatches; escalates complex/contested questions to `consultant`, coding to `coder` |
| `consultation-explorer` | `opencode-go/deepseek-v4.1-flash` | Read-only search specialist returning graded, structured evidence reports |
| `consultation-analyst` | `opencode-go/qwen3.8-max` | Read-only cross-model reasoning over gathered evidence |
| `consultation-critic` | `opencode/gemini-3.8-flash` | Read-only adversarial reviewer hunting counter-evidence |
| `consultation-verifier` | `opencode/gemini-3.8-flash` | Read-only source-influence auditor (shilling, smear campaigns, undisclosed sponsorship) |
| `consultation-writer` | `opencode/claude-sonnet-5-5` | Scoped-write author executor and the sole author of reader-facing prose for `author`-mode documents: blueprints, section/chapter drafts, maintenance, coherence passes. Writes only approved files under the configured `writer_docs_roots` (default `userdoc`; `[]` = read-only fallback where the consultant publishes its returned prose); targeted web lookups with a source ledger, no shell, no dispatch |
| `coder-lite` (subagent) | `opencode-go/glm-5.3-flash` | Mechanical coding lane: fully specified bulk edits, formatting/lint fixes, boilerplate from templates. Workspace edits allowed, everything else asks; stops and reports up on anything ambiguous |
| `build` (dispatch role) | host's build agent | Optional stronger-model escalation for judgment-heavy coding; normally dispatched by `coder`. If unavailable, the coder codes itself or reports the gap |
| `janus-memory` (MCP) | — | Local SQLite memory shared across the agents: auto-saved consultation records, recall, edit, delete, outcome feedback |
| `janus-models` (command) | — | Explicit model-rotation entry: inventory the suite's agents and effective models, evaluate model and prompt fit with live evidence, and apply approved changes to the user-level Janus config |

### Which agent should I use?

```text
General question / unsure          -> janus
Consulting, selection, verify,
research, personal plan,
durable document, system design    -> consultant
Coding, implementation plan        -> coder
Quick fact / how-to,
read-only document Q&A             -> lite
```

Start at `janus` when unsure; start directly at the specialist when you already know the task type. `coder-lite` and `build` are normally dispatched by `coder`, not selected directly.

Every agent's model is configurable (`*_model` fields), and every prompt layers a role asset with an optional model-adaptation block keyed by the model (`model_prompts` map overrides the shipped `assets/model-prompts/` library, extendable by dropping a file) — swap a model, keep the role, and the driving notes follow the model. The block describes the model, never the role: a model profile plus agent-actionable operating notes for using its strengths and controlling its weaknesses; runtime settings stay in config, and the same block serves every agent running that model. Blocks are matched **provider-agnostically**: a model id is normalized by dropping the provider prefix (everything before the last `/`), lowercasing, and keeping only letters and digits, so `deepseek/deepseek-v4-pro` and `opencode-go/deepseek-v4-pro` both resolve to the same key `deepseekv4pro` (see [Model-adaptation prompts](docs/deployment.md#model-adaptation-prompts)).

## Prerequisites

- [OpenCode](https://opencode.ai) (the agent harness)
- [Bun](https://bun.sh) >= 1.1 (runs the local memory MCP server and the installer)
- The shipped model defaults assume an **OpenCode Go subscription** for the `opencode-go/*` pool models, plus the `opencode` provider for the writer (`claude-sonnet-5-5`) and critic/verifier (`gemini-3.8-flash`, Zen pay-per-use). Without these, set every `*_model` to a provider configured on your machine — see the [non-Go example](docs/deployment.md) in the deployment guide. Dispatch failures print a remediation hint naming the exact config field.

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

Restart OpenCode. The plugin registers the agents, the memory MCP, the `consultation` skill, the `/janus-memory` and `/janus-models` commands, and the dispatch tools automatically.

## Usage

**Ask the consultant.** It detects the mode and delivers the matching answer. For non-trivial answers it may add a one-line mode note after the conclusion (e.g. “模式：select（购买决策）”), never before it:

| Mode | Triggers on | You get |
|------|--------------|---------|
| `select` | choosing among candidates — 买哪个、选课、选工具 | the pick (or "no clear winner" with a tie-break), 2–3 reasons, and a trial/switch action; evidence is folded away |
| `verify` | checking a claim or rumor — 这说法是不是真的 | true / false / unverifiable first, then the key reasons, what would change the verdict, and the next evidence step |
| `plan` | an actionable plan — 健身、保养、学习路线 | feasibility first (可行 / 有条件可行 / 不建议), then constraints, steps, stop/rollback, and an alternative |
| `guide` | a composite end-to-end package — 攻略、X入门 | the shortest path, steps, pitfalls, completion check, and a recommendation/alternative only when there are real choices |
| `research` | understanding a topic deeply — 深度研究、调查一下 | a bottom line, 3–5 plain-language points, what it means for you, and what is still uncertain; no forced recommendation |
| `author` | a durable document to keep or share — 教程、架构分析文档、write-up | a document delivery brief (status, location, scope, verification, next action); the document itself is the artifact |
| `design` | deciding the future structure — 架构设计、模块设计、接口设计 | the decision record: layer, goal/constraints, quality scenarios, options and trade-offs, recommendation, risks/reversibility, open questions — written to `design.md` and handed to `coder` for an implementation plan |

Answers are terminal-first: a full answer opens with `结论 / 理由 / 下一步`, ends with `一句话 / 下一步`, and puts evidence under `证据与来源（可跳过）`. Short answers skip the repetition. Facts are separated from inference and labeled with an epistemic status.

**Daily questions go to `lite`.** Select the `lite` agent for quick lookups and explanations at a fraction of the cost; it escalates to `consultant` (one line, with a reason) when a question needs multi-source adversarial verification or is high-stakes. **Coding goes to `coder`**, which picks the lightest process that fits: a direct fix for a one-line change, a brief plan for a small feature, and a design gate plus quality gate for multi-file or correctness-critical work.

**Memory.** Consultations auto-save (question + conclusion summaries — never transcripts). Browse and manage them with the `/janus-memory` command or the `janus-memory` CLI. Prior experience and preferences surface in later consultations, with an outcome-feedback loop.

**Models.** Run `/janus-models` for an explicit, interactive model-rotation workflow. With no arguments it inventories every suite agent's effective model and prompt source, then offers a menu: model evaluation, `model_prompt` evaluation, a combined recommendation, or execution. Model and prompt changes are written only to the user-level Janus config; the command shows an exact diff and waits for confirmation before writing. `/janus-models 帮助` lists the argument forms.

**Documents.** Author-mode documents are produced by a consultant + writer pair: the consultant owns intake, evidence, the outline approval, the author brief, verification, and publishing; the writer is the sole author of reader-facing prose and (unless `writer_docs_roots` is empty) the sole writer of approved document files under the configured roots (default `userdoc`). With `writer_docs_roots: []` the writer returns prose and the consultant publishes it. A document's writer session is reused across its feedback turns: the first writer dispatch captures a session handle (`return_handle: true`), the brief stores it as `writer_session_id`, and later bounded edits continue that session via `janus_dispatch_continue` — a generic dispatch mechanism (same caller, same workspace, idle target) that works for any role's session, not only the writer's.

**Design.** A structural decision goes to the consultant's `design` mode (architecture, module boundaries, interfaces), not to `select` or an author-mode architecture write-up. It works layer by layer: each decision brings at least two real options, a recommendation, what would change it, and a one-way/two-way reversibility label; one-way doors are approved individually and get a critic pre-mortem, two-way doors get a default and one batch approval per layer. The result is a self-contained `design.md` at `~/.local/share/janus-agent/design/<projectId>/<designId>/design.md` — the consultant writes it, the `coder` only reads it and writes its `plan.md` beside it, then implements with a reduced L2 gate and a plan↔design check. Both agents have pre-approved access to that directory only; nothing is written into your project tree. See [docs/deployment.md](docs/deployment.md#data-state-and-cache-paths).

**Configuration.** Optional JSONC config at `~/.config/janus-agent/config.jsonc` (or `$JANUS_CONFIG` / XDG): per-agent models and model-prompt blocks, agent names, enable flags, `writer_docs_roots`, team caps, memory and embedding settings. The full field reference lives in [docs/deployment.md](docs/deployment.md).

**Verify your install:**

```bash
JANUS_PLUGIN_ENTRY=~/.local/share/janus-agent-plugin/dist/index.js bun run integration
```

The isolated integration proof spawns a sandboxed OpenCode server and asserts the agents, MCP, skills, commands, and dispatch tools register correctly — it never touches your real config or data.

## Development

```bash
bun test                     # all unit tests
bun run typecheck            # tsc --noEmit
bun run build                # regenerate the skill, then bundle adapter + memory MCP into dist/
bun run gen:skill            # regenerate assets/skills/consultation/SKILL.md from skill-src/consultation
bun run install:local        # build + install the bundle (replaces the installed one)
bun run integration          # isolated OpenCode integration proof
bun run evals/run-evals.ts   # print the evaluation checklist
```

TypeScript strict, zod, SQLite FTS5, five-package Bun workspace, no native dependencies. Harness-neutral core packages (`consultation-core`, `memory-core`); host-specific code stays in the adapters.

The consultation skill is generated: edit `skill-src/consultation/**`, run `bun run gen:skill`, and never hand-edit `assets/skills/consultation/SKILL.md` (`gen-skill.test.ts` fails on drift). Shared prompt fragments live in `assets/principles/`; every assembled role prompt has a reviewed golden under `packages/opencode-adapter/src/prompt-snapshots/`, refreshed with `UPDATE_PROMPTS=1 bun test packages/opencode-adapter/src/prompt-snapshots.test.ts` after reviewing the diff.

**Deployment rule:** always deploy the packaged bundle — never point an OpenCode config at the repo source. The installed bundle is self-contained (no `node_modules` required at runtime).

## Documentation

- [docs/deployment.md](docs/deployment.md) — install, full configuration reference, model prerequisites, uninstall
- [docs/architecture.md](docs/architecture.md) — architecture specification
- [docs/design.md](docs/design.md) — reference design for the agents, their models and permissions
- [evals/README.md](evals/README.md) — evaluation fixtures and grading
