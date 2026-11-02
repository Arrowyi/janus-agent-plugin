# 本地部署指南

本指南覆盖把 janus-agent 插件安装到本地 OpenCode 环境的完整流程。

## 部署规则

**只部署打包产物。绝不让 OpenCode 配置指向本仓库源码。**

本项目要分发给其他用户，因此部署必须仅凭构建产物即可复现：不得依赖仓库检出、其 `node_modules` 或 Bun 的模块缓存。具体要求：

- 用 `bun run install:local` 构建并安装：它构建 `dist/`、把 `dist/` + `assets/` 装入安装前缀，并校验结果。
- OpenCode 的 `plugin` 条目指向**已安装的** `dist/index.js`，绝不指向 `packages/opencode-adapter/src/index.ts`。
- 安装产物必须自包含：`script/build.ts` 不标记任何外部依赖，记忆 MCP 服务器解析为同目录打包的 `memory-mcp-server.js`，因此不随安装携带任何 `node_modules`。
- 源码模式条目只用于本仓库自己的测试运行（`bun test`、`bun run integration`），绝不用于可用环境或发布。

任何重新引入外部运行时导入、或配置指向源码的改动都违反本规则。`bun test` 守护解析逻辑，`bun run integration` 证明已安装产物能正确注册。

## 前置条件

- **Bun >= 1.1** —— 运行时与包管理器。从 <https://bun.sh> 安装。
- **OpenCode** —— agent 宿主。从 <https://opencode.ai> 或你的包管理器安装，用 `opencode --version` 验证。
- **模型提供商** —— 出厂默认假设你持有 **OpenCode Go（Go Plus）订阅**（覆盖 `opencode-go/*` 池内模型），外加 `opencode` 提供商（Zen 按量付费）供三个判断席位使用 `opencode/claude-sonnet-5-5`（`consultant-critic`、`coder-reviewer`、`author-writer`）。没有这些提供商时 agent 会注册成功，但在使用时于模型解析处失败。非 Go 用户：把下面的配置复制到 `~/.config/janus-agent/config.jsonc`，把每个 `*_model` 设为你机器上已配置的提供商。派发失败时会打印带精确字段名的修复提示。

  ```jsonc
  {
    "janus_model": "<你的提供商>/fast-tool-caller",
    "consultant_model": "<你的提供商>/strong-agentic-model",
    "architect_model": "<你的提供商>/strong-agentic-model",
    "author_model": "<你的提供商>/strong-agentic-model",
    "common_explorer_model": "<你的提供商>/fast-cheap-model",
    "consultant_analyst_model": "<你的提供商>/reasoning-model",
    "consultant_critic_model": "<你的提供商>/different-family-model",
    "coder_reviewer_model": "<你的提供商>/different-family-model",
    "consultant_auditor_model": "<你的提供商>/different-family-model",
    "author_writer_model": "<你的提供商>/writing-model",
    "coder_model": "<你的提供商>/strong-coding-model",
    "simple_model": "<你的提供商>/fast-cheap-model",
    "coder_lite_model": "<你的提供商>/mechanical-coding-model"
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
  assets/commands/janus-handoff.md
  package.json                溯源
  build-meta.json             版本 / git sha / 构建时间
```

重跑 `bun run install:local` 会重新构建并替换已安装产物，之后重启 OpenCode 加载。安装内的三个 skill 文件由 `skill-src/**` 生成；只编辑源、绝不手改生成物。

已安装插件自带其所需的全部提示词（含 `assets/agents/author-writer.md`），运行时不需要 OMO、外部 janus agent、`~/.config/opencode/agents/` 下的全局 agent 文件、外部 skill 或源码检出。author-writer 缺失会使文档模式不可用：此时会披露该情况，并提供启用 author-writer、配置 `writer_delegate_agent`、或用户明确接受的正文中写回退三个选项——绝不静默亲自书写读者可见正文。

### 开发专用：源码模式

在本仓库内迭代（单元测试、集成证明或一次性会话）时，插件条目可以指向 `packages/opencode-adapter/src/index.ts`。Bun 直接运行 TypeScript，无需构建；但该模式要求仓库检出及其 `node_modules` 存在，绝不用于已安装部署或发布。

## 第 3 步：重启 OpenCode

重启 OpenCode 使其加载新的插件条目。启动时插件的 `config` 钩子执行：

1. 注册 `consultant` 主入口（名字可用 `consultant_agent` 配置），授予共享 handoff 状态目录的 `external_directory` 权限，可读写跨团队交接文档；
2. 注册 `coder` 编码入口（模式 `all`：可选可派发）、`simple` 经济叶节点（模式 `all`，禁止派发）与 `coder-lite` 机械车道（模式 `subagent`，步数上限 50，工作区编辑免确认，禁止继续派发）；
3. 注册 `simple` 的工作区目录（`$XDG_DATA_HOME/janus-agent/lite`，可用 `simple_workspace_dir` 配置）为免确认可写；其余写入一律先询问。同时创建设计状态目录 `$XDG_DATA_HOME/janus-agent/design`（由 `architect`、`author`、`coder` 访问：architect 写 `design.md`，coder 读它并写 `plan.md`）与 handoff 状态目录 `$XDG_DATA_HOME/janus-agent/handoff`（由五个主入口 `janus`、`consultant`、`architect`、`coder`、`author` 共享访问；叶节点子 agent 绝不写它）；
4. 注册检索/审查子 agent `common-explorer`、`consultant-analyst`、`consultant-critic`、`coder-reviewer`、`consultant-auditor`（各自只读、各用其配置模型、各自禁 shell 与派发），以及限定写入的执笔者 `author-writer`（仅允许编辑 `writer_docs_roots` 之下，默认 `userdoc/**`；禁 shell 与派发；允许带来源台账的定向网络检索；步数上限 80；`writer_docs_roots` 为空时转为只读，由 author 发布其返回的正文）。同时创建 author 状态目录 `$XDG_DATA_HOME/janus-agent/author`，`author` 在其中写每篇文档的简报；
5. 注册 `janus-memory` 本地 MCP 服务器（记忆启用时，默认开启）；
6. 为十个派发角色注册 `janus_dispatch{role,prompt,return_handle?,mode?,tier?,protocol?}`、`janus_dispatch_wait{job_id,wait_ms?}`、`janus_dispatch_cancel{job_id}` 与 `janus_dispatch_continue{session_id,prompt,role?}`（不干扰内置 `task` 工具或其他插件）。`mode`/`tier` 选择模型；`protocol` 在首轮前prepend五张方法论卡片之一；
7. 把 `consultation`、`consultation-design`、`consultation-doc` 三个 skill 与 `/janus-memory`、`/janus-models`、`/janus-handoff` 三条斜杠命令安装进你的 OpenCode 配置目录。

### 可恢复的团队任务

所有角色共享同一套可恢复派发生命周期；每个 agent 解析到单一已配置模型，插件不做回退链。发起派发在 300000 毫秒软等待窗口内观察。超时返回可恢复的 job 信封而非专家失败，也绝不中止子任务。等待使用同一个 `job_id`，包括协调者重启之后；`wait_ms` 是可选整数 0..300000（默认 300000；零为快照）。pending/unknown 的 job 不得触发重复发起、备用模型或静默内联替代。最终必须整合原任务的原始报告，并披露任何未解决的独立检查。

`janus_dispatch` 的 `return_handle: true` 只改变成功结果的形态：不再返回纯文本，而是返回已完成的 JSON 信封（`job_id`、`role`、`attempt`、`session_id`、`waited_ms`、`text`），其 `session_id` 可复用；pending 与失败结果不变，默认成功结果仍是纯文本。

`janus_dispatch_continue` 用新提示复用既有派发会话——对每个派发方与角色通用的机制（consultant 用它做文档的 author-writer 反馈循环）。复用边界：同一调用方、同一工作区、目标是带派发标记的普通 job 根或其尝试子节点（绝不是续接 `job_id`——用原始 `session_id`）、且目标空闲（busy/retry 目标以「先等待」错误拒绝）；只有终态 job 可续接，pending 的 job 先等待。续接 job 的等待/取消沿用 `janus_dispatch_wait`/`janus_dispatch_cancel` 契约。续接没有新增配置——没有配置字段、没有注册表、也没有跨会话复用；文档模式下会话 ID 以 `writer_session_id` 存在该文档的简报中。

取消是显式操作，在持久中止证据确认 `cancelled` 之前可能返回 `cancelling`；正常完成与取消竞速时完成方胜出并返回报告。非终态信封把 `janus_dispatch_wait` 标为其下一步动作。等待/取消以调用方的父会话与工作区判定归属，不接受路由覆盖。详见[架构文档](architecture.md)的「6.4 可恢复派发 API」一节。

## 第 4 步：可选插件配置

插件读取可选的 JSONC 配置文件。默认位置（先找到者生效）：

1. `$JANUS_CONFIG` —— 显式路径覆盖
2. `$XDG_CONFIG_HOME/janus-agent/config.jsonc`
3. `~/.config/janus-agent/config.jsonc`

文件缺失没有问题；所有字段都有默认值。schema 是严格的：顶层键被删除、`mode_models`/`tier_models` 内出现旧角色或旧模式键、或 `tier_role_caps` 出现旧键，都会让配置加载以 schema 错误失败，而不是被静默忽略或清零。`writer_docs_roots`、`writer_delegate_agent`/`writer_delegate_model`、以及简报中的 `writer_session_id` 就是现用字段名。创建该文件即可覆盖默认值：

```jsonc
{
  // 13 个已注册 agent、10 个派发角色。`janus`、`architect`、`author`
  // 是主入口，不可派发。

  "janus_agent": "janus",
  "janus_model": "opencode-go/glm-5.3-flash",
  "janus_enabled": true,

  "consultant_agent": "consultant",
  "consultant_model": "opencode-go/gemini-4-argon",

  "architect_agent": "architect",
  "architect_model": "opencode-go/gemini-4-argon",
  "architect_enabled": true,

  "coder_agent": "coder",
  "coder_model": "opencode-go/glm-5.3",
  "coder_enabled": true,

  "author_agent": "author",
  "author_model": "opencode-go/gemini-4-argon",
  "author_enabled": true,

  "simple_agent": "simple",
  "simple_model": "opencode-go/deepseek-v4.1-flash",
  "simple_enabled": true,
  // "simple_workspace_dir": "~/.local/share/janus-agent/lite",

  "coder_lite_agent": "coder-lite",
  "coder_lite_model": "opencode-go/glm-5.3-flash",
  "coder_lite_enabled": true,

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
  "coder_reviewer_model": "opencode/claude-sonnet-5-5",
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

  // 可选：按模式 / 按档位的模型路由。优先级：
  // mode_models[mode][role] > tier_models[tier][role] >
  // <role>_model > TIER_MODEL_DEFAULTS[tier][role] > MODEL_DEFAULTS[role].
  // 插件出厂仅带一个档位默认：deep.coder = opencode-go/kimi-k3.1-pro。
  "mode_models": {
    "design": { "coder-reviewer": "provider/strong-reviewer", "common-explorer": "provider/fast-research" },
    "doc": { "author-writer": "provider/long-context-writer" }
  },
  "tier_models": {
    "deep": { "coder": "provider/strong-coding" }
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
    "fast":     { "common_explorer": 5, "consultant_analyst": 0, "consultant_critic": 0, "coder_reviewer": 0, "consultant_auditor": 0, "author_writer": 0 },
    "standard": { "common_explorer": 5, "consultant_analyst": 1, "consultant_critic": 1, "coder_reviewer": 1, "consultant_auditor": 1, "author_writer": 1 },
    "deep":     { "common_explorer": 5, "consultant_analyst": 3, "consultant_critic": 2, "coder_reviewer": 2, "consultant_auditor": 2, "author_writer": 2 }
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
| `coder_agent` / `coder_model` / `coder_enabled` | string / string / boolean | `"coder"` / `opencode-go/glm-5.3` / `true` | 编码主入口；L3 工作可用 deep 档覆盖 |
| `author_agent` / `author_model` / `author_enabled` | string / string / boolean | `"author"` / `opencode-go/gemini-4-argon` / `true` | 文档主入口；未设置时继承显式配置的 `consultant_model` |
| `simple_agent` / `simple_model` / `simple_enabled` | string / string / boolean | `"simple"` / `opencode-go/deepseek-v4.1-flash` / `true` | 经济型快答叶节点 |
| `simple_workspace_dir` | string（可选） | `$XDG_DATA_HOME/janus-agent/lite` | simple 的预授权可写工作区 |
| `coder_lite_agent` / `coder_lite_model` / `coder_lite_enabled` | string / string / boolean | `"coder-lite"` / `opencode-go/glm-5.3-flash` / `true` | 机械编码车道（subagent，步数 50） |
| `common_explorer_agent` / `common_explorer_model` / `common_explorer_enabled` | string / string / boolean | `"common-explorer"` / `opencode-go/deepseek-v4.1-flash` / `true` | 共享检索层（只读叶节点） |
| `consultant_analyst_agent` / `consultant_analyst_model` / `consultant_analyst_enabled` | string / string / boolean | `"consultant-analyst"` / `opencode-go/kimi-k3.1-pro` / `true` | 咨询团队解读专家 |
| `consultant_critic_agent` / `consultant_critic_model` / `consultant_critic_enabled` | string / string / boolean | `"consultant-critic"` / `opencode/claude-sonnet-5-5` / `true` | 反证与计划稳健性审查者 |
| `coder_reviewer_agent` / `coder_reviewer_model` / `coder_reviewer_enabled` | string / string / boolean | `"coder-reviewer"` / `opencode/claude-sonnet-5-5` / `true` | 设计事前验尸与 coder 计划/diff 审查 |
| `consultant_auditor_agent` / `consultant_auditor_model` / `consultant_auditor_enabled` | string / string / boolean | `"consultant-auditor"` / `opencode-go/grok-4.7` / `true` | 来源影响与独立性审计 |
| `author_writer_agent` / `author_writer_model` / `author_writer_enabled` | string / string / boolean | `"author-writer"` / `opencode/claude-sonnet-5-5` / `true` | 限定写入执行者、正文唯一执笔人 |
| `writer_docs_roots` | string[] | `["userdoc"]` | author-writer 的项目相对写入根；`[]` = 只读回退 |
| `writer_delegate_agent` / `writer_delegate_model` | string（可选）/ string（可选） | （无） | 宿主提供的 author-writer；设置后不再注册内置 author-writer |
| `mode_models` | object（可选） | （无） | 按模式的角色→模型覆盖 |
| `tier_models` | object（可选） | `deep.coder = opencode-go/kimi-k3.1-pro` | 按档位的角色→模型覆盖；出厂档位默认排在 `<role>_model` 之后 |
| `model_prompts` | object（可选） | （无） | 按模型键的适配块；`""` 禁用该模型的块 |
| `team_caps.round_cap` / `explorer_cap` / `critic_search_cap` | number | `3` / `5` / `5` | 团队循环与扇出上限 |
| `tier_role_caps.*` | object | fast `5/0/0/0/0/0`，standard `5/1/1/1/1/1`，deep `5/3/2/2/2/2` | 每档位每角色的建议性实例上限（`common_explorer`/`consultant_analyst`/`consultant_critic`/`coder_reviewer`/`consultant_auditor`/`author_writer`） |
| `cost_guard_provider_usd` | number | `10` | 每提供商的建议性止损线 |
| `install_skill` | boolean | `true` | 安装三个咨询 skill |
| `install_commands` | boolean | `true` | 安装 `janus-memory`、`janus-models`、`janus-handoff` 三条命令 |
| `memory_enabled` | boolean | `true` | 注册并启动记忆 MCP 服务器 |
| `embedding.*` | object（可选） | （无） | OpenAI 兼容 embedding 配置（全有或全无） |

`embedding` 块是全有或全无：要么设齐全部四个子字段，要么整块省略。

每个角色有一次已配置的尝试，每个 agent 解析到单一模型，插件不做预先回退。未带 `writer_delegate_model` 的代理使用宿主模型选择（持久 job spec 中为 `null`）；它保留宿主权限与宿主内部重试行为。等待超时或状态未知都不授权备用模型。

consultant 把有界的证据工作路由给自己的团队：`common-explorer` 收集缺失证据，`consultant-analyst` 解读实质性分歧，`consultant-critic` 挑战重大结论与计划不确定性，`consultant-auditor` 审计用户/第三方/推广来源中不明的影响或独立性。设计、代码审查与文档属于其他团队：`architect` 负责设计并与 `coder` 共享 `coder-reviewer`（设计事前验尸 / 计划-diff 审查）；`author` 负责文档并派发 `author-writer` 执笔。一项检查在其可能实质改变答案、且归属方能说出它可能改变哪个决策、能抓住哪种具体失败时才被派发；跳过角色必须给出该理由。这些角色不是按档位必须凑齐的名册。每个叶节点（`common-explorer`、`consultant-analyst`、`consultant-critic`、`coder-reviewer`、`consultant-auditor`、`author-writer`、`coder-lite`、`simple`）都有 `permission.task = "deny"` 加显式 `janus_dispatch* = "deny"`；只读专家同时禁 `edit` 与 `bash`，`author-writer` 是限定写入叶节点——`edit` 在 `<writer_docs_roots>/**` 之外全拒，`webfetch`/`websearch` 允许用于带来源台账的定向检索。外部 `writer_delegate_agent` 保留其宿主定义的权限，不继承这些限制。插件不强制模型家族多样性；请自行选择。角色上限是建议性天花板，不是运行时强制调度器。

作者简报位于 `$XDG_DATA_HOME/janus-agent/author/<projectId>/<docId>/brief.md`（固定路径；`projectId` 由项目目录派生）。`author` 创建并更新它；`author-writer` 只读、绝不写。限定写入模式下 `author` 不编辑写手根目录下的文件——它审查 author-writer 的 diff 并请求有界修正。

`architect` 拥有 `design` 模式：逐层决定架构、模块边界与接口，把结果记入 `design.md`，并把记录移交给 `coder` 做实施计划。设计状态位于 `$XDG_DATA_HOME/janus-agent/design/<projectId>/<designId>/design.md`；`coder` 读它并在同目录写 `plan.md`。`architect` 与 `coder` 拥有 `<designStateDir>/**` 的预授权 `external_directory` 权限；两者都不把设计状态写进项目树。跨团队交接位于 `$XDG_DATA_HOME/janus-agent/handoff/<projectId>/<handoffId>/handoff.md`——五个主入口共享的唯一业务态目录（`consultant` 不持有其他）；交接文档在首次跨主入口交接时懒创建，由 ≤ 80 行的现态快照加倒序 Hop 账本构成，跨会话追加、没有自动完结，通过 `/janus-handoff` 命令管理。编码由 `coder` 负责：完全指定的机械工作交给 `coder-lite`（工作区编辑免确认、外部编辑先询问、禁止继续派发——它的停下上报是合法的部分结果，由派发方整合）；判断密集型工作留在 `coder`，L3 工作可用 `tier: "deep"` 派发到更强的已配置模型。`coder` 按任务复杂度选择 L0/L1/L2/L3 过程权重，并在编辑前对 L2/L3 设置用户审批门。

`janus` 是默认前台：处理一般问题与轻量任务，通过 `janus_dispatch` 把快答路由给 `simple`、证据工作给 `consultant`、编码给 `coder`；设计与文档请求交给用户自选且不可派发的 `architect` 与 `author`。派发 `consultant` 时 janus 附带 `Memory ownership: consultant saves`，因为 janus 不持有咨询记忆。它自己不做深度研究、设计、文档或重编码。

### 模型适配提示词

每个插件自有 agent 的提示词按以下顺序组装：角色 asset（`assets/agents/<agent>.md`——身份、范围、流程、纪律）、模型适配块、共享片段（五个只读审查/检索角色用 `assets/principles/research-leaf.md`，consultant-analyst 与 consultant-critic 用 `assets/principles/reasoning-failures.md`，`janus`/`consultant`/`coder` 用 `assets/principles/dispatch-hub.md`）、工程原则（`assets/principles/engineering-principles.md`，供 `coder`、`coder-reviewer` 与 `consultation-design` skill）、公共基线（`assets/principles/common-base.md`——每个角色的认识论诚实、不可信输入、机密与范围/冲突规则）、公共写入门（`assets/principles/common-write.md`——持久文件变更确认，只读角色省略），最后是运行时绑定（注入 asset 的 `RUNTIME-BINDINGS` 占位符）。模型块按**模型**而非 agent 索引，且**与提供商无关**地匹配：在配置里换掉某个 agent 的模型（哪怕换成另一家提供商托管的同一模型），它的驾驶提示自动跟随；没有块的模型就 simply 没有块。

模型 ID（`provider/model`）由 `normalizeModelKey` 规范化为单一匹配键：

1. 去掉提供商前缀——最后一个 `/` 及其之前的一切（`opencode-go/deepseek-v4-pro` → `deepseek-v4-pro`）；
2. 余下部分转小写；
3. 只保留字母与数字——去掉 `-`、`.`、空格等（`deepseek-v4-pro` → `deepseekv4pro`）。

因此 `deepseek/deepseek-v4-pro` 与 `opencode-go/deepseek-v4-pro` 都解析为 `deepseekv4pro` 并共享同一个块。对规范化键的解析顺序是：

1. 你在 `model_prompts` 里对该键的条目优先（显式 `""` 会对该模型在所有提供商下禁用此块）；
2. 否则用出厂库 `assets/model-prompts/<key>.md`；
3. 否则为空——角色 asset 单独运行。

出厂附带八个块，每个文件以规范化键命名：六个对应出厂默认模型——`glm53.md`（GLM-5.3；consultant、janus、coder 的默认）、`deepseekv41flash.md`（DeepSeek V4.1-Flash；simple 与 common-explorer 的默认）、`qwen38max.md`（Qwen3.8-Max；consultant-analyst 的默认）、`gemini38flash.md`（Gemini 3.8-Flash；consultant-critic、coder-reviewer、consultant-auditor 的默认）、`glm53flash.md`（GLM-5.3-Flash；coder-lite 的默认）、`claudesonnet55.md`（Claude Sonnet 5.5；author-writer 的默认）——外加 `deepseekflash.md`（直连提供商 ID `deepseek/deepseek-flash`，同一 V4.1-Flash 模型但规范化键不同）与 `gemini4argon.md`（可选的 Gemini 4 Argon 覆盖 `opencode-go/gemini-4-argon`）。

为没有块的模型新增块：以该模型 ID 的规范化键命名文件（规则同上），放到 `assets/model-prompts/<key>.md`，并把文件加进 `script/install-local.ts` 的 `REQUIRED_INSTALLED_FILES`（这是改源码的做法；安装器会校验该文件存在）。例如自定义模型 `acme/deepseek-v4-pro` 的键是 `deepseekv4pro`，文件为 `assets/model-prompts/deepseekv4pro.md`。已安装的插件上不能投放文件：改用 `model_prompts` 把你自己的块文本挂到该键上。

块内容只描述模型属性——模型的能力画像、已记载的失败倾向（agent 能力、推理/知识平衡、校准、冗长度、长上下文驾驭、协议精度），以及扬长控短的可操作约束（何时停、如何验证、如何重新锚定上下文、如何控制输出）。运行时控制——思考档位、推理力度、temperature、max tokens、模型选择——是部署配置，不是提示词内容。块里不携带角色名、角色指派、角色规则、价格/池定位或通用输出/流程规则；那些属于角色 asset，因为一个块驱动所有运行该模型的 agent。代理写手指向宿主自有 agent，不取模型提示。

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

design 状态目录位于 `$XDG_DATA_HOME/janus-agent/design`（默认 `~/.local/share/janus-agent/design`）。它按 `design/<projectId>/<designId>/design.md` 存放每项目的设计记录与 coder 的 `plan.md`；没有设计记录的计划位于 `design/<projectId>/<planId>/plan.md`。`design.md` 是现态文档（原地重写，约 200-300 行）；删除它需要用户确认，删除已折回的 `plan.md` 则不需要。删除该目录即丢弃设计状态。

handoff 状态目录位于 `$XDG_DATA_HOME/janus-agent/handoff`（默认 `~/.local/share/janus-agent/handoff`）。它按 `handoff/<projectId>/<handoffId>/handoff.md` 存放每个课题一份的跨团队交接文档：YAML frontmatter（`handoff_id`、`title`、`status`、`current_team`、`hop_state`、`hop_count`、`updated_at`）、至多 80 行的 `## 1. Current Truth Snapshot`（带标签与原地 `supersedes` 的事实、待解决问题、只存路径指针的产物区），以及最新 `### Hop N` 紧贴标题下方的 `## 2. Handoff Ledger (Newest First)`。交接在首次跨主入口交接时懒创建，跨会话保持打开，直到用户通过 `/janus-handoff` 归档或删除。删除该目录即丢弃全部交接状态；用 `/janus-handoff export` 保留副本。

## 第 5 步：验证安装

1. **主入口可选**：启动 OpenCode，确认 `janus`、`simple`、`consultant`、`architect`、`coder`、`author` 出现在 agent 列表。
2. **simple 工作区**：`~/.local/share/janus-agent/lite` 存在，且是唯一免确认的可写位置。
3. **coder-lite 车道已注册**：`coder-lite` 以子 agent 出现（步数 50、工作区编辑允许、task 拒绝）。
4. **记忆 MCP 启动**：`janus-memory` MCP 服务器已注册。其五个工具（`memory_recall`、`memory_expand`、`memory_prepare`、`memory_commit`、`memory_manage`）可用。
5. **审查子 agent 已注册**：`common-explorer`、`consultant-critic`、`coder-reviewer`、`consultant-auditor`、`consultant-analyst`（只读）与 `author-writer`（限定写入：除非改了 `writer_docs_roots`，仅允许编辑 `userdoc/**` 之下）以子 agent（模式 `subagent`）出现，经 `janus_dispatch` 工具派发。
6. **skill 就位**：`consultation/SKILL.md`、`consultation-design/SKILL.md`、`consultation-doc/SKILL.md` 存在于 `~/.config/opencode/skills/`（或你的 `$OPENCODE_CONFIG_DIR/skills/`）；设计与文档子 skill 含其模式模板。
7. **设计与交接状态**：`~/.local/share/janus-agent/design` 与 `~/.local/share/janus-agent/handoff` 存在；五个主入口提示词标注项目交接目录，其权限映射允许 `<handoffStateDir>/**`。
8. **命令就位**：`commands/janus-memory.md`、`commands/janus-models.md`、`commands/janus-handoff.md` 存在于 `~/.config/opencode/`（或你的 `$OPENCODE_CONFIG_DIR/commands/`）。

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
   rm -f ~/.config/opencode/commands/janus-memory.md ~/.config/opencode/commands/janus-models.md ~/.config/opencode/commands/janus-handoff.md
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
