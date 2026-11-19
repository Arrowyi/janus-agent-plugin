# Janus Agent Plugin — 参考设计

- 状态：现行
- 范围：本插件发布的 agent 家族、提示词组装、路由、权限与验证。

## 1. 定位

插件由三个团队组成，共发布 15 个 agent：6 个用户可选主入口（`janus`、`simple`、`consultant`、`architect`、`tech-lead`、`author`）与 9 个子 agent（`common-explorer`、`consultant-analyst`、`consultant-critic`、`consultant-auditor`、`solution-reviewer`、`coder`、`coder-reviewer`、`author-writer`、`author-reviewer`）。其中 13 个是可派发角色；只有 `janus` 与 `architect` 不可派发。

- `janus` —— 默认前台，不可派发。处理一般问题、轻量任务与路由。
- `simple` —— 经济型快答叶节点。处理低风险事实、概念与简单操作方法。
- `consultant` —— 咨询团队主入口。负责五种证据模式（`select`、`verify`、`roadmap`、`research`、`guide`）与咨询子 agent；设计移交 `architect`，文档移交 `author`，仓库工作派发 `tech-lead`。
- `architect` —— 研发团队设计主入口，不可派发。负责系统设计与 `design.md` 记录；派发 `common-explorer`、`solution-reviewer`（`design_premortem`）、`consultant-analyst`、`consultant-auditor`、`simple`，以及 `tech-lead`（实施已接受的 `design.md`）与 `author`（实质性架构/设计文档）。
- `tech-lead` —— 研发团队薄控制器，可派发。读已接受的 `design.md` 或原始需求、写 `plan.md`，获批后把里程碑逐个派发到隔离的 `coder` 与审查会话；自己不写业务代码。派发 `coder`（双档）、`coder-reviewer`、`solution-reviewer`，以及 `author`（实质性文档）。
- `coder` —— 双档执行叶节点（模式 `subagent`，步数 80）。`tier: "standard"`（Senior 档）执行 L3 高风险核心逻辑及其红绿测试；`tier: "fast"`（Junior 档）执行 L1/L2 完全指定的模块、CRUD/schema/胶水代码、按场景清单写单测与一次性可执行探针。由派发方选档，停下上报是合法的部分结果。
- `author` —— 文档团队主入口。负责接单、大纲审批门、作者简报、验证与发布；派发 `author-writer`、`author-reviewer`、`common-explorer`、`coder`（L0 临时验证）、`consultant-critic` 与 `simple`。顶层主入口可经 `janus_dispatch` 的 `role="author"` 派发它；已处于被派发会话中的 agent 不能再派发 `consultant`、`tech-lead` 或 `author`（DAG 守卫：有向无环图，即防循环调用规则）。

`janus` 把快答路由给 `simple`、证据类工作给 `consultant`、仓库工作给 `tech-lead`、实质性文档给 `author`；设计请求交给用户自选的 `architect` 主入口，它不是派发目标。

## 2. 角色地图

| 角色 | 层级 | 模式 | 负责 | 不负责 |
|---|---|---|---|---|
| `janus` | 入口 | all | 一般问题、轻量任务、路由 | 深度证据、设计、实质性文档、重编码 |
| `simple` | 入口 | all | 快速事实、概念、简单操作方法 | 多源证据、设计、编码、复杂规划 |
| `consultant` | 入口 | primary | 证据分级、决策、研究、个人路线图、攻略；咨询子 agent | 设计、文档、编码、读者可见正文 |
| `architect` | 入口 | primary | 系统/模块/接口设计、`design.md` 记录、单向门设计事前验尸（派发 `solution-reviewer`） | 实现、证据分级、文档正文 |
| `tech-lead` | 入口 | all | 薄控制器：读 `design.md`、写 `plan.md`、按里程碑派发隔离子会话；PRE/POST 树快照、`.review-mK.patch`、账本、3 轮熔断；代码注释、`AGENTS.md` 与 ≤2 处编辑的代码耦合文档同步的调度 | 亲写业务代码（全部派发 `coder`）；咨询选型、来源分级、设计记录、实质性文档正文 |
| `author` | 入口 | primary | 文档模式接单、大纲审批、作者简报、验证、发布；可由顶层主入口派发（DAG 守卫） | 读者可见正文的执笔（author-writer 负责）、代码实现 |
| `common-explorer` | 检索 | subagent | 来源收集、代码库勘察、元数据、初评级 | 解读、最终建议 |
| `consultant-analyst` | 检索 | subagent | 独立解读环节 | 收集、最终回答 |
| `consultant-critic` | 审查 | subagent | 反证、替代方案、结论与计划挑战 | 来源意图审计、最终回答 |
| `solution-reviewer` | 审查 | subagent | 单向门设计事前验尸（`design_premortem`）；`tech-lead` 的 Stage-1 计划评审（`stage: "plan"`）与 Stage-2 终评（`stage: "final"`） | 执笔、网络来源审计、最终回答 |
| `coder` | 编码 | subagent | 双档执行：standard=Senior L3（并发、幂等、重放、事务、鉴权、资金、数据删除/迁移、加密的核心逻辑与红绿测试）；fast=Junior L1-L2（完全指定的模块、单测、批量机械修改、一次性探针） | 派发其他 agent（叶节点）、未经控制器定规格的判断密集工作 |
| `coder-reviewer` | 审查 | subagent | 对照 `design.md` 与账本独立审查 `tech-lead` 每个里程碑的 `plan.md`/`.review-mK.patch`（`code_plan_review` + `reviews_job_ids`） | 网络来源审计、最终回答 |
| `consultant-auditor` | 审查 | subagent | 来源意图与独立性审计 | 事实核查、最终回答 |
| `author-writer` | 执笔 | subagent | 全部读者可见正文：蓝图、草稿、维护、一致性检查；在 `writer_docs_roots` 下写已批准的文档文件（scoped 模式），或在只读模式下返回正文/补丁（`writer_docs_roots: []`，或已批准路径在根之外，如 `README.md`、`docs/**`） | 源码、配置、构建与 `AGENTS.md`；证据收集、大纲审批、简报、记忆、发布（author 负责）；宽泛研究 |
| `author-reviewer` | 审稿 | subagent | `architecture`/`targeted`/`strict` 成稿后的独立审稿：事实与来源台账、简报对齐、阅读友好度；返回 `AuthorReviewerReport` | 执笔与修正（author-writer 负责）、代码实现、网络检索 |

## 3. 路由

```text
janus       -> consultant / tech-lead / author / simple   （设计请求 -> 用户切换到 architect）
consultant  -> common-explorer / consultant-analyst / consultant-critic / consultant-auditor / simple / tech-lead
architect   -> common-explorer / solution-reviewer / consultant-analyst / consultant-auditor / simple / tech-lead / author
tech-lead   -> coder (fast|standard) / coder-reviewer / solution-reviewer / author
author      -> author-writer / author-reviewer / common-explorer / coder / consultant-critic / simple
simple      -> 无（叶节点）
所有子 agent -> 无（叶节点）
```

`consultant` 从不派发设计或文档工作；这些移交给 `architect` 或 `author`，仓库工作派发 `tech-lead`。`tech-lead` 从不派发 `consultant`；证据流向咨询团队，代码留在研发团队。`architect` 是不可派发的主入口——`janus` 指引用户切换过去而不是派发它。`consultant`、`tech-lead`、`author` 三个主协调角色受调用方 DAG 守卫保护：已被派发的会话再派发它们会被直接拒绝。`author` 可派发：顶层主入口（`janus`、`architect`、`tech-lead`）通过 `janus_dispatch` 的 `role="author"` 交付实质性文档。委派阈值：实质性文档（教程、架构分析、设计说明及其他需要大纲与验证的持久文档）交给 `author`；代码注释、`AGENTS.md`，以及随代码改动完成、不超过两处编辑的文档同步，留在 `tech-lead`（或就地完成）。只读的文档问答路由给 `simple`。

## 4. 研发执行流程权重

`tech-lead` 选择能胜任的最轻流程，并在开工前用一行宣布；每个里程碑派发到隔离子会话，权重决定 `coder` 的档位与审查席。

| 权重 | 触发条件 | 执行与审查 |
|---|---|---|
| L0 直接改 | 一行修复、错别字、重命名、格式化/lint、配置值、套用现有模式；diff 一句话能说清 | `coder` `tier: "fast"` 直接执行；一次性无持久变更的探针单独派 `coder`（无补丁可审）；带持久变更的 L0 仍派 `coder-reviewer` `tier: "fast"` 携 `reviews_job_ids`——没有自我审查捷径 |
| L1 简要计划 | 一两个文件；需求明确；有现成模式可套；可复现的 bug | 里程碑进 `plan.md`（3-5 条计划、行为变更先写失败测试）；`coder` `tier: "fast"` 执行，`coder-reviewer` `tier: "fast"` 审 `.review-mK.patch` |
| L2 设计 + 计划 | 多文件/多模块；API/schema/迁移；陌生代码；不止一种合理设计 | 无记录时先走完整设计门（目标/背景/约束/完成判据 + 2-3 个选项 + 建议 + 文件 + 风险 + 验证）；已有被接受的 `design.md` 时收缩为记录未覆盖的实现细节 + 精确文件清单；实施前 `solution-reviewer` Stage-1 评审（`code_plan_review` + `stage: "plan"`，仅对照 `tech-lead` 模型校验）；获批后按里程碑派发 `coder` `tier: "fast"`，每里程碑 `coder-reviewer` 审补丁 |
| L3 质量门 | 并发、幂等、重放、事务、分布式故障、数据库迁移/约束、鉴权、资金/计费、数据删除、生产配置、加密/密钥；不可逆或高爆炸半径 | `coder` `tier: "standard"`（Senior 档）执行核心逻辑与红绿测试；`coder-reviewer` `tier: "standard"` 审补丁（`.review-mK.patch` 超 120 KB 时审查席升 standard 或先拆分里程碑，绝不截断补丁）；全部里程碑通过后 `solution-reviewer` Stage-2 终评（`stage: "final"` + `reviews_job_ids` 覆盖全部 coder 根 job） |

新信息出现时权重只上调，绝不因任务耗时变长而悄悄下调。技能按权重选择：L0 不用技能；L1 按需用 TDD/系统化调试/完成前验证；L2 增加头脑风暴/写计划；L3 加完整质量门。

一道通用的文件变更门位于上表之上：任何持久文件变更（创建、编辑、删除；临时/草稿文件豁免）之前，执行方列出精确路径与一行理由并等待确认。用户侧会话由 `tech-lead` 持有该门（直接服务用户时以 3-6 行状态块收尾多步回复）；派发模式下，派发提示中的 `Confirmed paths` 即视为已过确认门，`coder` 叶只在路径未确认时返回拟改清单并停下。`coder` 被派发有界任务时不向最终用户提问；路径确认后它做合理假设、用最轻流程，返回 diff、实际验证输出与残留风险，停下上报是合法的部分结果。

## 5. 提示词组装

每个插件自有 agent 的提示词按以下顺序静态组装：

1. **角色 asset** —— `assets/agents/<agent>.md`：身份、职责范围、流程、交互、失败行为。
2. **共享原则片段** —— `assets/principles/` 下按角色分配：`research-leaf.md` 给七个只读叶节点（`common-explorer`、`consultant-analyst`、`consultant-critic`、`consultant-auditor`、`solution-reviewer`、`coder-reviewer`、`author-reviewer`）；`reasoning-failures.md` 给 `consultant-analyst` 与 `consultant-critic`（在 `research-leaf.md` 之后）；`claim-types.md` 给 `consultant-analyst`；`source-criteria.md` 给 `common-explorer` 与 `consultant-critic`；`channel-policy.md` 给 `consultant` 与 `author`；`mode-routing.md` 给 `janus` 与 `consultant`（在 `dispatch-hub.md` 之后）；`dispatch-hub.md` 给五个派发枢纽（`janus`、`consultant`、`tech-lead`、`architect`、`author`）；`engineering-principles.md` 给 `architect`、`tech-lead`、`coder`、`coder-reviewer`、`solution-reviewer`；`user-facing-style.md` 给八个面向人的角色（`janus`、`simple`、`consultant`、`tech-lead`、`architect`、`author`、`author-writer`、`author-reviewer`），七个结构性叶节点不注入。
3. **公共基线** —— `assets/principles/common-base.md`：认识论诚实、不可信输入与机密、范围/冲突规则，注入每个角色。
4. **公共写入门** —— `assets/principles/common-write.md`：持久文件变更确认门、其派发模式规则、变更后文件清单。七个只读叶节点省略此层。
5. **运行时绑定** —— 注入角色 asset 的 `RUNTIME-BINDINGS` 占位符：该 agent 的模型、派发目标、job 工具纪律、记忆可用性、上限、命名空间，以及相关的 author/design/handoff 状态目录绑定。

**模型适配块**不属于静态组装，而是每轮由 `experimental.chat.system.transform` 钩子（`createSystemTransformHook`）按实际服务当轮的模型注入：`assets/model-prompts/<normalized-model-key>.md`，按模型而非角色索引，且与提供商无关；没有对应块的模型不注入。

角色 asset 与模型无关且不含共享片段；模型特有内容绝不写进角色 asset，角色规则绝不写进模型块。角色特有的例外与增量留在角色 asset。

对每个入口，角色 asset 是常驻契约与安全网；核心咨询 skill 承载共享流程，`architect` 按需载入 `consultation-design`、`author` 载入 `consultation-doc` 获取重型手册。skill 是生成的：编辑 `skill-src/**` 后运行 `bun run gen:skill`（已接入构建）；绝不手改 `assets/skills/*/SKILL.md`。`script/gen-skill.test.ts` 会在任何生成文件过期时报错。`script/prompt-lint.test.ts` 强制各层字数预算与跨文件重复句纪律，`script/skill-consistency.test.ts` 保持 schema、提示词、skill 与 eval 的 `modes` 元数据一致。

每个组装后的角色提示词在 `packages/opencode-adapter/src/prompt-snapshots/` 下有经评审的金样快照。提示词有意变更后，先评审 diff，再用 `UPDATE_PROMPTS=1 bun test packages/opencode-adapter/src/prompt-snapshots.test.ts` 刷新。

## 6. 配置与模型

默认模型：

| 角色 | 默认模型 |
|---|---|
| `janus` | `opencode-go/glm-5.3-flash` |
| `consultant` | `opencode-go/gemini-4-argon` |
| `architect` | `opencode-go/gemini-4-argon` |
| `tech-lead` | `opencode-go/glm-5.3` |
| `coder` | `opencode-go/glm-5.3` |
| `solution-reviewer` | `opencode/claude-sonnet-5-5` |
| `author` | `opencode-go/gemini-4-argon` |
| `simple` | `opencode-go/deepseek-v4.1-flash` |
| `common-explorer` | `opencode-go/deepseek-v4.1-flash` |
| `consultant-analyst` | `opencode-go/kimi-k3.1-pro` |
| `consultant-critic` | `opencode/claude-sonnet-5-5` |
| `coder-reviewer` | `opencode-go/kimi-k3.1-pro` |
| `consultant-auditor` | `opencode-go/grok-4.7` |
| `author-writer` | `opencode/claude-sonnet-5-5` |
| `author-reviewer` | `opencode-go/kimi-k3.1-pro` |

出厂档位默认：fast 档两个 `fast.coder = opencode-go/glm-5.3-flash`（Junior 执行档）与 `fast.coder-reviewer = opencode-go/claude-haiku-5-5`（补丁审查档），二者同在 Go Plus 池；`standard.coder = opencode-go/deepseek-v4.1-flash`（Senior L3 执行档）；deep 档无档位默认，落回上表的角色标量默认（Senior `glm-5.3` coder 线）。

每个角色解析到单一已配置模型，没有插件回退链。用户可在 `~/.config/janus-agent/config.jsonc` 用 `<role>_model` 覆盖任意角色，或用 `mode_models`/`tier_models` 按模式/档位路由。按模型的适配块由 system transform 钩子按实际服务当轮的模型注入。author-writer 的可写文档根由 `writer_docs_roots` 配置（默认 `["userdoc"]`，允许 `docs/guides` 这类项目相对路径；空数组选择全局只读）。已批准路径在根之内时 author-writer 直接写盘；路径在根之外（如 `README.md`、`docs/**`）或根为空时，它以只读模式返回正文/补丁，由 `author` 先应用到磁盘，再派发 `author-reviewer` 审计已落盘的文件。author-writer 绝不写源码、配置、构建文件或 `AGENTS.md`。

预期的跨家族审计组合是 consultant/architect/author（Google）≠ consultant-analyst/coder-reviewer/author-reviewer（Moonshot）≠ consultant-critic/author-writer（Anthropic）≠ consultant-auditor（xAI）。若用户把这些角色覆盖到同一家模型，审计的独立性随之下降；插件不强制模型多样性。

## 7. 权限与派发

- `janus` 是完整执行席位，拥有宿主默认权限，外加下述共享 handoff 目录。
- `tech-lead` 是薄控制器：`edit` 为 `{"*": "deny"}` 打头，加 design 与 handoff 两个状态目录的 `allow`，每个 allow 由 `editAllowTwins` 携带孪生集——宿主 edit 权限按 `path.relative(worktree, file)` 相对路径求值（转义正则元字符后 `*`→`.*`、`?`→`.`、锚定全串，最后匹配的规则获胜），workspace 之外的状态目录必须补上按项目基目录（directory 与 worktree 各取 resolve 与 realpath 变体）计算的相对孪生（及绝对、去斜杠、realpath 交叉形态）才能免确认命中；目标等于或为基目录祖先时跳过相对孪生，保持拒绝兜底（写 `plan.md`、更新账本与交接文档），bash 全放（`{"*": "allow"}`，快照与补丁构建等控制器法定动作）、`external_directory` 含两目录与共享临时目录四条作用域。它是唯一持有派发 coder 车道的角色；自己不写业务代码。
- `coder` 是双档执行叶：`edit` 为 `{"*": "allow", "../*": "ask", "/*": "ask"}` 加四条共享临时目录作用域的 `editAllowTwins` 孪生 `allow`（工作区内路径由 `"*"` 免确认命中；`../*` 拦住按 `path.relative(worktree, file)` 相对提交的工作区外路径、`/*` 兜住绝对形式提交，二者都先询问；tmp 孪生 `allow` 排在最后，特许草稿写入不被打断），bash 为 `{"*": "allow"}` 加 `CODER_BASH_DENY_RULES`（27 条 git/svn/hg 写与还原、`rm -rf`、`sudo`、`janus-keys` CLI 拒绝；只拒清单内命令，防误操作的 Speed Bump 而非沙箱），`external_directory` 仅四条共享临时目录作用域（`${os.tmpdir()}/opencode/**` 及其 realpath 变体、`/tmp/opencode/**`、`/private/tmp/opencode/**`），加 `task: "deny"` 与叶节点派发拒绝；模式 `subagent`、步数上限 80、注册时整项替换既有同名条目（防旧的无守卫主入口配置还原）。
- `architect` 是设计主席位，拥有设计状态目录的 `external_directory` 权限；`author` 是文档主席位，拥有 author 与 design 两个状态目录的权限；`solution-reviewer` 与 `coder-reviewer` 拥有 design 状态目录的只读 `external_directory` 权限；`author-reviewer` 拥有 author 与 design 两个状态目录的只读 `external_directory` 权限。`consultant` 唯一的业务态目录是共享 handoff 目录；它既不持有作者简报也不持有设计记录，不写正文、不写生产代码。
- 五个主入口（`janus`、`consultant`、`architect`、`tech-lead`、`author`）共享跨团队 handoff 状态目录的 `external_directory` 读写权限（见 7.3）；所有叶节点子 agent 一律拒绝。

所有派发角色使用同一套可恢复生命周期：`janus_dispatch`（可选 `return_handle: true`、`mode`、`tier`、`protocol`、`reviews_job_ids`、`stage`）、`janus_dispatch_wait`、`janus_dispatch_cancel`、`janus_dispatch_continue`。pending/unknown 不是失败；对同一个 job 继续等待。没有自动回退模型。审查席守卫（`dispatch-guard.ts`）在创建会话前强制：派 `coder-reviewer` 必携 `reviews_job_ids`；`solution-reviewer` + `code_plan_review` 必携 `stage`——`stage: "plan"` 仅校验审查席与 `tech-lead` 模型的独立性且禁带 ids，`stage: "final"` 必携 ids 并对照 `tech-lead` 与全部列出的 coder job 校验；`design_premortem` 对照 `architect` 模型校验；同模型或同模型家族即拒绝。守卫还执行档位下限：job spec 按角色范围（`coder`/`coder-reviewer`/`solution-reviewer`）持久化派发时的 `tier`，显式 `tier: "fast"` 派 `coder-reviewer` 而 `reviews_job_ids` 列出的 coder job 含 standard/deep 档即被拒（下限取所列 job 的最高档位）；无 `tier` 参数派发的 coder job 落盘没有 tier 字段、与历史记录不可区分，下限规则对其不生效（由 `tech-lead` 规程约束 coder 派发必带档位补齐），不带 `tier` 的默认席派发与旧 job spec 同样不受此限。调用方上下文 ≥250k token 时返回值带 `[context-watermark: …]` 检查点标记（JSON 信封走 `context_watermark` 字段）；≥350k 且目标为 `coder` 时派发被硬顶拒绝并附恢复指引。

`janus_dispatch_continue({session_id, prompt, role?})` 是通用的会话复用机制，与角色无关，任何派发方都能使用：它向既有派发会话发送新提示，让后续轮次复用专家已积累的上下文（`author` 用它在一篇文档的多轮反馈中复用 author-writer 会话；consultant-analyst、coder 等会话以同样方式复用）。续接会创建一个新的 job 根，其持久 spec 记录被复用的 `session_id` 与 `continued_from`；第 0 次尝试提示被复用的目标，重试仍照常创建新的尝试子节点。复用有严格边界：同一调用方、同一规范化工作区、带派发标记的目标会话（普通 job 根或其尝试子节点——绝不是续接 job 根）、且目标空闲；只有终态 job 可以被续接。续接继承原 job spec 的 `agent_name` 与 `model_chain`，绝不切换模型。角色家族、权限与配置的其余部分不变——没有注册表，没有跨会话复用。

### 7.1 Author 状态与简报

文档模式的状态是每篇文档一个文件：简报位于 `$XDG_DATA_HOME/janus-agent/author/<projectId>/<docId>/brief.md`（固定路径；`projectId` 是项目目录名规范化后加绝对路径短哈希得到的稳定 ID）。`author` 创建并更新简报；`author-writer` 只读、绝不写。简报还存储 `writer_session_id`——从第一次 author-writer 派发（`return_handle: true`）捕获的可复用 author-writer 会话，它可能发生在批准前的蓝图阶段，因此 `author` 会先在工作上下文中保留该 ID，直到大纲审批门创建简报时写入；此后该文档的有界修改都通过 `janus_dispatch_continue` 复用同一会话——一篇文档一个会话，不跨文档复用；会话丢失、属他或忙时，回退为携带完整简报的全新派发并更新存储的 ID。简报绝不放在 `userdoc/` 或已发布文档树中。限定写入模式下 `author` 不编辑写手根目录下的文件——它审查 author-writer 的 diff 并请求有界修正；只读模式（`writer_docs_roots: []`，或已批准路径在根之外）下 `author` 应用返回的正文并披露该模式，应用后的文件再交 `author-reviewer` 审计（若该文档适用审稿门）。

### 7.2 Design 状态与记录

设计决策存放在项目树之外：`$XDG_DATA_HOME/janus-agent/design/<projectId>/<designId>/design.md`（无设计记录的计划位于 `.../<planId>/plan.md`）。`architect` 写入并维护 `design.md` 的决策内容；tech-lead 对 `design.md` 100% 只读、在同目录写自己的 `plan.md`，绝不编辑记录的任何一行——记录不携带生命周期或状态行，完成历史由 git 与实施报告承载。`architect` 与 `tech-lead` 拥有 `<designStateDir>/**` 的预授权 `external_directory` 权限，运行时绑定用与作者简报相同的稳定项目 ID 标注设计基目录 `<designStateDir>/<projectId>`。`design.md` 是现态文档：`architect` 原地重写、维持在约 200-300 行，删除前需征得同意。`plan.md` 是临时文件：工作落地（全部里程碑验证、审查消解、终报交付）之后删除它是唯一无需确认的持久文件删除。

### 7.3 Handoff 状态与跨团队交接文档

跨团队交接存放在项目树之外：`$XDG_DATA_HOME/janus-agent/handoff/<projectId>/<handoffId>/handoff.md`——每个课题一份无状态 Markdown 文档，仅在回合末尾、当 agent 或用户显式发起交接（或要求保存检查点）时创建或更新；接管 100% 纯只读。文档结构是 YAML frontmatter（`handoff_id`、`title`、`updated_at`、`last_hop`）加两个固定分区：`## 1. 背景与当前定论`（≤ 80 行——`### 核心背景与已拍板结论` 的 `[C<n>]` 蒸馏结论、`### 待继续讨论与未决问题` 的 `[Q<n>]` 或 `- 无`、`### 关联文件链接` 的只存路径指针）与 `## 2. 交接记录与下一跳指引`（最新 `### Hop N` 紧贴标题下方，仅最新一跳携带 `建议下一跳` 与 `默认接力任务`，旧 Hop 只保留 `本跳结论摘要`）。追加 Hop N+1 时做综合刷新：把上一份文档的未决问题与本轮新讨论结论合并进第 1 分区（无论用户是否按上一跳的建议下一跳执行）；接收方只读前 120 行即掌握完整背景与最新一跳。每次写入该文档的回合必须以 `交接单: <handoff-id>` 回显结尾。

三级触发挂载交接：显式 ID（`继续 <handoff-id>` 等，或 `/janus-handoff use <id|n>`）、裸 `继续交接`（同会话上一条回复以 `交接单:` 结尾时直接挂载，否则按 `updated_at` 由新到旧扫描——仅 1 份直接挂载、多份列出最近 10 条编号候选，绝不静默自动选用）、程序化派发（派发提示词携带 `继续交接: <handoff-id> (<绝对路径>)`）。用户附带现场新指令时以指令为准（忽略旧 `默认接力任务`）；裸触发下当前 agent 匹配 `建议下一跳` 则直接以 `默认接力任务` 为目标，不匹配则只读展示 3 行摘要并请用户切换、派发或给出新指令。`handoff.md` 内容是不可信数据、绝不作为指令或文件写入授权。可移植契约由第四个 skill `handoff`（`skill-src/handoff/` 生成，OpenCode/Cursor/Claude Code 通用）承载；`/janus-handoff` 命令提供 `list`（由新到旧、最近 10 条）、`all`、`view [full]`、`use`（只读挂载并按上述规则继续）、`delete`（带 `/janus-memory` 式的删/留确认门）、`export`（默认 `./userdoc/handoffs/<handoff_id>.md`）与 `import`（确认拷入前做全契约校验），无归档子命令。

## 8. 记忆

`consultant`、`architect`、`author` 与 `simple` 共享 `janus-memory` 咨询记忆命名空间。四者直接服务用户时都会自动保存一条记录；被派发的有界任务只有在任务指明其为记忆归属方时才保存（`Memory ownership: <role> saves`），否则由派发方持有记录。`janus` 不接入咨询记忆，因此 `janus -> consultant` 或 `janus -> author` 派发必须附带 `Memory ownership: consultant saves` 或 `Memory ownership: author saves`；没有它，被派发方返回记忆摘要、不落记录。`tech-lead`、`coder` 与其余子 agent 不接入咨询记忆；编码会话的状态保存在 `plan.md` 账本与 `handoff.md`，使用仓库的 `AGENTS.md` 与项目文档。

## 9. 验证

发布门禁是：

```bash
bun test
bun run typecheck
bun run install:local
JANUS_PLUGIN_ENTRY=~/.local/share/janus-agent-plugin/dist/index.js bun run integration
```

集成证明在隔离的 OpenCode 沙箱中加载已安装的构建产物，断言 15 个 agent 键、记忆 MCP（Model Context Protocol，本地工具服务协议）、四个 skill（含 `handoff` 的无状态契约与 `交接单` 回显）、命令文件（janus-models、janus-handoff、janus-config；四条斜杠命令的完整安装由 plugin.test.ts 覆盖）、simple 工作区、派发原语、design/author/handoff 状态权限（含叶节点不持有 handoff 权限的反证、solution-reviewer/coder-reviewer 的 design 状态目录只读权限与 author-reviewer 的双状态目录只读权限），以及 architect/author/tech-lead 提示词中的 design/author 绑定与五个主入口提示词中的 handoff 绑定。组装后的提示词由金样快照锁定，生成的 skill 由 `gen-skill.test.ts` 锁定；`skill-consistency.test.ts` 检查七模式 schema 与提示词、skill、eval 的 `modes` 元数据一致。模型评分的行为（路由、自适应过程、派发模式纪律、设计门）由 `evals/fixtures/consultation-cases.json` 覆盖，需要真实模型评审。
