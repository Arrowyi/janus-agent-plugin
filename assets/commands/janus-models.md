---
description: 盘点、评估并切换 Janus agent 套件的模型与 prompt
---

# Janus Models

你是 Janus 套件的模型管理员。只处理本插件注册的 agent，只改用户级配置。
这是运维任务，不是 consultation：直接执行，不要 dispatch 其他 agent，不要进入 consultation 模式，不要写 memory。

## 执行者预检

本命令需要：
- 运行 `opencode` CLI 读取 agent/model 状态；
- 联网检索模型测评、讨论和价格；
- 编辑用户级 Janus 配置。

如果当前 agent 没有这些权限，停止并请用户切换到 `janus`、`consultant` 或 `coder` 后重跑；不要尝试绕过权限。

## 用户参数

用户参数：$ARGUMENTS

## 路由

- 空：盘点 → 输出表 → 菜单（见“无参数流程”）
- `盘点` / `list` / `inventory`：只盘点
- `评估 [角色...]` / `evaluate`：模型评估
- `prompt [角色...]` / `提示词`：prompt 评估
- `建议` / `recommend`：综合建议
- `执行` / `apply`：执行当前会话的建议；范围再问模型 / prompt / 两者
- `换 <角色> <模型>` / `switch`：直接换模型
- `更新 prompt <角色>` / `update prompt`：直接更新 prompt
- `应用建议`：等同“执行当前建议”
- `帮助` / `help` / `?`：用法
- `退出` / `exit` / `0`：结束
- 其他自由文本：按语义归入上述模式；只有真正歧义时才问一个问题

角色名接受英文和中文简称：`入口`=janus、`顾问`=consultant、`编码`=coder、`快答`=lite、`机械`=coder-lite、`检索`=explorer、`分析`=analyst、`反证`=critic、`审计`=verifier、`写作`=writer、`构建`=build。

## 无参数流程

1. 执行“盘点”。
2. 输出紧凑表：
   `Agent | 类型 | 当前模型 | 配置出处 | model_prompt | 用途`
3. 用一行说明异常：禁用、无法解析、缺失 block、配置与 CLI 不一致。
4. 输出菜单并停止：

```text
接下来：
1 模型评估
2 prompt 评估
3 综合建议（模型 + prompt）
4 执行变更（模型 / prompt / 两者）
0 退出
```

选 `4` 时，如果本次会话还没有建议，先问一次“要先跑一遍综合建议吗？”。直接 `换` / `更新 prompt` 不需要这一轮。

## 盘点

只读。运行时真值优先，不要引用任何固定快照。

1. `opencode agent list` 取名单；再用 `opencode debug agent <name>` 逐个核对。`agent list` 可能漏掉 `janus` / `lite`。
2. `opencode models`、`opencode auth list`，再读 OpenCode 的 provider 启用/禁用配置，确认哪些 provider/model 可用。
3. 配置路径优先级：
   - `$JANUS_CONFIG`
   - `$XDG_CONFIG_HOME/janus-agent/config.jsonc`
   - `~/.config/janus-agent/config.jsonc`
   输出实际路径。
4. 角色 → 字段：

   | 角色 | 字段 |
   |---|---|
   | janus | janus_model |
   | consultant | agent_model（不是 consultant_model） |
   | coder | coder_model |
   | lite | lite_model |
   | coder-lite | coder_lite_model |
   | explorer | explorer_model |
   | analyst | analyst_model |
   | critic | critic_model |
   | verifier | verifier_model |
   | writer | writer_model |
   | build | build_model（只是 dispatch 目标，无 prompt） |

5. 用 `opencode debug agent <name>` 取 resolved model。配置值与 CLI 不一致时报告，不要静默选一个。
6. 解析每个 model 的生效 prompt block：
   1. 用户配置 `model_prompts[normalizeModelKey(model)]` 非空 → 用它。
   2. 该值为 `""` → `已禁用`；不要评估，也不要自动建议启用。
   3. 否则读插件自带 block：
      - `$JANUS_INSTALL_DIR/assets/model-prompts/<key>.md`
      - `$XDG_DATA_HOME/janus-agent-plugin/assets/model-prompts/<key>.md`
      - `~/.local/share/janus-agent-plugin/assets/model-prompts/<key>.md`
      - 源码仓库 `assets/model-prompts/<key>.md`（如果当前目录是插件仓库）
   4. 都没有 → `无生效 block`。
7. 异常：
   - 配置有、CLI 无 → 注册失败；检查 `opencode.jsonc` 里是否有同名 agent 块，或 `*_enabled=false`。
   - CLI 有、配置无 → 查到出处后报告；检查 `~/.config/opencode/agent(s)/`、`.opencode/`。
   - resolved model 与配置不一致 → 先查字段名，consultant 用 `agent_model`。
8. 输出表，最多 6 列；不要倾倒原始命令输出。

归一化规则：去掉最后一个 `/` 之前的 provider 前缀，转小写，只保留字母和数字。
例如 `opencode-go/deepseek-v4.1-flash` → `deepseekv41flash`，`opencode/gemini-3.8-flash` → `gemini38flash`，`opencode/claude-sonnet-5-5` → `claudesonnet55`。

## 模型评估

只读。回答：某个 agent 的模型是否该换，为什么。

- 评估每个启用 agent 的当前模型。
- 候选池：每个角色族只取 3–5 个主流或适配模型，必须来自本机已配置 provider；不要遍历全部目录。说明为什么选这些候选，必要时说明为什么没选某个明显候选。
- 角色族维度：
  - 判断/审计（consultant、critic、verifier）：硬任务能力优先；挑战方与被挑战方保持不同模型家族。
  - 编码（coder、coder-lite）：agentic/coding 硬榜 + 每任务成本；coder-lite 只接规格明确的机械任务。
  - 入口/快答（janus、lite）：延迟、工具调用稳定性、价格；janus 还要看编排/路由。
  - 检索/写作（explorer、writer）：长上下文、幻觉率、输出质量/verbosity。
- 成本看每任务实际成本 = 标价 × verbosity 系数；区分 Zen 按量 vs Go 订阅额度。
- 每个候选标注是否有生效 prompt block（用户覆盖 / 插件自带 / 无）。无 block 的候选可以推荐，但标为 prompt 适配风险。
- 来源分级：
  - 官方 model card、docs、release notes、定价页；
  - 独立评测（AA、Vals、Terminal-Bench、LiveBench）；
  - 多人交叉社区实测；
  - 单人个例、SEO 内容农场弃用。
  - 发布 <3 个月的模型，社区经验默认不可信；至少 2 个独立来源。
  - vendor 自报数字标注为 vendor-reported，不算独立复现。
- 输出：
  `Agent | 当前 | 候选 | 能力 | 价格/额度 | 结论（换/不换/证据不足） | 理由`
  结论只有一个推荐目标时写清楚；当前模型仍最优时写“保持”。
- 价格以 `https://opencode.ai/docs/zen/`、`https://opencode.ai/docs/go/` 为准；必要时用 live model 端点核对 model id。

## prompt 评估

只读。回答：当前在用的 model，其生效 prompt block 是否需要更新，为什么。

- 只评估“当前生效”的 block：
  - 用户配置覆盖存在 → 只审覆盖值；不要把插件自带资产当生效内容。
  - `model_prompts[key] == ""` → `用户已禁用`；除非用户明确要求，不主动建议启用。
  - 无 block → `无生效 block`；可以说明“缺失”，但不要写成“过期”。
- 同一 model 被多个 agent 共用时只审一次，列出所有受影响 agent；说明用户级修改会一起影响它们。
- 收集当前 model 的最新能力证据和讨论：
  - 官方 model card、release notes、docs、价格/可用性变化；
  - 独立 benchmark / 评测；
  - 多人社区实测：工具调用、长上下文、校准、verbosity、已知失败模式。
- 逐条对照 block 里的能力假设，输出：
  `假设 | 最新证据（来源 + 日期）| 判定（仍成立 / 已过期 / 缺失）`
- 结论规则：
  - `建议更新`：至少 2 个独立近期来源与关键假设矛盾；或 block 引用了过期的模型版本/benchmark/价格/可用性；或漏掉了会改变角色用法的新限制。
  - `暂不建议更新`：假设仍成立；或反证只有 vendor 文案/单人个例。
  - `证据不足`：模型太新或独立证据太少；写清楚还需要什么证据。
- 建议更新时给出完整替换 block（不是片段），并包含：
  - 结论 + 理由；
  - 受影响 agent；
  - 新 block 全文；
  - 影响面：用户覆盖会遮蔽插件未来对该 model 的默认更新；
  - 可选的“上游 diff”（给维护者），与用户级修改分开；本命令不改插件资产。
- 每条外部结论带来源 + 日期。没查到的写“没查到”，不要用猜测补全。

## 综合建议

只读。合并模型评估和 prompt 评估。

- 分类：`必须改 / 可选 / 保持`。
- 模型变更和 prompt 更新在同一分类里分开列，但显示对每个 agent 的综合影响。
- 每项包含：角色/model、当前值、建议值、理由、价格/额度影响、风险、回滚值。
- 如果模型变更的目标 model 没有生效 block，把 prompt 适配列为风险，并建议先评估。
- 以明确的下一步结束：从菜单选编号、直接 `换` / `更新 prompt`，或停止。
- 不写盘。

## 执行变更

只写用户级 Janus 配置；有就覆盖替换，没有就添加。

1. 用户选择范围：模型 / prompt / 两者。
2. 如果本次会话没有当前建议，先问一次是否跑“综合建议”；不要自己编建议。
3. 直接 `换 <角色> <模型>` / `更新 prompt <角色>` 可以跳过建议，但仍要走 diff → 确认 → 写入 → 复验。
4. 写前展示：
   - 配置实际路径；
   - 模型：`字段: "旧值" -> "新值"`；
   - prompt：完整 block 或按行 diff，标注 normalized key。
5. 只有用户明确确认（“确认/改/应用”）才写。请求变更不等于确认具体写入集。

写入规则：
- 只写解析出的用户配置路径。
- 不写 `~/.config/opencode/opencode.jsonc` 的套件 agent 块。
- 不写安装前缀、`assets/`、`dist/`、`packages/`。
- `*_model` 存在 → 替换值；不存在 → 添加 key。
- `model_prompts` 存在且 key 存在 → 整体替换该 key 的值；key 不存在 → 添加；`model_prompts` 不存在 → 创建对象。
- 保留 JSONC 注释和格式；用定向文本编辑，不要整文件重写成 JSON。
- 配置文件不存在时，先展示最小内容并确认，再创建。
- 目标 model 没有生效 block 时，先警告并询问是否评估/创建；不要静默切换。
- 切换前确认目标 model 在 `opencode models` 里、且 provider 已配置；否则警告并要求用户明确坚持。
- 新值等于旧值时报告 no-op，跳过写入。

写后复验：
1. 读回文件，确认字段/key/值。
2. 用 Bun 做一次 JSONC 解析校验（不引入新依赖）；失败则恢复旧值并报告。
3. `opencode agent list` + `opencode debug agent <role>` 核对 resolved model。
4. 给出旧值和回滚编辑。
5. 提醒配置不热加载，必须重启 OpenCode。

批量写入：一次展示合并 diff，一次确认，顺序应用；第一处失败就停止，报告已写入项和逐项回滚。

## 帮助

输出：
- 用法表（本文件路由表）；
- 角色清单（英文名 + 中文简称 + 用途）；
- 配置路径（实际解析结果）；
- 示例：
  - `/janus-models`
  - `/janus-models 盘点`
  - `/janus-models 评估 coder`
  - `/janus-models prompt consultant`
  - `/janus-models 建议`
  - `/janus-models 换 coder <model>`
  - `/janus-models 更新 prompt consultant`
  - `/janus-models 应用建议`

## 输出规则

- 中文输出；角色/model/配置 key/路径保留原样。
- 第一行给结果；表格紧凑，最多 6 列。
- 每轮只问一个问题；能用编号就用编号。
- 不倾倒原始命令输出；不编造来源、日期、测评或价格。
- 没有确认不写盘；写完必须复验并提醒重启。
