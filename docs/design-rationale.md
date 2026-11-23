# Janus Agent Plugin 设计依据

本文记录那些非显而易见的机制、规则与流程**为什么存在**。每条依据是一句话：为满足需求 X，在约束 Y 下，采用现行方案 Z，接受代价 W；当条件 C 出现时重审。在可能被重新提出的地方附一条与时间无关的备选方案。

- 机制的拓扑、依赖方向、全局不变式与入口文件：[architecture.md](architecture.md)
- 安装、配置字段与运维：[deployment.md](deployment.md)
- 想删除、改写或绕开下列机制之前，先读对应条目的代价与重审条件。

## 1. 核心机制与规则依据

### 1) 自包含打包产物与零外部运行时依赖部署

为满足外部用户仅凭构建产物即可复现安装、无需保留源码检出、`node_modules` 或 Bun 模块缓存，
在 OpenCode 以本地 `file://` 加载插件、并在独立子进程拉起记忆 MCP 服务器的约束下，
采用 `script/build.ts` 不标记任何 external、将适配器与记忆 MCP 分别打包为自包含的 `dist/index.js` 与同目录 `dist/memory-mcp-server.js`，由 `bun run install:local` 统一装入 `~/.local/share/janus-agent-plugin` 并校验必需文件清单，
接受每次改动源码都必须重新运行 `bun run install:local` 并重启 OpenCode 才能在真实宿主生效、且打包体积包含全部运行时依赖；
当 OpenCode 原生提供带依赖锁定与自动安装的分发包管理器时重审。

备选方案：让 `opencode.json` 直指仓库 `packages/opencode-adapter/src/index.ts`，或在 `dist/` 旁保留 `node_modules`——因外部用户环境没有源码检出、跨目录依赖在升级或清理缓存时极易断裂而未采用；源码模式只在本仓库自己的单测与集成测试中允许。

### 2) 可恢复派发生命周期与有界会话续接

为满足长耗时专家推理（单轮可达数分钟）或宿主观察窗口超时、中断时不丢失后台进度、不产生幽灵重复任务，并支持多轮上下文复用，
在宿主工具调用受单次观察窗口限制、且网络或传输抖动可能使状态暂时无法判定的约束下，
采用每个角色只做一次已配置模型的尝试（无插件回退链）、`janus_dispatch` 以 1800000 毫秒软观察窗口观察，超时或状态不明时返回 `pending`/`unknown` 信封并保留同一 `job_id` 供 `janus_dispatch_wait` 恢复，辅以严格限制在「同一调用方、同一规范化工作区、带派发标记的普通 job 根或尝试子节点、目标空闲、前序 job 已终态且不切换模型」之内的 `janus_dispatch_continue`，
接受调用方必须显式处理非终态信封并等待原任务完成、不能静默用内联工作替代，且模型不可用时直接报错而不自动降级到次选模型；
当宿主提供原生的跨会话持久化任务队列与幂等去重原语时重审。

备选方案：超时后自动重试，或配置多模型回退链——因自动重派会让仍在后台运行的专家会话双倍消耗 token，静默降级模型又会掩盖审查席独立性或能力的下降而未采用；仅当宿主能原子中止远端推理、且用户显式声明接受降级时重审。

### 3) 主入口不可派发与调用方有向无环图（DAG）守卫

为满足三个团队职责边界清晰、并防止子会话互相递归委托造成无限调用环与上下文爆炸，
在 `consultant`、`tech-lead`、`author` 既要作为用户主入口、又要在顶层协调中相互移交或受托执行有界任务的约束下，
采用把 `janus` 与 `architect` 设为不可派发的主入口（`DISPATCH_ROLES` 仅含 13 个角色），并在 `dispatch-tool.ts` 强制调用方 DAG 守卫——任何自身处于被派发子会话中的角色一旦派发 `consultant`、`tech-lead` 或 `author`，在创建 job 之前即被拒绝，并要求把跨团队诉求退回顶层调用方，
接受被派发的子会话发现跨团队需求（如 `tech-lead` 子会话需要深度咨询、`consultant` 子会话需要写持久文档）时无法就地横向派发，必须先返回顶层主入口，由顶层路由；
当引入带全局深度计数与预算配额的运行时图调度器时重审。

### 4) 审查席强制守卫与审稿报告软校验

为满足设计事前验尸、代码里程碑与终评、文档分阶段审稿都具备真实的跨模型独立性（防虚假或同源审查），同时不因审稿模型输出格式的轻微抖动丢弃整轮长文审稿成果，
在用户可自由覆盖各角色的模型与档位、且大语言模型生成结构化 JSON 报告偶有格式瑕疵的约束下，
采用在 `dispatch-guard.ts` 创建会话前强制校验 `reviews_job_ids`、`stage`、审查方与被审方的跨模型家族（按规范化前缀映射，未知前缀自成家族、不折叠）以及档位下限（显式 `fast` 不得审更高档位的产出，`reader` 冷读阶段豁免），并在返回边界由 `dispatch-review-report.ts` 对 `author-reviewer` 做 `AuthorReviewerReportSchema` 软校验（缺失合规报告时追加 `author-reviewer report: unresolved` 标记，而不抛错阻断文本返回），
接受 `stage` 与 `reviews_job_ids` 的完整性依赖调用方如实声明、由 `plan.md` 账本与 `brief.md` 审阅记录兜底，不带 `tier` 参数的派发不受档位下限约束，且配置加载阶段不预检跨家族模型、咨询团队席位（如 `consultant-analyst`）也不设硬守卫——未配置跨家族提供商的用户在触发受守卫的审查/审稿席派发时会被拒，须先调整模型配置；
当所有受支持的宿主与提供商都原生支持跨模型的 schema 强制输出且零格式失败时重审。

### 5) 研发薄控制器、双档 `coder`、350k 硬顶与 `plan.md` 检查点中继

为满足多里程碑研发任务在主控上下文受限的情况下仍能保持代码隔离、逐里程碑异体审查与跨会话无损续跑，
在 OpenCode 宿主按 `path.relative(worktree, file)` 求值 `edit` 权限、控制器没有独立的运行时状态机、长周期编码极易撑爆单会话上下文的约束下，
采用让 `tech-lead` 通过 `editAllowTwins` 获得写 `plan.md` 的权限（`resolveEditBases` 取项目 `directory` 与宿主 `worktree`——缺省回落到 `directory`——各自的 resolve 与 realpath 形态作为基目录，`editAllowTwins` 据此为设计状态目录补上相对孪生规则，因为状态目录在工作区之外、单条绝对路径规则匹配不上）且永不亲写业务代码，将编码按 `L0`–`L3` 权重派发给带 `CODER_BASH_DENY_RULES`（27 条 VCS 写、还原与破坏性命令的防误操作护栏）的双档 `coder` 叶节点，在调用方上下文 ≥250k 时附加软水位标记、≥350k 且目标为 `coder` 时硬顶拒绝，并由 `janus` 或 `architect` 凭 `plan.md` 账本门（`checkpoint: continue`、进度对按字典序严格递增、首轮 `M_1` 前至多一次 `(0, 0)` 特例）把 `tech-lead` 中继到全新会话，
接受 3 轮修复熔断仅由提示词与 `plan.md` 账本约束而没有运行时计数器；`CODER_BASH_DENY_RULES` 是防误操作的护栏而不是安全沙箱，拦不住子 shell 或脚本重定向，只能靠 `tech-lead` 的 PRE/POST 树快照对账兜底；`tech-lead` 对 `design.md` 的只读由提示词约束，因为它的权限放行整个设计状态目录；350k 硬顶按目标 `coder` 一刀切（`author` 在 ≥350k 时为临时验证派 `coder` 也会被同一规则拒绝，`janus_dispatch_continue` 则不受该硬顶限制）；
当宿主提供进程级文件系统沙箱与原生会话检查点分叉（fork 或 compact）原语时重审。

### 6) 文档三方分离、`writer_docs_roots` 与 `D0`–`D3` 分级

为满足防止主编角色自写自审造成事实失真，并保护项目源码、配置与维护文件不被文档执笔会话意外篡改，
在持久文档既可能是 `userdoc/` 下的用户交付物、也可能是位于 `writer_docs_roots` 可写根之外、需严格管控的 `README.md` 或 `docs/*.md` 的约束下，
采用把文档团队拆为 `author`（接单、证据、大纲门、简报、发布，不执笔写正文；`read-only` 模式下只把写手返回的正文原样落盘）、`author-writer`（唯一执笔者，`edit` 权限只放行 `writer_docs_roots`，可写根之外的文件走 `writeMode: "read-only"` 返回正文，由 `author` 原样先落盘）与 `author-reviewer`（只读跨家族审稿，按 `D0`–`D3` 跑 `outline`/`unit`/`reader`/`final` 阶段，可写根之外的文件必须落盘后对磁盘实文件审稿；`D0` 的 ≤2 处纯机械微改走 `briefWaived: true`，免简报免审稿），
接受 `writer_docs_roots` 可写根之外的文档（如 `README.md`、`docs/**`）必须经过「写手只读返回、主编落盘、审稿人审磁盘文件」的多步往返，增加了单次文档修订的交互轮次与延迟；
当宿主支持按单次派发动态签发临时的文件级写令牌（capability token）时重审。

### 7) 静态提示词分层组装、金样快照锁定与按模型动态注入适配块

为满足把「角色职责契约」与「底层模型驾驶特性」彻底解耦，换模型或按模式、档位切模时驾驶指令自动跟随，并杜绝共享原则在 15 个角色之间复制粘贴引发的静默漂移，
在不同大模型的工具调用、长上下文与停止条件上有截然不同的失败倾向、而插件允许经 `mode_models`、`tier_models`、`<role>_model` 在运行时切换任意角色模型的约束下，
采用注册时按「角色 asset → 按角色从 9 个共享原则片段中分配的子集 → `common-base.md` → `common-write.md` → 运行时绑定」静态组装提示词，由 `prompt-snapshots/` 金样与 `script/prompt-lint.test.ts` 锁死内容、字数预算与重复句，而把模型适配块（`assets/model-prompts/<key>.md`）交给 `experimental.chat.system.transform` 钩子在每轮请求时按去提供商前缀的规范化模型键动态追加，
接受任何共享原则或角色提示词的合法修改都必须同步评审并刷新金样快照，且静态金样不包含模型适配块、需靠 `system-transform.test.ts` 单独验证钩子注入；
当所有目标模型在统一的零适配提示词下推理与工具遵循度达到同质无偏水平时重审。

备选方案：按角色索引模型块，或在注册时把默认模型的适配块静态拼入角色提示词——因一旦经 `tier_models`、`mode_models` 或宿主 UI 切换模型，静态烘入的驾驶指令就会与实际服务当轮的模型错配而未采用；仅当插件取消运行时按档位或模式切模的能力时重审。

### 8) `skill-src` 生成器与退役生成物启动指纹修剪

为满足在单一事实源中维护跨模式共享的重型工作流手册，并在插件升级、重命名或退役 skill 与命令文件时自动清理旧生成物而不伤及用户自定义文件，
在 OpenCode 启动时直接扫描用户配置目录下的 `skills/` 与 `commands/`、残留的退役文件会污染模型上下文与斜杠命令列表的约束下，
采用以 `skill-src/**` 为唯一事实源、由 `script/gen-skill.ts` 生成 `assets/skills/*/SKILL.md`（由 `gen-skill.test.ts` 锁死、防止手改），并在启动同步时按内容指纹修剪不在现行名单内的退役文件——skill 校验 `script/gen-skill.ts` 生成头与 `janus-agent` 产品名指纹，`janus-*.md` 命令校验 `$XDG_DATA_HOME/janus-agent/` 数据根指纹；带 `<!-- user-modified -->` 标记的文件与外来文件一律保留，
接受维护者绝不能直接编辑 `assets/skills/*/SKILL.md`，且重命名数据根路径或生成头格式时必须考虑旧指纹的兼容识别；
当 OpenCode 宿主提供插件级命名空间隔离与受管资源生命周期钩子（卸载或升级清理钩子）时重审。

### 9) 权威经验包与可重建派生视图分离（含不可信输入与隐私边界）

为满足跨会话积累用户认可的决策经验与偏好，同时防止模型把过往自身输出当作独立外部证据（循环论证）、防止外部网页或历史记忆中的提示词注入篡改策略，并在更换摘要或 embedding（语义向量表征）模型时零损迁移，
在本地 SQLite 需支持多窗口并发读写、且分类树、摘要与向量索引高度依赖生成它们时的模型版本与维度的约束下，
采用在 `memory-core` 与 `memory-sqlite`（WAL 模式——预写日志并发读写、busy timeout、短事务）中只把用户批准的归纳式经验包、来源元数据、偏好与修订事件存为权威数据（不存完整对话，敏感字段默认不入库、须逐项确认，旧建议在五态生命周期中仅作反假设而非反证据，所有外部来源与召回的记忆一律视为不可信数据、绝不作为指令），而把分类、标签、摘要、embedding 与 FTS（全文检索）索引全部标注模型与 schema 版本、作为可随时安全删除重建的派生数据；`forget` 级联抹除权威与派生产物（仅留无内容的结构墓碑），`retire` 仅移出常规检索，
接受写入与检索需要维护权威表与派生表两套结构及延迟 enrichment（异步派生摘要与分类补全）状态，且语义召回在未配置兼容 embedding 端点时退化为分类加 FTS 的词法检索；
当本地内置零配置、跨版本向量空间恒定的标准嵌入引擎出现时重审。

备选方案：自动保存完整聊天记录，并把历史模型回答直接塞入向量库召回——因完整对话含大量未验证碎片与噪声，且把旧结论当证据会造成自我强化的幻觉闭环而未采用；不重审。

### 10) `tier_role_caps` 建议性上限而非运行时强制调度器

为满足按任务风险与档位（`fast`/`standard`/`deep`）约束咨询子 agent 的最大扇出规模，同时避免机械凑齐角色名册造成无谓的 token 与延迟开销，
在不同咨询问题对证据检索、独立解读、反证挑战与利益冲突审计的需求差异极大、静态规则无法预知哪一轮需要哪个专家的约束下，
采用将 `tier_role_caps`（仅含 `common_explorer`、`consultant_analyst`、`consultant_critic`、`coder_reviewer`、`consultant_auditor` 五个键：其中 `common_explorer`、`consultant_analyst`、`consultant_critic`、`consultant_auditor` 注入 `consultant` 的运行时绑定，`common_explorer`、`consultant_analyst`、`coder_reviewer`、`consultant_auditor` 注入 `architect` 的运行时绑定；文档席位由 `D0`–`D3` 规程独立控制）作为建议性上限，要求主控仅在能明确说出该专家可能改变哪个具体决策、抓住哪种具体失败时才按需派发，跳过时给出理由，不设按轮次强制排期的运行时调度器（上限为 0 表示该档位禁用该角色，须披露由此产生的实质缺口），
接受实际派发频次依赖主控模型的判断纪律而非代码硬计数器，极端情况下主控可能在上限内多派或少派；
当引入需要按账户配额对单次会话做硬性子任务计费截断的托管多租户环境时重审。

## 2. 外部平台与行业依据

下列资料各自支撑一处现行设计；本项目借鉴它们的思想，而不引入它们作为运行时依赖。

- [OpenCode 插件](https://opencode.ai/docs/plugins)：插件可注册工具、修改配置，并以本地插件模块发布；适配器据此以 `file://` 插件条目加载，并经 `config` 钩子注册 agent、工具、skill 与命令。
- [OpenCode 自定义 agent](https://github.com/anomalyco/opencode/blob/dev/packages/web/src/content/docs/agents.mdx)：primary 与 subagent 两种模式及权限规则；15 个 agent 的模式与逐角色权限由此表达。
- [MCP TypeScript SDK 服务器文档](https://github.com/modelcontextprotocol/typescript-sdk/blob/v1.29.0/docs/server.md)：本地客户端拉起的服务器宜用 stdio（标准输入/输出管道），并把传输与服务器能力分离；`memory-mcp` 据此保持为只做传输与路由的薄层。
- [XDG Base Directory 规范](https://specifications.freedesktop.org/basedir/latest/)：区分配置、持久数据、状态、缓存与运行时文件；记忆存储与各团队状态目录的路径三分据此划定。
- [SQLite 原子提交](https://sqlite.org/atomiccommit.html)：原子提交与崩溃恢复；每次保存都是幂等事务，迁移失败回滚并保持数据库不变。
- [SQLite WAL](https://www.sqlite.org/wal.html)：单写者与并发读者；多个 OpenCode 窗口的记忆服务器与 CLI 因此能同时使用同一个数据库。
- [Letta 上下文层级](https://docs.letta.com/guides/core-concepts/memory/context-hierarchy/)：分层上下文与渐进加载，而不是注入全部记忆；召回默认只取索引与当前决策，更深层级需显式展开。
- [Graphiti](https://github.com/getzep/graphiti/blob/main/README.md)：为派生事实保留事件溯源与时间有效性；修订事件、状态迁移与带时间、地域、适用性的断言据此设计。
- [LangMem 延迟处理](https://langchain-ai.github.io/langmem/guides/delayed_processing/)：区分即时与延迟的记忆形成；权威写入先完成，摘要与分类的 enrichment 可延后重试。
- [LangGraph store](https://docs.langchain.com/oss/python/langgraph/stores)：命名空间、元数据过滤与语义搜索承载长期记忆；记忆命名空间与过滤加可选 embedding 检索的组合据此设计。
- [Mem0](https://docs.mem0.ai/core-concepts/how-it-works)：抽取式、带作用域的记忆与显式记忆操作；归纳式经验包与 `memory_manage` 的显式操作据此设计。

架构借鉴的是思想，不是运行时依赖。当前版本仍是一个小型本地 TypeScript 插件，而不是把 Letta、LangGraph、Graphiti 或 Mem0 当作应用运行时。

## 3. Open Ideas

当前没有用户明确要求记录、且尚未落地的开放想法。
