# Janus Agent Plugin 设计依据

本文只记录从代码与架构文档读不出来的东西：关键决策接受的代价、与时间无关
的备选方案、何时重审，以及外部思想渊源。机制的拓扑、依赖方向与全局不变式
见 [architecture.md](architecture.md)；安装与配置见 [deployment.md](deployment.md)。
想删除、改写或绕开下列机制之前，先读对应条目。

## 1. 关键决策：代价与重审条件

- **自包含产物安装。** 安装永远从构建产物复现；`opencode.json` 绝不指向仓库
  源码，`dist/` 旁不放 `node_modules`——外部用户环境没有源码检出，跨目录依赖
  在升级或清理模块缓存时断裂；接受打包体积包含全部运行时依赖。当 OpenCode
  原生提供带依赖锁定与自动安装的分发包管理器时重审。
- **派发不自动重试、不静默降级。** 超时返回可恢复的 `pending`/`unknown` 信封，
  由调用方用同一 `job_id` 显式等待；模型不可用直接报错。自动重派会让仍在后台
  运行的专家会话双倍消耗 token，静默降级会掩盖审查席独立性或能力的下降。仅当
  宿主能原子中止远端推理、且用户显式声明接受降级时重审。
- **审查席跨模型家族硬守卫，审稿报告软校验。** 审查方与被审方同模型或同家族
  即拒，防止虚假或同源审查；`author-reviewer` 返回缺合规报告时只标记
  unresolved、不阻断，防止整轮长文审稿因格式抖动作废。当所有宿主与提供商原生
  支持跨模型的 schema 强制输出且零格式失败时重审。
- **记忆只存用户批准的归纳，不存完整对话。** 历史结论是反假设而不是反证据。
  备选方案（自动保存完整聊天、把历史回答塞进向量库召回）因未验证碎片噪声与
  自我强化的幻觉闭环而弃用；不重审。
- **模型适配块按当轮实际服务的模型动态注入。** 绝不写进角色提示词或按角色
  索引——经 `tier_models`、`mode_models` 或宿主 UI 切换模型后，静态烘入的驾驶
  指令必然与实际模型错配。仅当取消运行时切模能力时重审。
- **`tier_role_caps` 是建议性上限，不是运行时调度器。** 主控只在能说出该专家
  可能改变哪个具体决策时才按需派发；上限为 0 表示该档位禁用该角色。实际频次
  依赖主控的判断纪律而非代码硬计数。当引入按账户配额硬性计费截断的托管多租户
  环境时重审。
- **研发护栏是提示词级的，完整性靠基线对账兜底。** 3 轮修复熔断由 `plan.md`
  账本约束而非运行时计数器；`CODER_BASH_DENY_RULES` 是防误操作护栏而不是
  沙箱，拦不住子 shell 或脚本重定向，工作区完整性由 `tech-lead` 的 PRE/POST
  树快照对账兜底。当宿主提供进程级文件系统沙箱与原生会话检查点分叉原语时重审。

## 2. 外部思想渊源

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
