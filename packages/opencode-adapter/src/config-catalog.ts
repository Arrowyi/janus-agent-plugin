import {
  CONFIG_MODES,
  CONFIG_ROLES,
  CONFIG_TIERS,
  COST_GUARD_USD_DEFAULT,
  MODEL_DEFAULTS,
  TEAM_CAPS_DEFAULTS,
  TIER_MODEL_DEFAULTS,
  TIER_ROLE_CAPS_DEFAULTS,
  type ModelRole,
} from "./plugin-config.ts"

/**
 * The user-facing catalog of every janus-agent config field: what it is,
 * which values it takes, and its shipped default. `/janus-config` and the
 * `janus_config` tool render menus from it; `config-catalog.test.ts` keeps it
 * in lockstep with `JanusPluginConfigSchema`.
 */

export type ConfigGroupId =
  | "roles"
  | "models"
  | "routing"
  | "model_prompts"
  | "team"
  | "writer"
  | "simple"
  | "memory"
  | "install"

export interface ConfigGroup {
  readonly id: ConfigGroupId
  readonly label: string
  readonly summary: string
}

export const CONFIG_GROUPS: readonly ConfigGroup[] = [
  { id: "roles", label: "角色开关与名称", summary: "启用/停用每个角色，或改它注册到 OpenCode 的 agent 名" },
  { id: "models", label: "角色模型", summary: "每个角色默认使用的模型（provider/model）" },
  { id: "routing", label: "高级模型路由", summary: "按咨询模式、按深度档位为角色单独指定模型" },
  { id: "model_prompts", label: "模型适配提示词", summary: "按模型覆盖或禁用插件自带的驾驶提示块" },
  { id: "team", label: "团队与上限", summary: "团队轮次/扇出上限、各档位角色实例上限、费用止损线" },
  { id: "writer", label: "文档写手", summary: "author-writer 可写入的目录，或改用宿主提供的写手" },
  { id: "simple", label: "simple 工作区", summary: "simple 可免确认写入的工作目录" },
  { id: "memory", label: "记忆与检索", summary: "记忆 MCP 开关与语义检索 embedding 端点" },
  { id: "install", label: "安装与其他", summary: "是否自动安装 skill 与 slash command、编辑器 schema 提示" },
]

export type ConfigFieldType =
  | "boolean"
  | "string"
  | "integer"
  | "number"
  | "string[]"
  | "model"
  | "object"
  | "record"

/**
 * One configurable field. `key` is a dotted path; a `<placeholder>` segment
 * matches any value listed in `placeholders[name]` (or any key when that list
 * is empty).
 */
export interface ConfigField {
  readonly key: string
  readonly group: ConfigGroupId
  readonly type: ConfigFieldType
  readonly summary: string
  /** Shipped default; `undefined` means "unset" (the field is optional). */
  readonly default?: unknown
  /** Human note on how the default is derived when it is not a plain value. */
  readonly defaultNote?: string
  readonly choices?: readonly string[]
  readonly example?: string
  /**
   * The parent object must be materialized with this value before a child can
   * be set (its schema requires every sibling), and unsetting the child
   * restores the shipped value instead of deleting it.
   */
  readonly seedParent?: { readonly key: string; readonly value: unknown }
  /** The change is read on the next turn without restarting OpenCode. */
  readonly hotReload?: boolean
}

interface RoleInfo {
  readonly role: ModelRole
  readonly label: string
  readonly hasEnabled: boolean
}

export const ROLE_INFO: readonly RoleInfo[] = [
  { role: "janus", label: "默认前台（入口，不可派发）", hasEnabled: true },
  { role: "simple", label: "经济型快答", hasEnabled: true },
  { role: "consultant", label: "咨询团队入口（选型/核实/路线/研究/指南）", hasEnabled: false },
  { role: "architect", label: "设计入口，写 design.md（不可派发）", hasEnabled: true },
  { role: "coder", label: "编码入口", hasEnabled: true },
  { role: "author", label: "文档团队入口（可派发）", hasEnabled: true },
  { role: "common-explorer", label: "共享检索（只读）", hasEnabled: true },
  { role: "consultant-analyst", label: "咨询解读专家", hasEnabled: true },
  { role: "consultant-critic", label: "反证与计划稳健性审查", hasEnabled: true },
  { role: "consultant-auditor", label: "来源影响与独立性审计", hasEnabled: true },
  { role: "coder-reviewer", label: "设计事前验尸、计划/diff 审查", hasEnabled: true },
  { role: "author-writer", label: "文档正文唯一执笔人", hasEnabled: true },
  { role: "author-reviewer", label: "文档独立审稿（只读）", hasEnabled: true },
  { role: "coder-lite", label: "初中级编码车道（里程碑/规格完备编码/单测）", hasEnabled: true },
]

const ROLE_CAP_KEYS = Object.keys(TIER_ROLE_CAPS_DEFAULTS.fast)

export const CONFIG_PLACEHOLDERS: Readonly<Record<string, readonly string[]>> = {
  mode: CONFIG_MODES,
  tier: CONFIG_TIERS,
  role: CONFIG_ROLES,
  cap_role: ROLE_CAP_KEYS,
  model_key: [],
}

export function roleFieldPrefix(role: string): string {
  return role.replace(/-/g, "_")
}

function roleFields(): ConfigField[] {
  const fields: ConfigField[] = []
  for (const info of ROLE_INFO) {
    const prefix = roleFieldPrefix(info.role)
    if (info.hasEnabled) {
      fields.push({
        key: `${prefix}_enabled`,
        group: "roles",
        type: "boolean",
        default: true,
        summary: `是否注册 ${info.role}（${info.label}）`,
      })
    }
    fields.push({
      key: `${prefix}_agent`,
      group: "roles",
      type: "string",
      default: info.role,
      summary: `${info.role} 注册到 OpenCode 的 agent 名`,
    })
    const inherits = info.role === "architect" || info.role === "author"
    fields.push({
      key: `${prefix}_model`,
      group: "models",
      type: "model",
      default: MODEL_DEFAULTS[info.role],
      ...(inherits ? { defaultNote: `未设置时先继承显式配置的 consultant_model，再用 ${MODEL_DEFAULTS[info.role]}` } : {}),
      summary: `${info.role}（${info.label}）使用的模型`,
      example: MODEL_DEFAULTS[info.role],
    })
  }
  return fields
}

export const CONFIG_FIELDS: readonly ConfigField[] = [
  ...roleFields(),
  {
    key: "mode_models",
    group: "routing",
    type: "object",
    summary: "按咨询模式为角色指定模型；优先级最高",
  },
  {
    key: "mode_models.<mode>.<role>",
    group: "routing",
    type: "model",
    summary: "某模式下某角色的模型：mode_models > tier_models > <role>_model > 默认（只作用于派发出去的会话）",
    example: "mode_models.design.coder-reviewer = provider/strong-reviewer",
  },
  {
    key: "tier_models",
    group: "routing",
    type: "object",
    summary: "按深度档位（fast/standard/deep）为角色指定模型",
    defaultNote: `出厂档位默认 deep.coder = ${TIER_MODEL_DEFAULTS.deep?.coder ?? "(无)"}，排在 <role>_model 之后`,
  },
  {
    key: "tier_models.<tier>.<role>",
    group: "routing",
    type: "model",
    summary: "某档位下某角色的模型（只作用于派发出去的会话）",
    example: "tier_models.deep.coder = provider/strong-coding",
  },
  {
    key: "model_prompts",
    group: "model_prompts",
    type: "record",
    summary: "按规范化模型键覆盖插件自带的模型适配块",
    hotReload: true,
  },
  {
    key: "model_prompts.<model_key>",
    group: "model_prompts",
    type: "string",
    summary: "某模型的适配块全文；\"\" 表示禁用该模型的块。键 = 去掉 provider 前缀、小写、只留字母数字",
    example: "model_prompts.glm53 = \"…\"（opencode-go/glm-5.3 → glm53）",
    hotReload: true,
  },
  {
    key: "team_caps",
    group: "team",
    type: "object",
    default: TEAM_CAPS_DEFAULTS,
    summary: "团队循环与扇出上限（三个子项需同时存在）",
  },
  ...(Object.keys(TEAM_CAPS_DEFAULTS) as (keyof typeof TEAM_CAPS_DEFAULTS)[]).map((cap): ConfigField => ({
    key: `team_caps.${cap}`,
    group: "team",
    type: "integer",
    default: TEAM_CAPS_DEFAULTS[cap],
    summary: {
      round_cap: "团队最多来回几轮（正整数）",
      explorer_cap: "一次最多派几个检索员（正整数）",
      critic_search_cap: "反证者最多检索几次（正整数）",
    }[cap],
    seedParent: { key: "team_caps", value: TEAM_CAPS_DEFAULTS },
  })),
  {
    key: "tier_role_caps",
    group: "team",
    type: "object",
    default: TIER_ROLE_CAPS_DEFAULTS,
    summary: "每档位每角色的建议性实例上限（fast/standard/deep 三档需同时存在）",
  },
  {
    key: "tier_role_caps.<tier>.<cap_role>",
    group: "team",
    type: "integer",
    defaultNote: "fast 5/0/0/0/0/0，standard 5/1/1/1/1/1，deep 5/3/2/2/2/2",
    summary: "某档位某角色最多几个实例（≥0 的整数）",
    example: "tier_role_caps.deep.consultant_critic = 3",
    seedParent: { key: "tier_role_caps", value: TIER_ROLE_CAPS_DEFAULTS },
  },
  {
    key: "cost_guard_provider_usd",
    group: "team",
    type: "number",
    default: COST_GUARD_USD_DEFAULT,
    summary: "每个提供商的建议性止损线（美元，正数）",
  },
  {
    key: "writer_docs_roots",
    group: "writer",
    type: "string[]",
    default: ["userdoc"],
    summary: "author-writer 可写入的项目相对目录；[] = 只读回退（写手只返回正文）",
    example: "docs, userdoc/guides",
  },
  {
    key: "writer_delegate_agent",
    group: "writer",
    type: "string",
    summary: "改用宿主提供的写手 agent；设置后不再注册内置 author-writer",
  },
  {
    key: "writer_delegate_model",
    group: "writer",
    type: "model",
    summary: "宿主写手的模型；不设则沿用宿主的模型选择",
  },
  {
    key: "simple_workspace_dir",
    group: "simple",
    type: "string",
    defaultNote: "$XDG_DATA_HOME/janus-agent/lite",
    summary: "simple 可免确认写入的工作目录（绝对路径）",
  },
  {
    key: "memory_enabled",
    group: "memory",
    type: "boolean",
    default: true,
    summary: "注册并启动 janus-memory 记忆 MCP 服务器",
  },
  {
    key: "embedding",
    group: "memory",
    type: "object",
    summary: "OpenAI 兼容的 embedding 端点，开启语义检索；四个子项全有或全无",
    example: "{\"base_url\":\"https://api.openai.com/v1\",\"api_key_env\":\"OPENAI_API_KEY\",\"model\":\"text-embedding-3-small\",\"dimensions\":1536}",
  },
  {
    key: "embedding.base_url",
    group: "memory",
    type: "string",
    summary: "embedding 服务地址",
    example: "https://api.openai.com/v1",
  },
  {
    key: "embedding.api_key_env",
    group: "memory",
    type: "string",
    summary: "存放 API key 的环境变量名（不是 key 本身）",
    example: "OPENAI_API_KEY",
  },
  {
    key: "embedding.model",
    group: "memory",
    type: "string",
    summary: "embedding 模型名",
    example: "text-embedding-3-small",
  },
  {
    key: "embedding.dimensions",
    group: "memory",
    type: "number",
    summary: "向量维度",
    example: "1536",
  },
  {
    key: "install_skill",
    group: "install",
    type: "boolean",
    default: true,
    summary: "启动时安装四个 skill",
  },
  {
    key: "install_commands",
    group: "install",
    type: "boolean",
    default: true,
    summary: "启动时安装 janus-memory、janus-models、janus-handoff、janus-config 四条命令",
  },
  {
    key: "$schema",
    group: "install",
    type: "string",
    summary: "给编辑器用的 JSON schema 地址，插件不读取",
  },
]

export interface ResolvedField {
  readonly field: ConfigField
  /** The concrete dotted path, placeholders filled in. */
  readonly path: readonly string[]
}

export function splitKey(key: string): string[] {
  return key.split(".").filter((segment) => segment.length > 0)
}

function matchPattern(pattern: string, path: readonly string[]): boolean {
  const segments = splitKey(pattern)
  if (segments.length !== path.length) return false
  return segments.every((segment, index) => {
    const actual = path[index] ?? ""
    const placeholder = /^<(.+)>$/.exec(segment)?.[1]
    if (placeholder === undefined) return segment === actual
    const allowed = CONFIG_PLACEHOLDERS[placeholder] ?? []
    return allowed.length === 0 ? actual.length > 0 : allowed.includes(actual)
  })
}

/**
 * Resolve a user-supplied key to its catalog field. The top-level segment
 * accepts `-` for `_` (`coder-lite_model` → `coder_lite_model`).
 */
export function resolveField(key: string): ResolvedField | undefined {
  const path = splitKey(key.trim())
  if (path.length === 0) return undefined
  const candidates = [path, [roleFieldPrefix(path[0] ?? ""), ...path.slice(1)]]
  for (const candidate of candidates) {
    const field = CONFIG_FIELDS.find((entry) => matchPattern(entry.key, candidate))
    if (field !== undefined) return { field, path: candidate }
  }
  return undefined
}

/** The concrete shipped default for a resolved path, when one exists. */
export function fieldDefault(resolved: ResolvedField): unknown {
  const { field, path } = resolved
  if (field.default !== undefined) return field.default
  if (path[0] === "tier_role_caps" && path.length === 3) {
    const tier = TIER_ROLE_CAPS_DEFAULTS[path[1] as keyof typeof TIER_ROLE_CAPS_DEFAULTS]
    return tier?.[path[2] as keyof typeof tier]
  }
  if (path[0] === "tier_models" && path.length === 3) {
    return TIER_MODEL_DEFAULTS[path[1] as keyof typeof TIER_MODEL_DEFAULTS]?.[path[2] as ModelRole]
  }
  return undefined
}

export function fieldsInGroup(group: ConfigGroupId): ConfigField[] {
  return CONFIG_FIELDS.filter((field) => field.group === group)
}
