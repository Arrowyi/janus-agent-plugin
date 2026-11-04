import { tool, type ToolDefinition } from "@opencode-ai/plugin"

import {
  applyKeysPlan,
  loadKeysState,
  planAdopt,
  planRemove,
  planRename,
  planUse,
  restartNotice,
  type KeysPlan,
  type KeysState,
} from "./provider-keys.ts"
import {
  CHAT_STYLE,
  noticeOptions,
  renderAddHelp,
  renderList,
  renderPlan,
  renderSearch,
  renderShow,
  resolveKeysCliCommand,
} from "./provider-keys-view.ts"

export const PROVIDER_KEYS_TOOL_NAME = "janus_provider_keys"

const ACTIONS = ["list", "search", "show", "use", "remove", "rename", "adopt", "add_help"] as const
type KeysAction = (typeof ACTIONS)[number]

export interface KeysToolArgs {
  action: KeysAction
  provider?: string
  name?: string
  new_name?: string
  query?: string
  adopt_as?: string
  logout?: boolean
  apply?: boolean
}

export interface KeysToolDeps {
  readonly env?: NodeJS.ProcessEnv
  /** Start time of the running OpenCode process (epoch ms). */
  readonly startedAtMs?: number
  /** Resolves the `janus-keys` command shown to the user. */
  readonly cliCommand?: () => string
}

function need(value: string | undefined, label: string): string | undefined {
  return value === undefined || value.trim().length === 0 ? `Error: 需要 ${label}` : undefined
}

async function runWrite(state: KeysState, plan: KeysPlan, apply: boolean): Promise<string> {
  const preview = renderPlan(plan)
  if (plan.errors.length > 0 || plan.noop) return preview
  if (!apply) return `${preview}\n\n这是预览，尚未写入。请用户确认后，用相同参数加 apply: true 再调用一次。`
  const result = await applyKeysPlan(state, plan)
  const written = preview.replace("改动:", "已写入:")
  if (!plan.restartNeeded) return `${written.replace(/\n\n影响：.*$/s, "")}\n\n无需重启：OpenCode 当前使用的 key 没有变化。`
  return `${written.replace(/\n\n影响：.*$/s, "")}\n\n${restartNotice(plan, noticeOptions(CHAT_STYLE, result.authBackup))}`
}

export async function runKeysAction(args: KeysToolArgs, deps: KeysToolDeps = {}): Promise<string> {
  const env = deps.env ?? process.env
  const sinceMs = deps.startedAtMs ?? Date.now() - process.uptime() * 1000
  const state = await loadKeysState(env)
  const provider = args.provider?.trim() ?? ""
  switch (args.action) {
    case "list":
      return renderList(state, CHAT_STYLE, sinceMs)
    case "search":
      return renderSearch(state, args.query ?? "")
    case "show":
      return need(args.provider, "provider") ?? renderShow(state, provider, CHAT_STYLE, sinceMs)
    case "use":
      return need(args.provider, "provider") ?? need(args.name, "name") ??
        runWrite(state, planUse(state, provider, args.name ?? "", args.adopt_as), args.apply === true)
    case "remove":
      return need(args.provider, "provider") ??
        runWrite(state, planRemove(state, provider, args.name?.trim() ?? "", args.logout), args.apply === true)
    case "rename":
      return need(args.provider, "provider") ?? need(args.name, "name") ?? need(args.new_name, "new_name") ??
        runWrite(state, planRename(state, provider, args.name ?? "", args.new_name ?? ""), args.apply === true)
    case "adopt":
      return need(args.provider, 'provider（或 "*" 表示全部）') ??
        runWrite(state, planAdopt(state, provider, args.name?.trim() || "default"), args.apply === true)
    case "add_help": {
      const cli = deps.cliCommand?.() ?? resolveKeysCliCommand(import.meta.url)
      return need(args.provider, "provider") ?? need(args.name, "name") ??
        renderAddHelp(state, cli, provider, args.name?.trim() ?? "")
    }
  }
}

/**
 * The `janus_provider_keys` tool: list OpenCode providers and their named
 * keys, and switch/rename/remove/adopt them. It has no argument that accepts a
 * key value; adding a key is done in the terminal (`add_help` prints the exact
 * command) so a secret never enters the conversation.
 */
export function createProviderKeysTool(deps: KeysToolDeps = {}): ToolDefinition {
  return tool({
    description:
      "Manage named OpenCode provider API keys for /janus-config group 10. Actions: list (configured providers, active key name, candidate count, restart status), search (query → configurable providers), show (provider → its named keys, masked), use (provider + name: make that key active; adopt_as names an unnamed current key first), remove (provider + name; logout true/false required for the active key; omit name with logout true to delete an unnamed active key), rename (provider + name + new_name), adopt (provider or \"*\" + optional name, default \"default\": name OpenCode's current unnamed key), add_help (provider + name → exact terminal command; keys are never accepted here). Writes return a preview unless apply is true; only pass apply: true after the user confirms that exact preview. Output never contains a full key.",
    args: {
      action: tool.schema.enum(ACTIONS),
      provider: tool.schema.string().optional(),
      name: tool.schema.string().optional(),
      new_name: tool.schema.string().optional(),
      query: tool.schema.string().optional(),
      adopt_as: tool.schema.string().optional(),
      logout: tool.schema.boolean().optional(),
      apply: tool.schema.boolean().optional(),
    },
    async execute(args): Promise<string> {
      return runKeysAction(args, deps)
    },
  })
}
