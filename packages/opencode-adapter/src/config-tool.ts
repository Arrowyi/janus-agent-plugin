import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import {
  CONFIG_FIELDS,
  CONFIG_GROUPS,
  CONFIG_PLACEHOLDERS,
  fieldDefault,
  fieldsInGroup,
  resolveField,
  splitKey,
  type ConfigField,
  type ConfigGroup,
} from "./config-catalog.ts"
import {
  applyChange,
  effectiveValue,
  planChange,
  readConfigState,
  userSetPaths,
  type ChangePlan,
  type ConfigOp,
  type ConfigState,
  type FieldSource,
} from "./config-editor.ts"

export const CONFIG_TOOL_NAME = "janus_config"

const ACTIONS = ["catalog", "describe", "get", "set", "unset", "reset", "validate"] as const
type ConfigAction = (typeof ACTIONS)[number]

const SOURCE_LABEL: Record<FieldSource, string> = {
  user: "用户设置",
  inherited: "继承 consultant_model",
  default: "默认",
  unset: "未设置",
}

const TYPE_LABEL: Record<ConfigField["type"], string> = {
  boolean: "开关 true/false",
  string: "文本",
  integer: "整数",
  number: "数字",
  "string[]": "文本列表（逗号分隔或 JSON 数组）",
  model: "模型 provider/model",
  object: "对象（整体用 JSON 设置，或逐个子项设置）",
  record: "键值表（逐个子项设置）",
}

function show(value: unknown, max = 60): string {
  if (value === undefined) return "—"
  const text = JSON.stringify(value) ?? String(value)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ")
}

function statusLine(state: ConfigState): string {
  const customized = userSetPaths(state.raw).length
  const file = state.exists ? "已存在" : "尚不存在，全部使用默认值，首次写入时创建"
  const valid = state.errors.length === 0 ? "校验通过" : "校验失败"
  return `配置文件: ${state.path}（${file}）｜${valid}｜已自定义 ${customized} 项`
}

function findGroup(key: string | undefined): ConfigGroup | undefined {
  if (key === undefined) return undefined
  const trimmed = key.trim()
  const index = Number(trimmed)
  if (Number.isInteger(index) && index >= 1 && index <= CONFIG_GROUPS.length) return CONFIG_GROUPS[index - 1]
  return CONFIG_GROUPS.find((group) => group.id === trimmed || group.label === trimmed)
}

function renderOverview(state: ConfigState): string {
  const userPaths = userSetPaths(state.raw)
  const lines = [statusLine(state), ""]
  if (state.errors.length > 0) lines.push("当前问题:", ...state.errors, "")
  lines.push("分组（catalog key=<编号或分组 id> 查看字段）:")
  CONFIG_GROUPS.forEach((group, index) => {
    const fields = fieldsInGroup(group.id)
    const customized = userPaths.filter((path) => resolveField(path.join("."))?.field.group === group.id).length
    lines.push(`${index + 1}. ${group.label} [${group.id}] — ${group.summary}（${fields.length} 项，已自定义 ${customized}）`)
  })
  lines.push(`${CONFIG_GROUPS.length + 1}. Provider 密钥 — OpenCode 各 provider 的 API key（由 janus_provider_keys 工具管理，action: "list"）`)
  return lines.join("\n")
}

function isPattern(field: ConfigField): boolean {
  return field.key.includes("<")
}

function renderGroup(state: ConfigState, group: ConfigGroup): string {
  const userPaths = userSetPaths(state.raw)
  const lines = [statusLine(state), "", `## ${group.label} — ${group.summary}`, "", "| 字段 | 当前值 | 默认值 | 来源 | 说明 |", "|---|---|---|---|---|"]
  for (const field of fieldsInGroup(group.id)) {
    if (isPattern(field)) {
      lines.push(`| \`${field.key}\` | — | ${cell(field.defaultNote ?? "—")} | 模板 | ${cell(field.summary)} |`)
      for (const path of userPaths) {
        const resolved = resolveField(path.join("."))
        if (resolved?.field !== field) continue
        const effective = effectiveValue(state, path)
        lines.push(`| \`${path.join(".")}\` | ${cell(show(effective.value))} | ${cell(show(fieldDefault(resolved)))} | ${SOURCE_LABEL[effective.source]} | ${cell(field.summary)} |`)
      }
      continue
    }
    const path = splitKey(field.key)
    const effective = effectiveValue(state, path)
    const defaultText = field.defaultNote ?? show(field.default)
    lines.push(`| \`${field.key}\` | ${cell(show(effective.value))} | ${cell(defaultText)} | ${SOURCE_LABEL[effective.source]} | ${cell(field.summary)} |`)
  }
  return lines.join("\n")
}

function placeholderHelp(field: ConfigField): string[] {
  const out: string[] = []
  for (const match of field.key.matchAll(/<([^>]+)>/g)) {
    const name = match[1] ?? ""
    const values = CONFIG_PLACEHOLDERS[name] ?? []
    out.push(`- <${name}> 可选: ${values.length > 0 ? values.join(", ") : "任意规范化模型键（去 provider 前缀、小写、只留字母数字）"}`)
  }
  return out
}

function renderDescribe(state: ConfigState, key: string | undefined): string {
  if (key === undefined || key.trim().length === 0) return "Error: describe 需要 key"
  const group = findGroup(key)
  if (group !== undefined) return renderGroup(state, group)
  const template = CONFIG_FIELDS.find((entry) => entry.key === key.trim())
  const resolved = template === undefined ? resolveField(key) : { field: template, path: splitKey(template.key) }
  if (resolved === undefined) return `Error: 未知配置项 "${key}"；用 catalog 查看可配置项`
  const { field, path } = resolved
  const concrete = !path.some((segment) => /^<.+>$/.test(segment))
  const lines = [`# ${path.join(".")}`, "", field.summary, "", `- 分组: ${CONFIG_GROUPS.find((g) => g.id === field.group)?.label ?? field.group}`, `- 类型: ${TYPE_LABEL[field.type]}`]
  const defaultValue = fieldDefault(resolved)
  lines.push(`- 默认值: ${field.defaultNote ?? (defaultValue === undefined ? "未设置（可选项）" : show(defaultValue, 200))}`)
  if (concrete) {
    const effective = effectiveValue(state, path)
    lines.push(`- 当前值: ${show(effective.value, 200)}（${SOURCE_LABEL[effective.source]}）`)
  }
  if (field.type === "boolean") lines.push("- 可选: true（开）/ false（关）")
  if (field.choices !== undefined) lines.push(`- 可选: ${field.choices.join(", ")}`)
  lines.push(...placeholderHelp(field))
  if (field.type === "model") lines.push("- 候选: 运行 `opencode models` 列出本机已配置提供商的模型")
  if (field.example !== undefined) lines.push(`- 示例: ${field.example}`)
  if (field.seedParent !== undefined) lines.push(`- 说明: 首次设置会把 ${field.seedParent.key} 的其余子项按出厂值一并写入；unset 恢复出厂值`)
  if (field.type === "object" || field.type === "record") {
    const children = fieldsInGroup(field.group).filter((child) => child.key.startsWith(`${field.key}.`))
    if (children.length > 0) lines.push(`- 子项: ${children.map((child) => child.key).join(", ")}`)
  }
  lines.push(`- 生效: ${field.hotReload === true ? "下一轮对话即生效" : "重启 OpenCode 后生效"}`)
  return lines.join("\n")
}

function renderGet(state: ConfigState, key: string | undefined): string {
  if (key !== undefined && key.trim().length > 0) {
    const resolved = resolveField(key)
    const path = resolved?.path ?? splitKey(key)
    const effective = effectiveValue(state, path)
    const known = resolved === undefined ? "（不在目录中的键）" : ""
    return `${path.join(".")} = ${show(effective.value, 2000)}（${SOURCE_LABEL[effective.source]}）${known}`
  }
  const paths = userSetPaths(state.raw)
  const lines = [statusLine(state), ""]
  if (state.errors.length > 0) lines.push("当前问题:", ...state.errors, "")
  if (paths.length === 0) {
    lines.push("没有自定义项，全部使用默认值。")
  } else {
    lines.push("已自定义:")
    for (const path of paths) {
      const known = resolveField(path.join(".")) === undefined ? "  ← 不在目录中，schema 会拒绝" : ""
      lines.push(`- ${path.join(".")} = ${show(effectiveValue(state, path).value)}${known}`)
    }
  }
  return lines.join("\n")
}

function renderPlan(plan: ChangePlan): string {
  const lines = [`配置文件: ${plan.path}${plan.exists ? "" : "（将新建）"}`]
  if (plan.errors.length > 0) {
    lines.push("", "改动未通过校验，不能写入:", ...plan.errors)
    return lines.join("\n")
  }
  if (plan.noop) {
    lines.push("", "无改动：新值与当前值相同（或该项本来就是默认值）。")
    return lines.join("\n")
  }
  lines.push("", "改动:")
  for (const change of plan.changes) lines.push(`- ${change.key}: ${show(change.before, 120)} -> ${show(change.after, 120)}`)
  lines.push("", "文件 diff:", "```diff", plan.diff, "```")
  return lines.join("\n")
}

async function runWrite(state: ConfigState, op: ConfigOp, apply: boolean): Promise<string> {
  const plan = planChange(state, op)
  if (!apply || plan.errors.length > 0 || plan.noop) {
    const preview = renderPlan(plan)
    if (plan.errors.length > 0 || plan.noop) return preview
    return `${preview}\n\n这是预览，尚未写入。请用户确认后，用相同参数加 apply: true 再调用一次。`
  }
  const result = await applyChange(plan)
  const after = await readConfigState({ JANUS_CONFIG: result.path })
  const hot = op.kind !== "reset" && resolveField(op.key)?.field.hotReload === true
  const rollback =
    result.backupPath === undefined ? `rm "${result.path}"` : `cp "${result.backupPath}" "${result.path}"`
  return [
    renderPlan(plan).replace("改动:", "已写入:"),
    "",
    `回读校验: ${after.errors.length === 0 ? "通过" : after.errors.join("\n")}`,
    `回滚: ${rollback}`,
    hot ? "生效: 下一轮对话即生效。" : "生效: 配置不热加载，需重启 OpenCode。",
  ].join("\n")
}

export interface ConfigToolDeps {
  readonly env?: NodeJS.ProcessEnv
}

export async function runConfigAction(
  args: { action: ConfigAction; key?: string; value?: string; apply?: boolean },
  env: NodeJS.ProcessEnv,
): Promise<string> {
  let state: ConfigState
  try {
    state = await readConfigState(env)
  } catch (e) {
    return `Error: ${e instanceof Error ? e.message : String(e)}`
  }
  switch (args.action) {
    case "catalog": {
      const group = findGroup(args.key)
      if (args.key !== undefined && args.key.trim().length > 0 && group === undefined) {
        return `Error: 未知分组 "${args.key}"；可选: ${CONFIG_GROUPS.map((g, i) => `${i + 1}/${g.id}`).join(", ")}`
      }
      return group === undefined ? renderOverview(state) : renderGroup(state, group)
    }
    case "describe":
      return renderDescribe(state, args.key)
    case "get":
      return renderGet(state, args.key)
    case "validate":
      return state.errors.length === 0 ? `${statusLine(state)}\n配置有效。` : `${statusLine(state)}\n${state.errors.join("\n")}`
    case "set":
      if (args.key === undefined || args.value === undefined) return "Error: set 需要 key 和 value"
      return runWrite(state, { kind: "set", key: args.key, value: args.value }, args.apply === true)
    case "unset":
      if (args.key === undefined) return "Error: unset 需要 key"
      return runWrite(state, { kind: "unset", key: args.key }, args.apply === true)
    case "reset":
      return runWrite(state, { kind: "reset" }, args.apply === true)
  }
}

/**
 * The `janus_config` tool: schema-aware read/preview/write access to the
 * user-level janus-agent config file. Writes are two-phase: without
 * `apply: true` every mutating action only returns a preview.
 */
export function createJanusConfigTool(deps: ConfigToolDeps = {}): ToolDefinition {
  return tool({
    description:
      "Read and edit the janus-agent plugin config (config.jsonc) for /janus-config. Actions: catalog (no key = overview + groups; key = group number/id → field table), describe (key → type, default, current value, choices), get (no key = all customized entries; key = effective value), validate, and set/unset/reset. set/unset/reset return a preview diff and write nothing unless apply is true; only pass apply: true after the user explicitly confirms that exact preview. Keys are dotted paths, e.g. coder_model, team_caps.round_cap, mode_models.design.coder-reviewer.",
    args: {
      action: tool.schema.enum(ACTIONS),
      key: tool.schema.string().optional(),
      value: tool.schema.string().optional(),
      apply: tool.schema.boolean().optional(),
    },
    async execute(args): Promise<string> {
      return runConfigAction(args, deps.env ?? process.env)
    },
  })
}
