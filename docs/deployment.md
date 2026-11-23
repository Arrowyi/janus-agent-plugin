# 本地部署指南

本指南覆盖把 janus-agent 插件安装到本地 OpenCode 环境的完整流程。

## 部署规则

**只部署打包产物。绝不让 OpenCode 配置指向本仓库源码。**

本项目要分发给其他用户，因此部署必须仅凭构建产物即可复现：不得依赖仓库检出、其 `node_modules` 或 Bun 的模块缓存。具体要求：

- 用 `bun run install:local` 构建并安装：它构建 `dist/`、把 `dist/` + `assets/` 装入安装前缀，并校验结果。
- OpenCode 的 `plugin` 条目指向**已安装的** `dist/index.js`，绝不指向 `packages/opencode-adapter/src/index.ts`。
- 安装产物必须自包含：`script/build.ts` 不标记任何外部依赖，记忆 MCP（Model Context Protocol，本地工具服务协议）服务器解析为同目录打包的 `memory-mcp-server.js`，因此不随安装携带任何 `node_modules`。
- 源码模式条目只用于本仓库自己的测试运行（`bun test`、`bun run integration`），绝不用于可用环境或发布。

任何重新引入外部运行时导入、或配置指向源码的改动都违反本规则。`bun test` 守护解析逻辑，`bun run integration` 证明已安装产物能正确注册。

## 前置条件

- **Bun >= 1.1** —— 运行时与包管理器。从 <https://bun.sh> 安装。
- **OpenCode** —— agent 宿主。从 <https://opencode.ai> 或你的包管理器安装，用 `opencode --version` 验证。
- **模型提供商** —— 出厂默认假设你持有 **OpenCode Go（Go Plus）订阅**（覆盖 `opencode-go/*` 池内模型），外加 `opencode` 提供商（Zen 按量付费）供三个判断席位使用 `opencode/claude-sonnet-5-5`（`consultant-critic`、`solution-reviewer`、`author-writer`）；Senior 补丁审查席 `coder-reviewer` 走 Go Plus 池的 `opencode-go/kimi-k3.1-pro`。没有这些提供商时 agent 会注册成功，但在使用时于模型解析处失败。非 Go 用户：把下面的配置复制到 `~/.config/janus-agent/config.jsonc`，把每个 `*_model` 设为你机器上已配置的提供商。派发失败时会打印带精确字段名的修复提示。

  ```jsonc
  {
    "janus_model": "<你的提供商>/fast-tool-caller",
    "consultant_model": "<你的提供商>/strong-agentic-model",
    "architect_model": "<你的提供商>/strong-agentic-model",
    "author_model": "<你的提供商>/strong-agentic-model",
    "common_explorer_model": "<你的提供商>/fast-cheap-model",
    "consultant_analyst_model": "<你的提供商>/reasoning-model",
    "consultant_critic_model": "<你的提供商>/different-family-model",
    "solution_reviewer_model": "<你的提供商>/different-family-model",
    "coder_reviewer_model": "<你的提供商>/different-family-model",
    "consultant_auditor_model": "<你的提供商>/different-family-model",
    "author_writer_model": "<你的提供商>/writing-model",
    "author_reviewer_model": "<你的提供商>/different-family-model",
    "tech_lead_model": "<你的提供商>/strong-coding-model",
    "coder_model": "<你的提供商>/strong-coding-model",
    "simple_model": "<你的提供商>/fast-cheap-model"
  }
  ```

Bun 与 OpenCode 必须在 `PATH` 上。

## 第 1 步：安装依赖

克隆本仓库并安装依赖。Bun 是唯一的包管理器；不要使用 npm、yarn 或 pnpm。

```bash
git clone <repo-url> janus-agent-plugin
cd janus-agent-plugin
bun install
```

## 第 2 步：构建、安装与注册

构建 bundle 并安装到稳定前缀：

```bash
bun run install:local
```

安装器把 `dist/` + `assets/` 装入安装根目录（默认 `~/.local/share/janus-agent-plugin`；可用 `JANUS_INSTALL_DIR` 覆盖），写入 `package.json` + `build-meta.json` 作为溯源信息，并在任何必需文件缺失时报错退出。它会打印需要加入 `~/.config/opencode/opencode.json`（不存在则创建）的精确插件条目：

```jsonc
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["file:///Users/you/.local/share/janus-agent-plugin/dist/index.js"]
}
```

安装布局：

```text
<安装根目录>/
  dist/index.js               打包的适配器插件（自包含）
  dist/memory-mcp-server.js   打包的记忆 MCP 服务器（自包含）
  assets/agents/*.md          agent 提示词（启动时读取）
  assets/model-prompts/*.md   模型适配块（按模型 slug 命名）
  assets/principles/*.md      公共原则 + 共享提示词片段
  assets/protocols/*.md       五张方法论卡片（janus_dispatch 载入）
  assets/skills/consultation/SKILL.md          生成的核心 skill
  assets/skills/consultation-design/SKILL.md   生成的设计子 skill
  assets/skills/consultation-doc/SKILL.md      生成的文档子 skill
  assets/commands/janus-models.md
  assets/commands/janus-config.md
  dist/janus-keys.js
  bin/janus-keys
  package.json                溯源
  build-meta.json             版本 / git sha / 构建时间
```

重跑 `bun run install:local` 会重新构建并替换已安装产物，之后重启 OpenCode 加载。安装内的三个 skill 文件由 `skill-src/**` 生成；只编辑源、绝不手改生成物。三条斜杠命令中，`/janus-models` 与 `/janus-config` 来自随装的 `assets/commands/` asset，`/janus-memory` 的命令文件由安装器生成——不作为 asset 文件随装，在启动同步时写入 OpenCode 配置目录。

已安装插件自带其所需的全部提示词（含 `assets/agents/author-writer.md`），运行时不需要 OMO、外部 janus agent、`~/.config/opencode/agents/` 下的全局 agent 文件、外部 skill 或源码检出。author-writer 缺失会使文档模式不可用：此时会披露该情况，并提供启用 author-writer、配置 `writer_delegate_agent`、或用户明确接受的正文中写回退三个选项——绝不静默亲自书写读者可见正文。

### 开发专用：源码模式

在本仓库内迭代（单元测试、集成证明或一次性会话）时，插件条目可以指向 `packages/opencode-adapter/src/index.ts`。Bun 直接运行 TypeScript，无需构建；但该模式要求仓库检出及其 `node_modules` 存在，绝不用于已安装部署或发布。

## 第 3 步：重启 OpenCode

重启 OpenCode 使其加载新的插件条目。启动时插件的 `config` 钩子注册 15 个 agent——6 个主入口 `janus`、`simple`、`consultant`、`architect`、`tech-lead`、`author`，以及 9 个子 agent `common-explorer`、`consultant-analyst`、`consultant-critic`、`consultant-auditor`、`solution-reviewer`、`coder`、`coder-reviewer`、`author-writer`、`author-reviewer`——并完成以下工作：

1. 注册 `janus` 默认前台（模式 `all`）与 `consultant`、`architect`、`author` 主入口（模式 `primary`）以及 `tech-lead` 薄控制器（模式 `all`：可选可派发；名字可用 `janus_agent`、`consultant_agent`、`architect_agent`、`tech_lead_agent`、`author_agent` 配置）；`janus` 与 `architect` 各获得设计状态目录的 `external_directory` 权限——`janus` 用于无人值守时读取 `plan.md` 执行 `tech-lead` 的计划检查点中继，`architect` 拥有 `design` 模式的决策记录；`consultant` 获得项目候选账本目录（`<ledgerStateDir>/<projectId>/**`）的 `external_directory` 权限；
2. 注册 `tech-lead` 研发主控与 `coder` 双档执行叶：`tech-lead` 只能编辑设计状态目录（写 `plan.md`、更新账本），bash 全放；`coder` 为模式 `subagent`、步数上限 80 的执行叶，工作区内编辑免确认、工作区外编辑先询问，bash 全允许但拒绝 VCS 写/还原与破坏性删除，禁继续派发。`coder` 注册时整项替换同名条目，因此你在 OpenCode 配置里写的 `agent.coder` 配置块不会生效。权限规则的精确形态见 [architecture.md §4](architecture.md#4-全局不变式与粗粒度-codemap)；
3. 注册 `simple` 的工作区目录（`$XDG_DATA_HOME/janus-agent/lite`，可用 `simple_workspace_dir` 配置）为免确认可写；其余写入一律先询问。同时创建设计状态目录 `$XDG_DATA_HOME/janus-agent/design`（由 `architect`、`author`、`tech-lead` 访问：architect 写 `design.md` 的决策内容，tech-lead 对它 100% 只读、在同目录写 `plan.md`）与候选账本目录 `$XDG_DATA_HOME/janus-agent/ledger`（consultant 在其中按 `ledger/<projectId>/<consultation_id>.md` 写开放候选池账本）；
4. 注册检索/审查子 agent `common-explorer`、`consultant-analyst`、`consultant-critic`、`solution-reviewer`、`coder-reviewer`、`consultant-auditor`（各自只读、各用其配置模型、各自禁 shell 与派发；`solution-reviewer` 与 `coder-reviewer` 另获 design 状态目录的 `external_directory` 读权限，供无人值守会话打开 `design.md`/`plan.md`），限定写入的执笔者 `author-writer`（仅允许编辑 `writer_docs_roots` 之下，默认 `userdoc/**`；禁 shell 与派发；允许带来源台账的定向网络检索；步数上限 80；`writer_docs_roots` 为空时转为只读，由 author 发布其返回的正文），以及文档团队独立审稿人 `author-reviewer`（standard 档默认 `opencode-go/kimi-k3.1-pro`、fast 档默认 `opencode-go/deepseek-v4.1-flash`，与主笔跨模型家族；只读：`edit`/`bash`/`task` 全拒，允许按审阅阶段预算的 `webfetch`/`websearch`，另授予 author 与 design 状态目录的 `external_directory` 读权限；按文档级别 `D0`–`D3` 跑 `outline`/`unit`/`reader`/`final` 四个审阅阶段，`D0` 微改不审；不在 `tier_role_caps` 中）。`author-writer` 与 `author-reviewer` 是两档席位：只有 `fast` 与 `standard`，`tier_models.deep` 写这两个角色会让配置加载失败，`tier: "deep"` 派发被拒。同时创建 author 状态目录 `$XDG_DATA_HOME/janus-agent/author`，`author` 在其中写每篇文档的简报；
5. 注册 `janus-memory` 本地 MCP 服务器（记忆启用时，默认开启）；
6. 注册 `janus_dispatch{role,prompt,return_handle?,mode?,tier?,protocol?,reviews_job_ids?,stage?}`、`janus_dispatch_wait{job_id,wait_ms?}`、`janus_dispatch_cancel{job_id}` 与 `janus_dispatch_continue{session_id,prompt,role?,reviews_job_ids?}`（不干扰内置 `task` 工具或其他插件）。`role` 取十三个派发角色之一——九个子 agent 加 `consultant`、`tech-lead`、`simple`、`author`；`janus` 与 `architect` 是用户选择的主入口，不可派发。`consultant`、`tech-lead`、`author` 三个主协调角色受调用方 DAG 守卫（有向无环图，即防循环调用规则）保护：调用方会话本身是被派发的子会话时，派发它们会被拒绝（`Error: dispatched session cannot dispatch <role>; …`），其他角色不受此限。`mode`/`tier` 选择模型；`protocol` 在首轮前置入五张方法论卡片之一；`reviews_job_ids` 与 `stage` 由审查席守卫强制（见下节「审查席守卫」）。另注册 `janus_config` 与 `janus_provider_keys` 两个工具，所有叶节点一律拒绝；
7. 把 `consultation`、`consultation-design`、`consultation-doc` 三个 skill 与 `/janus-memory`、`/janus-models`、`/janus-config` 三条斜杠命令安装进你的 OpenCode 配置目录；启动安装同时按指纹修剪本插件此前生成、现已退役的 skill 与命令文件（用户改动与外来文件一律保留，见「退役生成物的指纹修剪」）。

### 可恢复的团队任务

所有角色共享同一套可恢复派发生命周期；每个 agent 解析到单一已配置模型，插件不做回退链。发起派发在 1800000 毫秒软等待窗口内观察。超时返回可恢复的 job 信封而非专家失败，也绝不中止子任务。等待使用同一个 `job_id`，包括协调者重启之后；`wait_ms` 是可选整数 0..1800000（默认 1800000；零为快照）。pending/unknown 的 job 不得触发重复发起、备用模型或静默内联替代。最终必须整合原任务的原始报告，并披露任何未解决的独立检查。

`janus_dispatch` 的 `return_handle: true` 只改变成功结果的形态：不再返回纯文本，而是返回已完成的 JSON 信封（`job_id`、`role`、`attempt`、`session_id`、`waited_ms`、`text`），其 `session_id` 可复用；pending 与失败结果不变，默认成功结果仍是纯文本。

`janus_dispatch_continue` 用新提示复用既有派发会话——对每个派发方与角色通用的机制（例如 author 复用 author-writer 会话、architect 与 tech-lead 复用 reviewer 或 coder 会话）。复用边界：同一调用方、同一工作区、目标是带派发标记的普通 job 根或其尝试子节点（绝不是续接 `job_id`——用原始 `session_id`）、且目标空闲（busy/retry 目标以「先等待」错误拒绝）；只有终态 job 可续接，pending 的 job 先等待。续接 job 的等待/取消沿用 `janus_dispatch_wait`/`janus_dispatch_cancel` 契约。续接没有新增配置——没有配置字段、没有注册表、也没有跨会话复用；文档模式下会话 ID 以 `writer_session_id` 存在该文档的简报中。

取消是显式操作，在持久中止证据确认 `cancelled` 之前可能返回 `cancelling`；正常完成与取消竞速时完成方胜出并返回报告。非终态信封把 `janus_dispatch_wait` 标为其下一步动作。等待/取消以调用方的父会话与工作区判定归属，不接受路由覆盖。详见[架构文档](architecture.md)的「4.2 派发 API 与派发边界不变式」一节。

### 审查席守卫：`reviews_job_ids` 与 `stage`

`janus_dispatch` 在创建任何 job 之前强制审查席守卫（`dispatch-guard.ts`），规则按目标角色与协议分层：

- 派 `coder-reviewer` 必携 `reviews_job_ids`——每个被审 coder 任务的根 `job_id`（即该 coder 工作的 `janus_dispatch` job id）。缺省被拒：`Error: coder-reviewer requires reviews_job_ids: …`。
- 派 `solution-reviewer` + 协议 `code_plan_review` 必携 `stage`；`stage` 在其他组合下直接拒绝（`stage is only valid for solution-reviewer with protocol code_plan_review; …`）。
  - `stage: "plan"`（Stage-1，评审已批准的 `plan.md`）：仅校验审查席模型与 `tech-lead` 模型的独立性，**禁带** `reviews_job_ids`（带了被拒）。
  - `stage: "final"`（Stage-2，评审集成终 diff）：**必带** `reviews_job_ids`，并与 `tech-lead` 模型及全部列出的 coder job 逐一校验。
- `solution-reviewer` + 协议 `design_premortem`（设计事前验尸）：校验审查席与 `architect` 模型的独立性。
- 派 `author-reviewer` 必携 `stage`（`outline` 大纲预审 / `unit` 单元或批次 / `reader` 冷读 / `final` 全文终审）与 `reviews_job_ids`（所审 `author-writer` 单元的根 `job_id`），且不接受 `protocol`。列出的 job 必须是 author-writer 根 job；审稿模型须已钉住，并与每个所列写手 job 的模型跨模型家族。
- 档位下限：job spec 按角色范围（`coder`/`coder-reviewer`/`solution-reviewer`/`author-writer`/`author-reviewer`）持久化派发时的 `tier` 与 `stage`；显式 `tier: "fast"` 派 `coder-reviewer` 而所列 coder job 中有 standard/deep 档时被拒，显式 `tier: "fast"` 派 `author-reviewer` 而所列写手 job 中有 standard 档时同样被拒（下限取所列 job 的最高档位）；`reader` 冷读阶段豁免该下限。不带 `tier` 参数的默认席派发不受此限；无 `tier` 参数派发的 job 落盘没有 tier 字段，下限规则对其不生效（由 `tech-lead` 与 `author` 规程约束派发必带档位）。
- 审稿报告软校验：`author-reviewer` 的返回文本中找不到符合 `AuthorReviewerReportSchema` 的 JSON 报告时，纯文本返回追加 `author-reviewer report: unresolved` 提示行，完成信封带 `report_check: "unresolved"`；`author` 不把这样的返回计为一次审阅。
- `solution-reviewer` 不带协议：守卫不触发；席位用法由注册与提示词约束。
- 家族校验：审查席与被审方同模型或同模型家族即拒绝。模型 ID 规范化后按前缀映射家族——`glm`、`gemini`、`kimi`、`claude`、`gpt`/`o1`/`o3`/`o4`、`deepseek`、`grok`、`qwen`、`minimax`、`mimo`、`hy`、`step` 分别映射到 glm/gemini/kimi/anthropic/openai/deepseek/xai/qwen/minimax/mimo/hunyuan/stepfun；未匹配前缀的模型自成一个家族，两个未知模型绝不折叠进共享家族。冲突错误消息会点名两侧模型并给出可改的配置键（`solution_reviewer_model`/`coder_reviewer_model`/`tech_lead_model`/`coder_model`/`author_reviewer_model`/`author_writer_model` 或 `tier_models`）。

`stage` 是调用方声明的并在 job spec 中持久留痕的值；谎报 stage 或谎报 ids 的完整性属于同一信任边界，由 Stage-2 报告契约与 `plan.md` 账本审计兜底。`janus_dispatch_continue` 对 coder-reviewer 会话、携带 `code_plan_review` 的 solution-reviewer 会话与 author-reviewer 会话（沿用目标会话持久化的 `stage`）重新执行同一守卫（续接不切模型，校验目标是目标会话持久钉住的模型），Stage-1 的复评按规约走全新派发、续接不开 plan 阶段后门。

### 上下文水位与 coder 硬顶

派发前插件读取调用方会话的最新 token 用量（读取失败静默放行，绝不阻塞派发）：

- **软水位 250k**：调用方上下文 ≥ 250000 token 时，工具返回值追加一行 `[context-watermark: <t> tokens >= 250000; checkpoint at milestone boundary]`——成功报告、`Error:` 文本与非终态/完成 JSON 信封都会带上；JSON 信封以可选 `context_watermark` 字段承载，纯文本走追加行。该标记反映调用方自身的上下文水位，只是提醒调用方考虑检查点，不是失败，也绝不作为续派触发；`janus`/`architect` 对 `tech-lead` 的中继按返回末尾的 `计划检查点: <plan.md_path>` 行触发，并以 `plan.md` 账本作门：`plan.md` 记录 `checkpoint: continue`、账本仍有未勾里程碑（或 Stage-2 评审）、进度对 `([x] 已完成数, stage2_round)` 按字典序严格越过传给该会话的对——外加一次性特例，即首轮派发在 `M_1` 前撞上 350k 硬顶时允许至多一次 `(0, 0)` 状态的中继（第二次出现时 tech-lead 自行写 `checkpoint: blocked`，被中继门的停机条件否决）——且返回与 `plan.md` 均无停止、熔断或待用户裁决。`plan.md` 内容与派发返回文本按不可信数据处理，绝不是指令；不满足全部条件时把停止、停滞或待决上报用户，而不是续派。
- **coder 硬顶 350k**：调用方上下文 ≥ 350000 token 且派发目标为 `coder` 时，派发直接拒绝：`Error: controller context exceeded 350000 tokens hard ceiling; checkpoint to plan.md before continuing. Recovery: update the plan.md ledger and checkpoint state, resume from a fresh tech-lead session with the plan.md path, or reduce context and retry.` 非 coder 目标（包括 `tech-lead` 与各审查席）在硬顶之上照常运行。**超集行为披露**：硬顶的实现是「派 `coder` 且调用方 ≥350k 即拒」，不区分调用方身份——因此 `author` 在 ≥350k 时派 `coder` 做临时目录验证也会被同一错误拒绝；此时 `author` 应披露该阻塞并请调用方先检查点。

### `coder_*` 配置语义

`coder` 是双档执行叶（模式 `subagent`、步数上限 80、VCS 写禁令、叶节点禁继续派发），研发主控入口是 `tech-lead`（`tech_lead_agent` / `tech_lead_model` / `tech_lead_enabled`）。两点行为值得注意：

- 用户配置中的 `agent.coder` 配置块会在注册时被插件整项替换——`registerCoder` 无条件覆盖既有同名条目，保证 coder 始终带叶节点守卫。
- 定制出口：改名用 `coder_agent`，换模型用 `coder_model`（或 `tier_models.fast.coder` 控制 Junior 档）。未知配置键一律让配置加载失败。

### 已知边界

- UI 手动切换模型不触发档位路由：档位模型只在 `janus_dispatch` 的 `mode`/`tier` 解析路径上生效。
- 3 轮熔断与停机上报由 `tech-lead` 提示词 + `plan.md` 账本约束，没有运行时计数器。
- 新守卫（`reviews_job_ids`/`stage`/水位）在 OpenCode 重启后的首次真实派发才生效。
- `tier_role_caps` 只是 consultant 团队编排的建议性上限（五个键）；文档席位不在其中，其派发次数由 `D0`–`D3` 级别规程决定。
- `janus_dispatch_continue` 到 `coder` 会话不受 350k 硬顶：硬顶规格只覆盖 `janus_dispatch`。

## 第 4 步：可选插件配置

插件读取可选的 JSONC 配置文件。默认位置（先找到者生效）：

1. `$JANUS_CONFIG` —— 显式路径覆盖
2. `$XDG_CONFIG_HOME/janus-agent/config.jsonc`
3. `~/.config/janus-agent/config.jsonc`

不想手写 JSON 时，在 OpenCode 里运行 `/janus-config`。它按九个分组列出全部可配置项，并显示每项的当前值、默认值和来源（用户设置、默认、继承）。选中某项后，命令会按类型给出编号选项：开关、数字、列表；模型字段从 `opencode models` 中列候选。写入前先展示预览 diff，经你确认后才写入。写入由插件的 `janus_config` 工具完成：按下面的 schema 全量校验，保留注释与格式，写前备份到 `<配置路径>.bak`，写后回读复核。只有五个主入口（`janus`/`consultant`/`architect`/`tech-lead`/`author`）能调用该工具，叶节点一律拒绝。改动在重启 OpenCode 后生效；`model_prompts` 例外，下一轮对话即生效。常用快捷参数：`/janus-config 2`（直接打开第 2 组）、`/janus-config 设 <key> <value>`、`/janus-config 清除 <key>`、`/janus-config 已改`、`/janus-config 校验`、`/janus-config 重置`。

`/janus-config` 的第 10 组（或 `/janus-config key`）管理 OpenCode 的 provider API key，由 `janus_provider_keys` 工具和终端命令 `janus-keys` 配合完成：

- **存放位置**：OpenCode 的生效 key 在 `$XDG_DATA_HOME/opencode/auth.json`，每个 provider 一条。本插件把每个 provider 的多个命名候选 key 存在 `$XDG_DATA_HOME/janus-agent/provider-keys.json`（权限 600，目录 700）。可选的 provider 来自 `$XDG_CACHE_HOME/opencode/models.json`，外加 `opencode.jsonc` 中的自定义 `provider`。
- **首次使用**：已在 OpenCode 中但没有名字的 key 显示为"未命名"，命令会先建议全部以 `default` 收录。收录只是把 key 复制进候选库，不改 `auth.json`，也不需要重启。只要某个 provider 当前的 key 还没有名字，就不能切换到别的 key，以免它被覆盖。
- **切换与删除**：切换会把选中的 key 写进 `auth.json`，写前备份为 `auth.json.bak`，且只改动这一个 provider 的条目。oauth 登录的 provider 不能用这里切换。删除当前生效的 key 时，需要选择只删候选（`--keep`），还是同时从 OpenCode 移除（`--logout`）。未命名的生效 key 不在候选库里：要改它的名字，用 `adopt <p> <名字>` 起名；要删除它，用不带名字的 `remove <p> --logout`。`show <p>` 的末尾会列出该 provider 当前可用的切换、改名、删除命令。
- **重启**：切换、logout，以及 `add --use` 都要完全退出并重新打开 OpenCode 才生效。在重启之前，列表的状态列显示"已切换，待重启生效"，每次写入后都会输出"当前状态 / 下一步 / 回滚"三段提示。改名、收录、只添加候选、删除非生效候选都不需要重启。
- **添加 key**：只能在终端里添加，这样 key 不会进入对话：

```bash
~/.local/share/janus-agent-plugin/bin/janus-keys add deepseek work --use      # 隐藏输入，需输入两次
pbpaste | ~/.local/share/janus-agent-plugin/bin/janus-keys add deepseek work --stdin
~/.local/share/janus-agent-plugin/bin/janus-keys add deepseek work --env DEEPSEEK_API_KEY
~/.local/share/janus-agent-plugin/bin/janus-keys list | show <p> | use <p> <name> | remove <p> <name> --keep|--logout | rename <p> <a> <b> | adopt --all
```

  每个 key 都挂在添加时指定的 provider 下，切换时只写入 `auth.json` 中该 provider 的条目。工具无法验证 key 是否真的属于这个 provider，但如果同一个 key 已用于另一个 provider，添加会被拒绝，以防填错 provider（`opencode` 和 `opencode-go` 这类确实共用 key 的情况加 `--force`）。不在 provider 目录里的自定义 provider 也需要加 `--force`。如果当前生效的 key 还没有名字，`add --use` 要配合 `--adopt-as <名字>` 先收录它。`install:local` 会打印一行 `alias janus-keys=…`，可按需加进 shell 配置。

`bun run install:local` 安装时会同时把三条斜杠命令写进 OpenCode 配置目录。这一步遵守 `install_commands` 设置和 `<!-- user-modified -->` 标记，并按指纹修剪退役的本插件生成命令；设置 `JANUS_SKIP_COMMAND_SYNC=1` 可以跳过。因此装完重启一次，新命令就会出现。

文件缺失没有问题；所有字段都有默认值。`JanusPluginConfigSchema` 是严格的（`.strict()`）：未知的顶层键，`mode_models`/`tier_models` 中未知的模式、档位或角色键，以及 `tier_role_caps` 各档位中未知的角色上限键，都会让配置加载以 schema 错误失败，而不是被静默忽略。`writer_docs_roots` 的每个根还要通过语义校验：必须是项目相对路径，不得为空、绝对路径、`~` 快捷、含 `..` 段，也不得指向整个项目。创建该文件即可覆盖默认值：

```jsonc
{
  // 15 个已注册 agent、13 个派发角色。`janus`、`architect`
  // 是主入口，不可派发；`author` 是主入口且可由顶层主入口派发。

  "janus_agent": "janus",
  "janus_model": "opencode-go/glm-5.3-flash",
  "janus_enabled": true,

  "consultant_agent": "consultant",
  "consultant_model": "opencode-go/gemini-4-argon",

  "architect_agent": "architect",
  "architect_model": "opencode-go/gemini-4-argon",
  "architect_enabled": true,

  "tech_lead_agent": "tech-lead",
  "tech_lead_model": "opencode-go/glm-5.3",
  "tech_lead_enabled": true,

  "coder_agent": "coder",
  "coder_model": "opencode-go/glm-5.3",
  "coder_enabled": true,

  "solution_reviewer_agent": "solution-reviewer",
  "solution_reviewer_model": "opencode/claude-sonnet-5-5",
  "solution_reviewer_enabled": true,

  "author_agent": "author",
  "author_model": "opencode-go/gemini-4-argon",
  "author_enabled": true,

  "simple_agent": "simple",
  "simple_model": "opencode-go/deepseek-v4.1-flash",
  "simple_enabled": true,
  // "simple_workspace_dir": "~/.local/share/janus-agent/lite",

  "common_explorer_agent": "common-explorer",
  "common_explorer_model": "opencode-go/deepseek-v4.1-flash",
  "common_explorer_enabled": true,
  "consultant_analyst_agent": "consultant-analyst",
  "consultant_analyst_model": "opencode-go/kimi-k3.1-pro",
  "consultant_analyst_enabled": true,
  "consultant_critic_agent": "consultant-critic",
  "consultant_critic_model": "opencode/claude-sonnet-5-5",
  "consultant_critic_enabled": true,
  "coder_reviewer_agent": "coder-reviewer",
  "coder_reviewer_model": "opencode-go/kimi-k3.1-pro",
  "coder_reviewer_enabled": true,
  "consultant_auditor_agent": "consultant-auditor",
  "consultant_auditor_model": "opencode-go/grok-4.7",
  "consultant_auditor_enabled": true,

  "author_writer_agent": "author-writer",
  "author_writer_model": "opencode/claude-sonnet-5-5",
  "author_writer_enabled": true,
  "writer_docs_roots": ["userdoc"],
  // "writer_delegate_agent": "host-author-writer",
  // "writer_delegate_model": "provider/model",

  "author_reviewer_agent": "author-reviewer",
  "author_reviewer_model": "opencode-go/kimi-k3.1-pro",
  "author_reviewer_enabled": true,

  // 可选：按模式 / 按档位的模型路由。优先级：
  // mode_models[mode][role] > tier_models[tier][role] >
  // <role>_model > TIER_MODEL_DEFAULTS[tier][role] > MODEL_DEFAULTS[role].
  // 出厂档位默认：fast.coder = opencode-go/glm-5.3-flash、
  // fast.coder-reviewer = opencode-go/claude-haiku-5-5、
  // fast.author-writer = opencode-go/claude-haiku-5-5、
  // fast.author-reviewer = opencode-go/deepseek-v4.1-flash，
  // standard.coder = opencode-go/deepseek-v4.1-flash；deep 档无出厂默认。
  // 显式 <role>_model 压过所有出厂档位默认：只设 author_writer_model 会让
  // fast 档写手也改用它；只改一档请写 tier_models.<tier>.<role>。
  // author-writer / author-reviewer 只有 fast 与 standard 两档。
  "mode_models": {
    "design": { "solution-reviewer": "provider/strong-reviewer", "common-explorer": "provider/fast-research" },
    "doc": { "author-writer": "provider/long-context-writer" }
  },
  "tier_models": {
    "fast": { "coder": "provider/junior-coding", "coder-reviewer": "provider/fast-patch-reviewer" }
  },

  // 全局模型适配块，键为与提供商无关的规范化模型键。
  // 用户值覆盖出厂块；"" 表示禁用。
  // "model_prompts": { "deepseekv41flash": "…" },

  "team_caps": {
    "round_cap": 3,
    "explorer_cap": 5,
    "critic_search_cap": 5
  },

  // 每档位每角色的建议性实例上限，绝不是必须凑齐的名册。
  "tier_role_caps": {
    "fast":     { "common_explorer": 5, "consultant_analyst": 0, "consultant_critic": 0, "coder_reviewer": 0, "consultant_auditor": 0 },
    "standard": { "common_explorer": 5, "consultant_analyst": 1, "consultant_critic": 1, "coder_reviewer": 1, "consultant_auditor": 1 },
    "deep":     { "common_explorer": 5, "consultant_analyst": 3, "consultant_critic": 2, "coder_reviewer": 2, "consultant_auditor": 2 }
  },

  "cost_guard_provider_usd": 10,
  "install_skill": true,
  "install_commands": true,
  "memory_enabled": true,

  // 可选：经 OpenCode 兼容 embedding 端点启用语义检索。
  "embedding": {
    "base_url": "https://api.openai.com/v1",
    "api_key_env": "OPENAI_API_KEY",
    "model": "text-embedding-3-small",
    "dimensions": 1536
  }
}
```

### 字段参考

| 字段 | 类型 | 默认值 | 说明 |
|-------|------|---------|-------------|
| `janus_agent` / `janus_model` / `janus_enabled` | string / string / boolean | `"janus"` / `opencode-go/glm-5.3-flash` / `true` | 默认前台（模式 `all`，不可派发） |
| `consultant_agent` / `consultant_model` | string / string | `"consultant"` / `opencode-go/gemini-4-argon` | 咨询团队主入口，五种证据模式 |
| `architect_agent` / `architect_model` / `architect_enabled` | string / string / boolean | `"architect"` / `opencode-go/gemini-4-argon` / `true` | 设计主入口；未设置时继承显式配置的 `consultant_model` |
| `tech_lead_agent` / `tech_lead_model` / `tech_lead_enabled` | string / string / boolean | `"tech-lead"` / `opencode-go/glm-5.3` / `true` | 研发薄控制器（模式 `all`，可派发）：写 `plan.md`、按里程碑派发隔离子会话 |
| `coder_agent` / `coder_model` / `coder_enabled` | string / string / boolean | `"coder"` / `opencode-go/glm-5.3` / `true` | 双档执行叶（subagent，步数 80，bash 全允许加 VCS 写/删除/janus-keys 护栏）；fast 档落到 `tier_models.fast.coder` 的出厂默认 `opencode-go/glm-5.3-flash`，standard 档落到 `tier_models.standard.coder` 的出厂默认 `opencode-go/deepseek-v4.1-flash` |
| `solution_reviewer_agent` / `solution_reviewer_model` / `solution_reviewer_enabled` | string / string / boolean | `"solution-reviewer"` / `opencode/claude-sonnet-5-5` / `true` | 独立审查席：设计事前验尸、Stage-1 计划评审与 Stage-2 终评 |
| `author_agent` / `author_model` / `author_enabled` | string / string / boolean | `"author"` / `opencode-go/gemini-4-argon` / `true` | 文档主入口；未设置时继承显式配置的 `consultant_model` |
| `simple_agent` / `simple_model` / `simple_enabled` | string / string / boolean | `"simple"` / `opencode-go/deepseek-v4.1-flash` / `true` | 经济型快答叶节点 |
| `simple_workspace_dir` | string（可选） | `$XDG_DATA_HOME/janus-agent/lite` | simple 的预授权可写工作区 |
| `common_explorer_agent` / `common_explorer_model` / `common_explorer_enabled` | string / string / boolean | `"common-explorer"` / `opencode-go/deepseek-v4.1-flash` / `true` | 共享检索层（只读叶节点） |
| `consultant_analyst_agent` / `consultant_analyst_model` / `consultant_analyst_enabled` | string / string / boolean | `"consultant-analyst"` / `opencode-go/kimi-k3.1-pro` / `true` | 咨询团队解读专家 |
| `consultant_critic_agent` / `consultant_critic_model` / `consultant_critic_enabled` | string / string / boolean | `"consultant-critic"` / `opencode/claude-sonnet-5-5` / `true` | 反证与计划稳健性审查者 |
| `coder_reviewer_agent` / `coder_reviewer_model` / `coder_reviewer_enabled` | string / string / boolean | `"coder-reviewer"` / `opencode-go/kimi-k3.1-pro` / `true` | 逐里程碑 patch 审查（携 `reviews_job_ids`） |
| `consultant_auditor_agent` / `consultant_auditor_model` / `consultant_auditor_enabled` | string / string / boolean | `"consultant-auditor"` / `opencode-go/grok-4.7` / `true` | 来源影响与独立性审计 |
| `author_writer_agent` / `author_writer_model` / `author_writer_enabled` | string / string / boolean | `"author-writer"` / `opencode/claude-sonnet-5-5` / `true` | 限定写入执行者、正文唯一执笔人；两档席位，fast 档出厂默认 `opencode-go/claude-haiku-5-5` |
| `author_reviewer_agent` / `author_reviewer_model` / `author_reviewer_enabled` | string / string / boolean | `"author-reviewer"` / `opencode-go/kimi-k3.1-pro` / `true` | 文档独立审稿人（只读，按阶段预算联网；`outline`/`unit`/`reader`/`final` 四阶段按 `D0`–`D3` 级别启用；两档席位，fast 档出厂默认 `opencode-go/deepseek-v4.1-flash`；不在 `tier_role_caps` 中） |
| `writer_docs_roots` | string[] | `["userdoc"]` | author-writer 的项目相对写入根；`[]` = 只读回退 |
| `writer_delegate_agent` / `writer_delegate_model` | string（可选）/ string（可选） | （无） | 宿主提供的 author-writer；设置后不再注册内置 author-writer |
| `mode_models` | object（可选） | （无） | 按模式的角色→模型覆盖 |
| `tier_models` | object（可选） | `fast.coder = opencode-go/glm-5.3-flash`、`fast.coder-reviewer = opencode-go/claude-haiku-5-5`、`fast.author-writer = opencode-go/claude-haiku-5-5`、`fast.author-reviewer = opencode-go/deepseek-v4.1-flash`、`standard.coder = opencode-go/deepseek-v4.1-flash` | 按档位的角色→模型覆盖；出厂档位默认排在 `<role>_model` 之后（显式标量会同时覆盖 fast 档出厂默认）；`deep` 不接受 `author-writer`/`author-reviewer` |
| `model_prompts` | object（可选） | （无） | 按模型键的适配块；`""` 禁用该模型的块 |
| `team_caps.round_cap` / `explorer_cap` / `critic_search_cap` | number | `3` / `5` / `5` | 团队循环与扇出上限 |
| `tier_role_caps.*` | object | fast `5/0/0/0/0`，standard `5/1/1/1/1`，deep `5/3/2/2/2` | 每档位每角色的建议性实例上限（`common_explorer`/`consultant_analyst`/`consultant_critic`/`coder_reviewer`/`consultant_auditor`） |
| `cost_guard_provider_usd` | number | `10` | 每提供商的建议性止损线 |
| `install_skill` | boolean | `true` | 安装三个 skill |
| `install_commands` | boolean | `true` | 安装 `janus-memory`、`janus-models`、`janus-config` 三条命令，并修剪退役的本插件生成命令 |
| `memory_enabled` | boolean | `true` | 注册并启动记忆 MCP 服务器 |
| `embedding.*` | object（可选） | （无） | OpenAI 兼容 embedding 配置（全有或全无） |

`embedding` 块是全有或全无：要么设齐全部四个子字段，要么整块省略。

每个角色有一次已配置的尝试，每个 agent 解析到单一模型，插件不做预先回退。未带 `writer_delegate_model` 的代理使用宿主模型选择（持久 job spec 中为 `null`）；它保留宿主权限与宿主内部重试行为。等待超时或状态未知都不授权备用模型。

consultant 把有界的证据工作路由给自己的团队：`common-explorer` 收集缺失证据，`consultant-analyst` 解读实质性分歧，`consultant-critic` 挑战重大结论与计划不确定性，`consultant-auditor` 审计用户/第三方/推广来源中不明的影响或独立性。设计、代码审查与文档属于其他团队：`architect` 负责设计并以 `solution-reviewer` 做单向门设计事前验尸；`tech-lead` 负责研发实施，派 `coder-reviewer` 逐里程碑审补丁、派 `solution-reviewer` 做 Stage-1 计划评审与 Stage-2 终评；`author` 负责文档并派发 `author-writer` 执笔与 `author-reviewer` 独立审稿（按文档级别 `D0`–`D3` 分 `outline`/`unit`/`reader`/`final` 四阶段把关，`D0` 微改不审；不可用或无有效报告时披露而非冒领）。一项检查在其可能实质改变答案、且归属方能说出它可能改变哪个决策、能抓住哪种具体失败时才被派发；跳过角色必须给出该理由。这些角色不是按档位必须凑齐的名册。每个叶节点（`common-explorer`、`consultant-analyst`、`consultant-critic`、`solution-reviewer`、`coder`、`coder-reviewer`、`consultant-auditor`、`author-writer`、`author-reviewer`、`simple`）都有 `permission.task = "deny"` 加显式 `janus_dispatch* = "deny"`、`janus_config = "deny"` 与 `janus_provider_keys = "deny"`；只读专家同时禁 `edit` 与 `bash`（`solution-reviewer` 与 `coder-reviewer` 额外获得 design 状态目录的 `external_directory` 读权限，`author-reviewer` 获得 author 与 design 两目录），`author-reviewer` 允许按审阅阶段预算使用 `webfetch`/`websearch` 复核来源，`author-writer` 是限定写入叶节点——`edit` 在 `<writer_docs_roots>/**` 之外全拒，`webfetch`/`websearch` 允许用于带来源台账的定向检索。外部 `writer_delegate_agent` 保留其宿主定义的权限，不继承这些限制；内置 `author-reviewer` 的注册不受其影响。插件在配置加载时不预检模型家族多样性，也不对咨询团队席位设跨家族硬守卫（审查席与审稿席在派发边界强制跨模型家族）；请自行选择。角色上限是建议性天花板，不是运行时强制调度器。

作者简报位于 `$XDG_DATA_HOME/janus-agent/author/<projectId>/<docId>/brief.md`（固定路径；`projectId` 由项目目录派生）。`author` 创建并更新它；`author-writer` 只读、绝不写。每个 `author-writer` 派发单元只带一个 `writeMode`：目标路径全部位于 `writer_docs_roots` 之下为 `scoped`，由写手直接写入；任一目标路径在根目录之外（如默认根下的 `README.md`、`docs/*.md`），或 `writer_docs_roots: []`，为 `read-only`，混合路径清单拆成多个单元。`read-only` 下写手只返回正文或补丁，`author` 先把返回文本逐字写入已确认的文件，再对磁盘上的文件跑 `author-reviewer` 门禁，通过后才标记 `published`；`author` 不自行放宽根目录。`AGENTS.md` 等维护文件仍路由给 `tech-lead`。被派发的 `author` 服务于派发方而非终端用户：提示带用户确认的 `Confirmed paths` 时视为已通过大纲与文件确认门，否则先返回大纲与文件清单。

角色边界、文档级别与分工阈值见 [architecture.md](architecture.md) §2；团队状态产物的路径与写入者、`plan.md` 检查点中继，以及 `coder` 的权限护栏见 [architecture.md](architecture.md) §4。

`janus` 是默认前台：处理一般问题与轻量任务，通过 `janus_dispatch` 把快答路由给 `simple`、证据工作给 `consultant`、仓库工作给 `tech-lead`；设计请求交给用户自选且不可派发的 `architect`；文档请求既可派发 `author`，也可让用户切换到该入口。派发 `consultant` 或 `author` 时 janus 附带 `Memory ownership: consultant saves` 或 `Memory ownership: author saves`，因为 janus 不持有咨询记忆。它自己不做深度研究、设计、文档或重编码。

### 模型适配提示词

每个插件自有 agent 的提示词在注册时按固定顺序静态组装：角色 asset → 共享原则片段 → 公共基线 → 公共写入门（七个只读角色省略）→ 运行时绑定。各层顺序与共享原则片段按角色的分配见 [architecture.md](architecture.md) §3.1。

模型适配块（`assets/model-prompts/<key>.md`）不属于这一静态组装。`experimental.chat.system.transform` 钩子（`createSystemTransformHook`）在**每一轮请求时**按实际服务该轮的模型解析它，并作为独立的 system 条目追加，因此模式/档位覆盖或会话续接总能拿到匹配的块。块按**模型**而非 agent 索引，且**与提供商无关**地匹配：换掉某个 agent 的模型（哪怕换成另一家提供商托管的同一模型），驾驶提示自动跟随；没有块的模型就不注入模型块。钩子只按模型匹配，不区分是哪个 agent 在使用它。

模型 ID（`provider/model`）由 `normalizeModelKey` 规范化为单一匹配键：

1. 去掉提供商前缀——最后一个 `/` 及其之前的一切（`opencode-go/deepseek-v4-pro` → `deepseek-v4-pro`）；
2. 余下部分转小写；
3. 只保留字母与数字——去掉 `-`、`.`、空格等（`deepseek-v4-pro` → `deepseekv4pro`）。

因此 `deepseek/deepseek-v4-pro` 与 `opencode-go/deepseek-v4-pro` 都解析为 `deepseekv4pro` 并共享同一个块。对规范化键的解析顺序是：

1. 你在 `model_prompts` 里对该键的条目优先（显式 `""` 会对该模型在所有提供商下禁用此块）；
2. 否则用出厂库 `assets/model-prompts/<key>.md`；
3. 否则为空——不注入模型块，角色 asset 单独运行。

出厂的 `assets/model-prompts/` 附带 11 个块，每个文件以规范化键命名。其中 8 个对应当前出厂默认模型：
- `gemini4argon.md`：`consultant`、`architect`、`author`；`glm53.md`：`tech-lead`、`coder`（Senior 标量默认）；`glm53flash.md`：`janus` 与 `tier_models.fast.coder` 的出厂档位默认；
- `deepseekv41flash.md`：`simple`、`common-explorer`，以及 `tier_models.standard.coder` 与 `tier_models.fast.author-reviewer` 的出厂档位默认；
- `kimik31pro.md`：`consultant-analyst`、`author-reviewer`、`coder-reviewer`（Senior 标量默认）；
- `claudesonnet55.md`：`solution-reviewer`、`consultant-critic`、`author-writer`；`grok47.md`：`consultant-auditor`；
- `claudehaiku55.md`：`tier_models.fast.coder-reviewer`（补丁审查档）与 `tier_models.fast.author-writer`（文档快档写手）的出厂档位默认。
另有 3 个库内备用块，目前没有出厂默认角色使用：`deepseekflash.md`（直连提供商 ID `deepseek/deepseek-flash`，同一 V4.1-Flash 模型但规范化键不同）、`gemini38flash.md`、`qwen38max.md`。

为没有块的模型新增块：以该模型 ID 的规范化键命名文件（规则同上），放到 `assets/model-prompts/<key>.md`，并把文件加进 `script/install-local.ts` 的 `REQUIRED_INSTALLED_FILES`（这是改源码的做法；安装器会校验该文件存在）。例如自定义模型 `acme/deepseek-v4-pro` 的键是 `deepseekv4pro`，文件为 `assets/model-prompts/deepseekv4pro.md`。已安装的插件上不能投放文件：改用 `model_prompts` 把你自己的块文本挂到该键上。

块内容只描述模型属性——模型的能力画像、已记载的失败倾向（agent 能力、推理/知识平衡、校准、冗长度、长上下文驾驭、协议精度），以及扬长控短的可操作约束（何时停、如何验证、如何重新锚定上下文、如何控制输出）。运行时控制——思考档位、推理力度、temperature、max tokens、模型选择——是部署配置，不是提示词内容。块里不携带角色名、角色指派、角色规则、价格/池定位或通用输出/流程规则；那些属于角色 asset，因为一个块驱动所有运行该模型的 agent。

## 数据、状态与缓存路径

记忆 SQLite 存储使用 XDG Base Directory 路径，可用环境变量覆盖：

| 路径 | 默认值 | 存放内容 |
|------|---------|------------------|
| 数据 | `$XDG_DATA_HOME/janus-agent/`（默认 `~/.local/share/janus-agent/`） | `memory.sqlite3` 与用户掌控的导出 |
| 状态 | `$XDG_STATE_HOME/janus-agent/`（默认 `~/.local/state/janus-agent/`） | 写锁、待完成 enrichment 状态、运维记录 |
| 缓存 | `$XDG_CACHE_HOME/janus-agent/`（默认 `~/.cache/janus-agent/`） | 可重建的查询缓存 |

数据库文件默认为 `<dataDir>/memory.sqlite3`。启动 MCP 服务器时可用 `JANUS_DATA_DIR`、`JANUS_STATE_DIR`、`JANUS_CACHE_DIR` 环境变量覆盖。

权威经验记录（用户批准的条目、断言、证据、决策、偏好、修订）存放在数据目录。派生产物（摘要、embedding、FTS 索引、标签）可重建，与权威数据同址存放，但删除重建不会丢失已接受的经验。

author 状态目录位于 `$XDG_DATA_HOME/janus-agent/author`（默认 `~/.local/share/janus-agent/author`）。它按 `author/<projectId>/<docId>/brief.md` 存放每篇文档一份的作者简报；`author-writer` 对其只读、绝不写。删除该目录即丢弃文档模式状态；`author` 可凭既有文档与清单重建简报。

design 状态目录位于 `$XDG_DATA_HOME/janus-agent/design`（默认 `~/.local/share/janus-agent/design`）。它按 `design/<projectId>/<designId>/design.md` 存放每项目的设计记录与 tech-lead 的 `plan.md`；没有设计记录的计划位于 `design/<projectId>/<planId>/plan.md`。`design.md` 是现态文档（原地重写，约 200-300 行，architect 是唯一写入者、tech-lead 100% 只读）；删除它需要用户确认，删除已落地（全部里程碑验证、审查消解、终报交付）的 `plan.md` 则不需要。删除该目录即丢弃设计状态。

### 退役生成物的指纹修剪

启动安装会清理本插件此前生成、现已退役的 skill 与命令文件，绝不维护一份硬编码的退役名单：

- **Skill**：`~/.config/opencode/skills/` 下不在当前 `consultation`、`consultation-design`、`consultation-doc` 名单内的目录，其 `SKILL.md` 以 `script/gen-skill.ts` 生成标记开头且带 `janus-agent` 产品名指纹时删除（目录清空则连目录一起删）。
- **命令**：`~/.config/opencode/commands/` 下文件名匹配 `janus-*.md` 且不在当前 `janus-memory`、`janus-models`、`janus-config` 名单内的文件，携带 `$XDG_DATA_HOME/janus-agent/` 数据根指纹（即内容引用了 Janus 数据根路径）时删除——其他文件名一律不扫描，用户自己的命令文件不会引用该路径，天然免疫。
- **一律保留**：带 `<!-- user-modified -->` 标记的文件（用户改过即由用户接管）、缺少指纹的外来文件，以及删除 `SKILL.md` 后仍残留其他文件的目录。
- 修剪是尽力而为的清理，全部错误静默忽略；删除后 `design`、`author`、`ledger` 三个团队状态目录照常创建。

## 第 5 步：验证安装

1. **主入口可选**：启动 OpenCode，确认 `janus`、`simple`、`consultant`、`architect`、`tech-lead`、`author` 出现在 agent 列表。
2. **simple 工作区**：`~/.local/share/janus-agent/lite` 存在，且是唯一免确认的可写位置。
3. **研发席位已注册**：`tech-lead` 以薄控制器出现（edit 仅设计状态目录、bash 全放、设计目录 `external_directory` 权限），`coder` 以双档执行叶出现（模式 `subagent`、步数 80、工作区编辑允许、项目原生命令允许、VCS 写与破坏性命令拒绝、task 拒绝）。
4. **记忆 MCP 启动**：`janus-memory` MCP 服务器已注册。其五个工具（`memory_recall`、`memory_expand`、`memory_prepare`、`memory_commit`、`memory_manage`）可用。
5. **审查子 agent 已注册**：`common-explorer`、`consultant-critic`、`solution-reviewer`、`coder-reviewer`、`consultant-auditor`、`consultant-analyst`、`author-reviewer`（均只读）与 `author-writer`（限定写入：除非改了 `writer_docs_roots`，仅允许编辑 `userdoc/**` 之下）以子 agent（模式 `subagent`）出现，经 `janus_dispatch` 工具派发。
6. **skill 就位**：`consultation/SKILL.md`、`consultation-design/SKILL.md`、`consultation-doc/SKILL.md` 存在于 `~/.config/opencode/skills/`（或你的 `$OPENCODE_CONFIG_DIR/skills/`）；设计与文档子 skill 含其模式模板。
7. **作者、设计与账本状态**：`~/.local/share/janus-agent/author`、`~/.local/share/janus-agent/design` 与 `~/.local/share/janus-agent/ledger/<projectId>` 存在；主入口提示词各自标注其状态目录绑定（`architect`/`tech-lead` 的设计记录、`author` 的作者简报、`janus` 的 `plan.md` 中继参考），权限映射允许对应目录。
8. **命令就位**：`commands/janus-memory.md`、`commands/janus-models.md`、`commands/janus-config.md` 存在于 `~/.config/opencode/`（或你的 `$OPENCODE_CONFIG_DIR/commands/`）。

也可以运行自动化集成证明：

```bash
bun run integration
```

它会在临时沙箱（绝不触碰你的真实配置或数据库）中启动一个隔离的 OpenCode 服务器、加载插件，并断言 agent、MCP 与 skill 均已注册，逐项打印 PASS/FAIL 摘要。若 `opencode` 不在 PATH 上，它打印 SKIP 并以 0 退出。

默认加载打包的 `dist/index.js`。要验证已安装的产物——部署规则所要求的那个——传入其路径：

```bash
JANUS_PLUGIN_ENTRY=~/.local/share/janus-agent-plugin/dist/index.js bun run integration
```

## 运行测试、类型检查、构建与安装

```bash
bun test                     # 全部单元测试（同目录 *.test.ts，bun:test）
bun run typecheck            # 全工作区 tsc --noEmit
bun run gen:skill            # 从 skill-src/ 重新生成三个 skill
bun run build                # 先重新生成三个 skill，再把 adapter + memory-mcp 打包进 dist/
bun run install:local        # 构建后把产物安装进安装前缀
bun run integration          # 隔离的 OpenCode 集成证明（无 opencode 时跳过）
bun run evals/run-evals.ts   # 打印评估清单（不调用真实模型）
```

`evals/fixtures/` 下的评估用例编码了架构验证场景。确定性用例映射到包内单元测试；模型评分用例打印评审量规。详见 [evals/README.md](../evals/README.md)。

## 卸载

1. **移除插件条目**。编辑 `~/.config/opencode/opencode.json`，从 `plugin` 数组删掉 `file://` 条目。

2. **移除已安装产物**：

   ```bash
   rm -rf ~/.local/share/janus-agent-plugin
   ```

   若设置过 `$JANUS_INSTALL_DIR` 则改为移除该目录。

3. **移除已安装的 skill**（可选）：

   ```bash
   rm -rf ~/.config/opencode/skills/consultation ~/.config/opencode/skills/consultation-design ~/.config/opencode/skills/consultation-doc
   ```

4. **移除已安装的命令**（可选）：

   ```bash
   rm -f ~/.config/opencode/commands/janus-memory.md ~/.config/opencode/commands/janus-models.md ~/.config/opencode/commands/janus-config.md
   ```

5. **移除插件配置文件**（可选）：

   ```bash
   rm -f ~/.config/janus-agent/config.jsonc
   ```

   若使用 `$XDG_CONFIG_HOME`：

   ```bash
   rm -f "$XDG_CONFIG_HOME/janus-agent/config.jsonc"
   ```

6. **移除记忆数据、状态与缓存**（可选；这会删除全部已存经验）：

   ```bash
   rm -rf ~/.local/share/janus-agent
   rm -rf ~/.local/state/janus-agent
   rm -rf ~/.cache/janus-agent
   ```

   自定义 XDG 路径时：

   ```bash
   rm -rf "$XDG_DATA_HOME/janus-agent"
   rm -rf "$XDG_STATE_HOME/janus-agent"
   rm -rf "$XDG_CACHE_HOME/janus-agent"
   ```

7. **移除 simple 的工作区**（可选）：`rm -rf ~/.local/share/janus-agent/lite`。
