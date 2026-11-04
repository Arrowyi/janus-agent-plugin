import { existsSync } from "node:fs"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"

import {
  configuredProviders,
  isPendingRestart,
  maskKey,
  searchProviders,
  summarize,
  type KeysPlan,
  type KeysState,
  type ProviderSummary,
  type RestartNoticeOptions,
} from "./provider-keys.ts"

/** How the surrounding surface spells each follow-up action. */
export interface KeysCommandStyle {
  readonly switchCommand: (provider: string, name: string) => string
  readonly removeCommand: (provider: string, name: string) => string
  readonly statusCommand: (provider: string) => string
  readonly adoptAllHint: string
  /** Exact follow-up commands under a provider detail; the chat command shows its own menu instead. */
  readonly detailActions?: (summary: ProviderSummary) => string[]
  readonly listFooter?: string
}

export const CHAT_STYLE: KeysCommandStyle = {
  switchCommand: (provider, name) => `/janus-config 切换 ${provider} ${name}`,
  removeCommand: (provider, name) => `/janus-config key ${provider}（删除 ${name} 并选择同时 logout）`,
  statusCommand: (provider) => `/janus-config key ${provider}`,
  adoptAllHint: '回复 1 全部以 "default" 收录（推荐，之后可改名）   2 逐个起名   3 暂不处理',
}

export function cliStyle(cli: string): KeysCommandStyle {
  return {
    switchCommand: (provider, name) => `${cli} use ${provider} ${name}`,
    removeCommand: (provider, name) => `${cli} remove ${provider} ${name} --logout`,
    statusCommand: (provider) => `${cli} show ${provider}`,
    adoptAllHint: `运行 ${cli} adopt --all 全部以 "default" 收录（推荐，之后可改名），或 ${cli} adopt <provider> <name> 逐个起名`,
    detailActions: (summary) => cliDetailActions(cli, summary),
    listFooter: `查看某个 provider 的 key，并切换、添加、改名、删除：${cli} show <provider>`,
  }
}

function cliDetailActions(cli: string, summary: ProviderSummary): string[] {
  const p = summary.id
  const names = summary.keys.map((key) => key.name)
  const other = names.find((name) => name !== summary.activeName)
  const sample = names[0] ?? "<名字>"
  const lines = ["可用操作:"]
  if (summary.unnamedActive) {
    lines.push(
      `  起名收录当前 key（之后才能改名/切换）: ${cli} adopt ${p} default`,
      `  删除当前 key（从 OpenCode 移除，需重启）: ${cli} remove ${p} --logout`,
    )
  }
  if (other !== undefined) lines.push(`  切换到某个 key（需重启）:     ${cli} use ${p} ${other}`)
  lines.push(`  添加 key:                      ${cli} add ${p} <名字>`)
  if (names.length > 0) {
    lines.push(`  改名:                          ${cli} rename ${p} ${sample} <新名字>`)
    if (other !== undefined) lines.push(`  删除候选 key:                  ${cli} remove ${p} ${other}`)
    if (summary.activeName !== undefined) {
      lines.push(`  删除生效中的 key:              ${cli} remove ${p} ${summary.activeName} --keep（OpenCode 继续用）或 --logout（同时移除，需重启）`)
    }
  }
  return lines
}

export function noticeOptions(style: KeysCommandStyle, authBackup: string | undefined, opencodeRunning?: boolean): RestartNoticeOptions {
  return {
    switchCommand: style.switchCommand,
    removeCommand: style.removeCommand,
    statusCommand: style.statusCommand,
    authBackup,
    ...(opencodeRunning !== undefined ? { opencodeRunning } : {}),
  }
}

/**
 * The exact terminal command for the `janus-keys` CLI: the installed shim when
 * present, else the bundled script beside this module, else the source file.
 */
export function resolveKeysCliCommand(moduleUrl: string): string {
  const moduleDir = dirname(fileURLToPath(moduleUrl))
  const quote = (path: string) => (/\s/.test(path) ? `"${path}"` : path)
  const shim = join(dirname(moduleDir), "bin", "janus-keys")
  if (existsSync(shim)) return quote(shim)
  const bundled = join(moduleDir, "janus-keys.js")
  if (existsSync(bundled)) return `bun ${quote(bundled)}`
  return `bun ${quote(join(moduleDir, "provider-keys-cli.ts"))}`
}

function status(summary: ProviderSummary, sinceMs: number | undefined): string {
  if (summary.authType !== undefined && summary.authType !== "api") return `${summary.authType} 登录（不可切换）`
  if (sinceMs !== undefined && isPendingRestart(summary, sinceMs)) return "已切换，待重启生效"
  if (summary.unnamedActive) return "生效中（未命名）"
  if (summary.activeName !== undefined) return "生效中"
  return summary.keys.length > 0 ? "OpenCode 中无 key" : "—"
}

function activeLabel(summary: ProviderSummary): string {
  if (summary.activeMasked === undefined) return "—"
  return `${summary.activeName ?? "未命名"}（${summary.activeMasked}）`
}

/** Header lines: unnamed keys to adopt and switches awaiting a restart. */
export function renderBanners(state: KeysState, style: KeysCommandStyle, sinceMs: number | undefined): string[] {
  const summaries = configuredProviders(state)
  const lines: string[] = []
  const unnamed = summaries.filter((summary) => summary.unnamedActive)
  if (unnamed.length > 0) {
    lines.push(
      `发现 ${unnamed.length} 个 provider 已在 OpenCode 中配置了 key，但还没有名字：${unnamed.map((s) => s.id).join("、")}。`,
      "起名后才能在多个 key 之间切换，且切换时不会丢失原来的 key。收录只复制 key、不改 OpenCode 配置，无需重启。",
      style.adoptAllHint,
      "",
    )
  }
  const pending = sinceMs === undefined ? [] : summaries.filter((summary) => isPendingRestart(summary, sinceMs))
  if (pending.length > 0) {
    lines.push(`提醒：${pending.map((s) => s.id).join("、")} 的 key 已切换，但正在运行的 OpenCode 仍在用旧的 key。完全退出 OpenCode 再重新打开后才生效。`, "")
  }
  return lines
}

export function renderList(state: KeysState, style: KeysCommandStyle, sinceMs: number | undefined): string {
  const summaries = configuredProviders(state)
  const lines = [
    `OpenCode 凭据: ${state.paths.auth}`,
    `候选 key 库: ${state.paths.vault}（权限 600）`,
    "",
    ...renderBanners(state, style, sinceMs),
  ]
  if (summaries.length === 0) {
    lines.push("还没有任何 provider 配置了 key。可以先搜索可配置的 provider，再添加 key。")
    return lines.join("\n")
  }
  lines.push("| # | Provider | 生效 key | 候选数 | 状态 |", "|---|---|---|---|---|")
  summaries.forEach((summary, index) => {
    lines.push(`| ${index + 1} | ${summary.id}（${summary.name}） | ${activeLabel(summary)} | ${summary.keys.length} | ${status(summary, sinceMs)} |`)
  })
  if (style.listFooter !== undefined) lines.push("", style.listFooter)
  return lines.join("\n")
}

export function renderSearch(state: KeysState, query: string): string {
  const hits = searchProviders(state, query)
  const total = Object.keys(state.catalog).length
  if (hits.length === 0) return `在 ${total} 个可配置 provider 中没有找到 "${query}"。`
  const lines = [`可配置 provider（共 ${total} 个，按 "${query}" 匹配，最多显示 20 个）:`, "", "| Provider | 名称 | 环境变量 | 已有 key |", "|---|---|---|---|"]
  for (const provider of hits) {
    const summary = summarize(state, provider.id)
    const has = summary.activeMasked !== undefined || summary.keys.length > 0 ? "是" : "否"
    lines.push(`| ${provider.id}${provider.custom ? "（自定义）" : ""} | ${provider.name} | ${provider.env.join(", ") || "—"} | ${has} |`)
  }
  return lines.join("\n")
}

export function renderShow(state: KeysState, provider: string, style: KeysCommandStyle, sinceMs: number | undefined): string {
  const summary = summarize(state, provider)
  const lines = [`# ${summary.id}（${summary.name}）${summary.known ? "" : " — 不在 provider 目录中"}`, ""]
  lines.push(`- OpenCode 生效 key: ${activeLabel(summary)}`, `- 状态: ${status(summary, sinceMs)}`)
  if (summary.env.length > 0) {
    const envState = summary.env.map((name) => `${name}${state.env[name] ? "（已设置）" : "（未设置）"}`).join(", ")
    lines.push(`- 环境变量: ${envState}`)
  }
  lines.push("")
  if (summary.keys.length === 0) {
    lines.push("候选库中还没有 key。")
  } else {
    lines.push("| # | 名字 | key | 添加时间 | 生效 |", "|---|---|---|---|---|")
    summary.keys.forEach((key, index) => {
      lines.push(`| ${index + 1} | ${key.name} | ${maskKey(key.key)} | ${key.addedAt.slice(0, 10) || "—"} | ${key.name === summary.activeName ? "是" : ""} |`)
    })
  }
  if (summary.unnamedActive) {
    lines.push("", `当前生效的 key（${summary.activeMasked}）还没有名字；起名后才能改名、安全切换。`)
  }
  const actions = style.detailActions?.(summary) ?? []
  if (actions.length > 0) lines.push("", ...actions)
  return lines.join("\n")
}

export function renderPlan(plan: KeysPlan): string {
  if (plan.errors.length > 0) return ["不能执行:", ...plan.errors].join("\n")
  if (plan.noop) return plan.lines.join("\n")
  const effect = plan.restartNeeded
    ? "影响：会改写 OpenCode 的 auth.json（写前备份），需要重启 OpenCode 才生效。"
    : "影响：只改候选 key 库，不改 OpenCode 当前使用的 key，无需重启。"
  return ["改动:", ...plan.lines, "", effect].join("\n")
}

export function renderAddHelp(state: KeysState, cli: string, provider: string, name: string): string {
  const summary = summarize(state, provider)
  const lines: string[] = []
  if (!summary.known && summary.authType === undefined) {
    lines.push(`注意："${provider}" 不在 OpenCode 的 provider 目录里。确认 id 无误（可先搜索）；若是自定义 provider，命令末尾加 --force。`, "")
  }
  if (summary.keys.some((key) => key.name === name)) {
    lines.push(`注意：${provider} 已有名为 "${name}" 的 key，请换一个名字。`, "")
  }
  const adopt = summary.unnamedActive ? ` --adopt-as default` : ""
  lines.push(
    "在终端运行（输入 key 时不会显示，key 也不会进入对话）：",
    `  ${cli} add ${provider} ${name} --use${adopt}`,
    "从剪贴板导入（macOS）：",
    `  pbpaste | ${cli} add ${provider} ${name} --stdin --use${adopt}`,
    "从环境变量导入：",
    `  ${cli} add ${provider} ${name} --env ${summary.env[0] ?? "YOUR_KEY_VAR"} --use${adopt}`,
    "",
    "去掉 --use 表示只保存为候选、暂不切换（无需重启）。",
  )
  if (summary.unnamedActive) {
    lines.push(`当前生效的 key 还没有名字，--adopt-as default 会先把它以 "default" 收录，避免切换时丢失。`)
  }
  lines.push('完成后回到这里回复"好了"，我会确认添加结果；如果用了 --use，需要重启 OpenCode 才生效。')
  return lines.join("\n")
}
