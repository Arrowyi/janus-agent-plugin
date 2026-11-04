import { chmod, copyFile, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

import { stripJsonc } from "./jsonc.ts"
import { resolveOpencodeConfigDir } from "./skill-installer.ts"

/**
 * Named provider keys for OpenCode. OpenCode itself holds one active key per
 * provider in its `auth.json`; this module keeps several named candidates per
 * provider in a private vault and "switches" by writing the chosen key into
 * `auth.json`. No function here ever returns a full key in its text output.
 */

export interface VaultKey {
  readonly name: string
  readonly key: string
  readonly addedAt: string
}

export interface VaultProvider {
  readonly keys: readonly VaultKey[]
  /** When this tool last changed the provider's active key (ISO time). */
  readonly switchedAt?: string
}

export interface Vault {
  readonly version: 1
  readonly providers: Readonly<Record<string, VaultProvider>>
}

export type AuthEntry = { readonly type: string; readonly key?: string } & Record<string, unknown>
export type AuthStore = Readonly<Record<string, AuthEntry>>

export interface CatalogProvider {
  readonly id: string
  readonly name: string
  readonly env: readonly string[]
  readonly custom: boolean
}

export interface KeysPaths {
  readonly vault: string
  readonly auth: string
  readonly catalog: string
  readonly opencodeConfigDir: string
}

export interface KeysState {
  readonly paths: KeysPaths
  readonly vault: Vault
  readonly auth: AuthStore
  readonly catalog: Readonly<Record<string, CatalogProvider>>
  readonly env: NodeJS.ProcessEnv
}

export const KEY_NAME_PATTERN = /^\S{1,32}$/
const EMPTY_VAULT: Vault = { version: 1, providers: {} }

function home(env: NodeJS.ProcessEnv): string {
  return env.HOME ?? ""
}

function dataHome(env: NodeJS.ProcessEnv): string {
  return env.XDG_DATA_HOME && env.XDG_DATA_HOME.length > 0 ? env.XDG_DATA_HOME : join(home(env), ".local", "share")
}

function cacheHome(env: NodeJS.ProcessEnv): string {
  return env.XDG_CACHE_HOME && env.XDG_CACHE_HOME.length > 0 ? env.XDG_CACHE_HOME : join(home(env), ".cache")
}

export function resolveKeysPaths(env: NodeJS.ProcessEnv): KeysPaths {
  return {
    vault: join(dataHome(env), "janus-agent", "provider-keys.json"),
    auth: join(dataHome(env), "opencode", "auth.json"),
    catalog: join(cacheHome(env), "opencode", "models.json"),
    opencodeConfigDir: resolveOpencodeConfigDir(env),
  }
}

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse(stripJsonc(await readFile(path, "utf8")))
  } catch {
    return undefined
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function parseVault(value: unknown): Vault {
  if (!isRecord(value) || !isRecord(value.providers)) return EMPTY_VAULT
  const providers: Record<string, VaultProvider> = {}
  for (const [id, entry] of Object.entries(value.providers)) {
    if (!isRecord(entry) || !Array.isArray(entry.keys)) continue
    const keys = entry.keys.filter(
      (key): key is VaultKey => isRecord(key) && typeof key.name === "string" && typeof key.key === "string",
    )
    providers[id] = {
      keys: keys.map((key) => ({ name: key.name, key: key.key, addedAt: typeof key.addedAt === "string" ? key.addedAt : "" })),
      ...(typeof entry.switchedAt === "string" ? { switchedAt: entry.switchedAt } : {}),
    }
  }
  return { version: 1, providers }
}

async function loadCatalog(paths: KeysPaths): Promise<Record<string, CatalogProvider>> {
  const catalog: Record<string, CatalogProvider> = {}
  const modelsDev = await readJson(paths.catalog)
  if (isRecord(modelsDev)) {
    for (const [id, entry] of Object.entries(modelsDev)) {
      if (!isRecord(entry)) continue
      catalog[id] = {
        id,
        name: typeof entry.name === "string" ? entry.name : id,
        env: Array.isArray(entry.env) ? entry.env.filter((item): item is string => typeof item === "string") : [],
        custom: false,
      }
    }
  }
  for (const file of ["opencode.jsonc", "opencode.json", "config.json"]) {
    const config = await readJson(join(paths.opencodeConfigDir, file))
    if (!isRecord(config) || !isRecord(config.provider)) continue
    for (const [id, entry] of Object.entries(config.provider)) {
      const existing = catalog[id]
      const name = isRecord(entry) && typeof entry.name === "string" ? entry.name : existing?.name ?? id
      catalog[id] = { id, name, env: existing?.env ?? [], custom: existing === undefined }
    }
  }
  return catalog
}

export async function loadKeysState(env: NodeJS.ProcessEnv): Promise<KeysState> {
  const paths = resolveKeysPaths(env)
  const auth = await readJson(paths.auth)
  return {
    paths,
    vault: parseVault(await readJson(paths.vault)),
    auth: isRecord(auth) ? (auth as AuthStore) : {},
    catalog: await loadCatalog(paths),
    env,
  }
}

/** `sk-…ab12`: never more than the first 3 and last 4 characters. */
export function maskKey(key: string): string {
  if (key.length <= 8) return `…${key.slice(-2)}`
  return `${key.slice(0, 3)}…${key.slice(-4)}`
}

export interface ProviderSummary {
  readonly id: string
  readonly name: string
  readonly env: readonly string[]
  readonly known: boolean
  readonly authType: string | undefined
  /** The active key's vault name, when the active key is in the vault. */
  readonly activeName: string | undefined
  readonly activeMasked: string | undefined
  /** OpenCode has an api key for the provider that the vault does not hold. */
  readonly unnamedActive: boolean
  readonly keys: readonly VaultKey[]
  readonly switchedAt: string | undefined
}

export function summarize(state: KeysState, id: string): ProviderSummary {
  const entry = state.auth[id]
  const keys = state.vault.providers[id]?.keys ?? []
  const activeKey = entry?.type === "api" && typeof entry.key === "string" ? entry.key : undefined
  const active = activeKey === undefined ? undefined : keys.find((key) => key.key === activeKey)
  const catalog = state.catalog[id]
  return {
    id,
    name: catalog?.name ?? id,
    env: catalog?.env ?? [],
    known: catalog !== undefined,
    authType: entry?.type,
    activeName: active?.name,
    activeMasked: activeKey === undefined ? undefined : maskKey(activeKey),
    unnamedActive: activeKey !== undefined && active === undefined,
    keys,
    switchedAt: state.vault.providers[id]?.switchedAt,
  }
}

/** Providers with an OpenCode credential or at least one vault key. */
export function configuredProviders(state: KeysState): ProviderSummary[] {
  const ids = new Set([...Object.keys(state.auth), ...Object.keys(state.vault.providers)])
  return [...ids].sort().map((id) => summarize(state, id))
}

export function searchProviders(state: KeysState, query: string, limit = 20): CatalogProvider[] {
  const needle = query.trim().toLowerCase()
  const all = Object.values(state.catalog)
  const hits = needle.length === 0
    ? all
    : all.filter((provider) =>
        provider.id.toLowerCase().includes(needle) ||
        provider.name.toLowerCase().includes(needle) ||
        provider.env.some((name) => name.toLowerCase().includes(needle)),
      )
  return hits.sort((a, b) => a.id.localeCompare(b.id)).slice(0, limit)
}

/** The provider's active key was switched after `sinceMs` (the running OpenCode's start). */
export function isPendingRestart(summary: ProviderSummary, sinceMs: number): boolean {
  return summary.switchedAt !== undefined && Date.parse(summary.switchedAt) > sinceMs
}

export interface KeysPlan {
  readonly provider: string
  readonly lines: readonly string[]
  readonly errors: readonly string[]
  readonly noop: boolean
  readonly vault?: Vault
  readonly auth?: AuthStore
  /** The change alters the key OpenCode uses, so OpenCode must restart. */
  readonly restartNeeded: boolean
  /** For restart notices: the key now active and the one it replaced. */
  readonly activated?: { readonly name: string; readonly masked: string }
  readonly previousName?: string
}

function errorPlan(provider: string, error: string): KeysPlan {
  return { provider, lines: [], errors: [error], noop: true, restartNeeded: false }
}

function withProvider(vault: Vault, id: string, update: (current: VaultProvider) => VaultProvider | undefined): Vault {
  const providers = { ...vault.providers }
  const next = update(providers[id] ?? { keys: [] })
  if (next === undefined || next.keys.length === 0) delete providers[id]
  else providers[id] = next
  return { version: 1, providers }
}

export function validateKeyName(name: string): string | undefined {
  return KEY_NAME_PATTERN.test(name) ? undefined : `名字 "${name}" 无效：需要 1–32 个字符，且不能包含空白`
}

export function suggestName(keys: readonly VaultKey[], base: string): string {
  const taken = new Set(keys.map((key) => key.name))
  if (!taken.has(base)) return base
  for (let index = 2; ; index++) {
    if (!taken.has(`${base}-${index}`)) return `${base}-${index}`
  }
}

function nowIso(): string {
  return new Date().toISOString()
}

function activeApiKey(state: KeysState, provider: string): string | undefined {
  const entry = state.auth[provider]
  return entry?.type === "api" && typeof entry.key === "string" ? entry.key : undefined
}

function providersHoldingKey(state: KeysState, key: string): string[] {
  const ids = new Set<string>()
  for (const id of Object.keys(state.auth)) if (activeApiKey(state, id) === key) ids.add(id)
  for (const [id, entry] of Object.entries(state.vault.providers)) if (entry.keys.some((k) => k.key === key)) ids.add(id)
  return [...ids].sort()
}

function adoptInto(state: KeysState, vault: Vault, provider: string, name: string): { vault: Vault; error?: string } {
  const key = activeApiKey(state, provider)
  if (key === undefined) return { vault, error: `${provider} 在 OpenCode 中没有 api key 可收录` }
  const keys = vault.providers[provider]?.keys ?? []
  if (keys.some((entry) => entry.key === key)) return { vault, error: `${provider} 的当前 key 已经收录为 "${keys.find((entry) => entry.key === key)?.name}"` }
  const invalid = validateKeyName(name)
  if (invalid !== undefined) return { vault, error: invalid }
  if (keys.some((entry) => entry.name === name)) {
    return { vault, error: `${provider} 已有名为 "${name}" 的 key；换一个名字，例如 "${suggestName(keys, name)}"` }
  }
  return {
    vault: withProvider(vault, provider, (current) => ({ ...current, keys: [...current.keys, { name, key, addedAt: nowIso() }] })),
  }
}

/**
 * Name OpenCode's current key for a provider (or every provider with
 * `provider: "*"`). The key is copied from `auth.json`; `auth.json` itself is
 * untouched, so no restart is needed.
 */
export function planAdopt(state: KeysState, provider: string, name = "default"): KeysPlan {
  if (provider === "*") {
    let vault = state.vault
    const lines: string[] = []
    for (const summary of configuredProviders(state)) {
      if (!summary.unnamedActive) continue
      const chosen = suggestName(vault.providers[summary.id]?.keys ?? [], name)
      const result = adoptInto(state, vault, summary.id, chosen)
      if (result.error !== undefined) return errorPlan(summary.id, result.error)
      vault = result.vault
      lines.push(`- ${summary.id}: 收录当前 key（${summary.activeMasked}）为 "${chosen}"`)
    }
    if (lines.length === 0) return { provider, lines: ["没有未命名的 key 需要收录。"], errors: [], noop: true, restartNeeded: false }
    return { provider, lines, errors: [], noop: false, vault, restartNeeded: false }
  }
  const summary = summarize(state, provider)
  if (!summary.unnamedActive) {
    const reason = summary.activeName !== undefined ? `当前 key 已收录为 "${summary.activeName}"` : "OpenCode 中没有该 provider 的 api key"
    return errorPlan(provider, `${provider}: ${reason}`)
  }
  const result = adoptInto(state, state.vault, provider, name)
  if (result.error !== undefined) return errorPlan(provider, result.error)
  return {
    provider,
    lines: [`- ${provider}: 收录当前 key（${summary.activeMasked}）为 "${name}"`],
    errors: [],
    noop: false,
    vault: result.vault,
    restartNeeded: false,
  }
}

function switchedVault(vault: Vault, provider: string): Vault {
  return withProvider(vault, provider, (current) => ({ ...current, switchedAt: nowIso() }))
}

/**
 * Make a named key OpenCode's active key for the provider. A current key the
 * vault does not hold blocks the switch unless `adoptAs` names it first, so a
 * switch never loses a key.
 */
export function planUse(state: KeysState, provider: string, name: string, adoptAs?: string): KeysPlan {
  const summary = summarize(state, provider)
  const target = summary.keys.find((key) => key.name === name)
  if (target === undefined) {
    const names = summary.keys.map((key) => key.name).join(", ")
    return errorPlan(provider, `${provider} 没有名为 "${name}" 的 key${names.length > 0 ? `；可选: ${names}` : "；请先添加 key"}`)
  }
  if (summary.authType !== undefined && summary.authType !== "api") {
    return errorPlan(provider, `${provider} 在 OpenCode 中是 ${summary.authType} 登录（不是 api key），不能用这里切换；如需改用 key，先运行 opencode auth logout ${provider}`)
  }
  if (activeApiKey(state, provider) === target.key) {
    return { provider, lines: [`${provider} 当前生效的就是 "${name}"（${maskKey(target.key)}），无需切换。`], errors: [], noop: true, restartNeeded: false }
  }
  let vault = state.vault
  const lines: string[] = []
  let previousName = summary.activeName
  if (summary.unnamedActive) {
    if (adoptAs === undefined) {
      return errorPlan(
        provider,
        `${provider} 当前生效的 key（${summary.activeMasked}）还没有名字，切换后会被覆盖。请先给它起名（例如 "${suggestName(summary.keys, "default")}"），再切换。`,
      )
    }
    const adopted = adoptInto(state, vault, provider, adoptAs)
    if (adopted.error !== undefined) return errorPlan(provider, adopted.error)
    vault = adopted.vault
    previousName = adoptAs
    lines.push(`- 先收录当前 key（${summary.activeMasked}）为 "${adoptAs}"`)
  }
  const from = summary.activeMasked === undefined ? "（无）" : `${previousName ?? "?"}（${summary.activeMasked}）`
  lines.push(`- ${provider}: ${from} -> ${name}（${maskKey(target.key)}）`)
  return {
    provider,
    lines,
    errors: [],
    noop: false,
    vault: switchedVault(vault, provider),
    auth: { ...state.auth, [provider]: { type: "api", key: target.key } },
    restartNeeded: true,
    activated: { name, masked: maskKey(target.key) },
    ...(previousName !== undefined ? { previousName } : {}),
  }
}

function missingKeyError(summary: ProviderSummary, name: string): string {
  const base = `${summary.id} 没有名为 "${name}" 的 key`
  const names = summary.keys.map((key) => key.name)
  if (summary.unnamedActive) {
    return `${base}。当前生效的 key（${summary.activeMasked}）还没有名字：给它起名请用"起名收录"（adopt），删除它请不带名字并选择同时从 OpenCode 移除（logout）`
  }
  return names.length > 0 ? `${base}（已有：${names.join(", ")}）` : `${base}；候选库中还没有 key`
}

export function planRename(state: KeysState, provider: string, name: string, newName: string): KeysPlan {
  const summary = summarize(state, provider)
  const keys = summary.keys
  if (!keys.some((key) => key.name === name)) return errorPlan(provider, missingKeyError(summary, name))
  const invalid = validateKeyName(newName)
  if (invalid !== undefined) return errorPlan(provider, invalid)
  if (name === newName) return { provider, lines: ["新旧名字相同，无需改名。"], errors: [], noop: true, restartNeeded: false }
  if (keys.some((key) => key.name === newName)) return errorPlan(provider, `${provider} 已有名为 "${newName}" 的 key`)
  return {
    provider,
    lines: [`- ${provider}: "${name}" 改名为 "${newName}"`],
    errors: [],
    noop: false,
    vault: withProvider(state.vault, provider, (current) => ({
      ...current,
      keys: current.keys.map((key) => (key.name === name ? { ...key, name: newName } : key)),
    })),
    restartNeeded: false,
  }
}

/**
 * Delete a named key. Deleting the active key needs an explicit `logout`
 * choice: `false` keeps OpenCode using it, `true` also removes it from
 * `auth.json`. An empty `name` targets an unnamed active key, which only
 * `logout` can delete because the vault holds no copy of it.
 */
export function planRemove(state: KeysState, provider: string, name: string, logout?: boolean): KeysPlan {
  const summary = summarize(state, provider)
  if (name === "") return planRemoveUnnamed(state, summary, logout)
  const target = summary.keys.find((key) => key.name === name)
  if (target === undefined) return errorPlan(provider, missingKeyError(summary, name))
  const vault = withProvider(state.vault, provider, (current) => ({ ...current, keys: current.keys.filter((key) => key.name !== name) }))
  const isActive = summary.activeName === name
  if (!isActive) {
    return { provider, lines: [`- ${provider}: 删除候选 "${name}"（${maskKey(target.key)}）`], errors: [], noop: false, vault, restartNeeded: false }
  }
  if (logout === undefined) {
    return errorPlan(
      provider,
      `"${name}" 是 ${provider} 当前生效的 key。请选择：只从候选库删除（OpenCode 继续使用它，logout=false），或同时从 OpenCode 移除（logout=true，之后该 provider 没有 key）`,
    )
  }
  if (!logout) {
    return {
      provider,
      lines: [`- ${provider}: 从候选库删除 "${name}"（${maskKey(target.key)}）；OpenCode 继续使用它（之后显示为未命名）`],
      errors: [],
      noop: false,
      vault,
      restartNeeded: false,
    }
  }
  const auth = { ...state.auth }
  delete auth[provider]
  return {
    provider,
    lines: [`- ${provider}: 删除 "${name}"（${maskKey(target.key)}），并从 OpenCode 移除（logout）`],
    errors: [],
    noop: false,
    vault: switchedVault(vault, provider),
    auth,
    restartNeeded: true,
    previousName: name,
  }
}

function planRemoveUnnamed(state: KeysState, summary: ProviderSummary, logout: boolean | undefined): KeysPlan {
  const provider = summary.id
  if (!summary.unnamedActive) {
    const reason = summary.activeName !== undefined ? `当前生效的 key 名为 "${summary.activeName}"` : "OpenCode 中没有该 provider 的 api key"
    return errorPlan(provider, `${provider}: 请指定要删除的 key 名字（${reason}）`)
  }
  if (logout !== true) {
    return errorPlan(
      provider,
      `${provider} 当前生效的 key（${summary.activeMasked}）没有名字、也不在候选库里，只能同时从 OpenCode 移除（logout=true）；想保留它请先起名收录（adopt）`,
    )
  }
  const auth = { ...state.auth }
  delete auth[provider]
  return {
    provider,
    lines: [
      `- ${provider}: 从 OpenCode 移除未命名的 key（${summary.activeMasked}），之后该 provider 没有 key`,
      "  这个 key 不在候选库里；删除后只能从 auth.json.bak 找回",
    ],
    errors: [],
    noop: false,
    vault: switchedVault(state.vault, provider),
    auth,
    restartNeeded: true,
  }
}

export interface AddKeyOptions {
  readonly use?: boolean
  readonly force?: boolean
  readonly adoptAs?: string
}

/** Add a named key (CLI only: key values never pass through the tool). */
export function planAdd(state: KeysState, provider: string, name: string, rawKey: string, options: AddKeyOptions = {}): KeysPlan {
  const key = rawKey.trim()
  if (key.length === 0) return errorPlan(provider, "key 为空")
  if (/\s/.test(key)) return errorPlan(provider, "key 中包含空白字符，请检查是否复制完整")
  const invalid = validateKeyName(name)
  if (invalid !== undefined) return errorPlan(provider, invalid)
  if (!options.force && state.catalog[provider] === undefined && state.auth[provider] === undefined) {
    return errorPlan(provider, `未知 provider "${provider}"（不在 OpenCode 的 provider 目录里）；确认 id 无误后加 --force`)
  }
  const summary = summarize(state, provider)
  if (summary.keys.some((entry) => entry.name === name)) {
    return errorPlan(provider, `${provider} 已有名为 "${name}" 的 key；换一个名字，例如 "${suggestName(summary.keys, name)}"`)
  }
  const duplicate = summary.keys.find((entry) => entry.key === key)
  if (duplicate !== undefined) return errorPlan(provider, `这个 key 已经保存为 "${duplicate.name}"`)
  if (summary.unnamedActive && activeApiKey(state, provider) === key) {
    return errorPlan(provider, `这个 key 就是 ${provider} 当前生效的未命名 key；给它起名请用"起名收录"（adopt ${provider} ${name}）`)
  }
  const elsewhere = providersHoldingKey(state, key).filter((id) => id !== provider)
  if (!options.force && elsewhere.length > 0) {
    return errorPlan(provider, `这个 key 已用于 ${elsewhere.join("、")}，可能选错了 provider；确认它确实也属于 ${provider} 后加 --force`)
  }
  const vault = withProvider(state.vault, provider, (current) => ({
    ...current,
    keys: [...current.keys, { name, key, addedAt: nowIso() }],
  }))
  const added: KeysPlan = {
    provider,
    lines: [`- ${provider}: 添加 "${name}"（${maskKey(key)}）`],
    errors: [],
    noop: false,
    vault,
    restartNeeded: false,
  }
  if (!options.use) return added
  const used = planUse({ ...state, vault }, provider, name, options.adoptAs)
  if (used.errors.length > 0) return { ...used, errors: [...used.errors, "（key 未保存；处理上面的问题后重试）"] }
  return { ...used, lines: [...added.lines, ...used.lines] }
}

async function writePrivate(path: string, text: string): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const tmp = `${path}.tmp`
  await writeFile(tmp, text, { encoding: "utf8", mode: 0o600 })
  await chmod(tmp, 0o600)
  await rename(tmp, path)
}

export interface KeysApplyResult {
  readonly authBackup: string | undefined
}

/** Write a plan: vault first, then `auth.json` (backed up to `auth.json.bak`). */
export async function applyKeysPlan(state: KeysState, plan: KeysPlan): Promise<KeysApplyResult> {
  if (plan.errors.length > 0) throw new Error(plan.errors.join("\n"))
  if (plan.noop) throw new Error("没有需要写入的改动")
  if (plan.vault !== undefined) await writePrivate(state.paths.vault, `${JSON.stringify(plan.vault, null, 2)}\n`)
  let authBackup: string | undefined
  if (plan.auth !== undefined) {
    const exists = await stat(state.paths.auth).then(() => true, () => false)
    if (exists) {
      authBackup = `${state.paths.auth}.bak`
      await copyFile(state.paths.auth, authBackup)
      await chmod(authBackup, 0o600)
    }
    await writePrivate(state.paths.auth, `${JSON.stringify(plan.auth, null, 2)}\n`)
  }
  return { authBackup }
}

export interface RestartNoticeOptions {
  /** How the user runs a switch: `/janus-config 切换` or the `janus-keys` CLI. */
  readonly switchCommand: (provider: string, name: string) => string
  readonly removeCommand: (provider: string, name: string) => string
  readonly statusCommand: (provider: string) => string
  readonly authBackup: string | undefined
  readonly opencodeRunning?: boolean
}

/** The fixed "state / next steps / rollback" notice after a credential change. */
export function restartNotice(plan: KeysPlan, options: RestartNoticeOptions): string {
  const backup = options.authBackup === undefined ? "" : `（备份为 ${options.authBackup}）`
  const lines: string[] = []
  if (plan.activated !== undefined) {
    const kept = plan.previousName === undefined ? "" : `原来的 ${plan.previousName} 仍保存在候选库中。`
    lines.push(`已切换：${plan.provider} 的生效 key 现在是 ${plan.activated.name}（${plan.activated.masked}）。${kept}`)
  } else {
    lines.push(`已移除：${plan.provider} 在 OpenCode 中不再有 key。`)
  }
  lines.push(`当前状态：已写入 OpenCode 的 auth.json${backup}。正在运行的 OpenCode 仍在使用旧的凭据。`)
  if (options.opencodeRunning === true) lines.push("检测到 OpenCode 正在运行。")
  lines.push(
    "下一步：",
    "  1. 完全退出 OpenCode（关闭所有 TUI 窗口和会话），再重新打开。",
  )
  if (plan.activated !== undefined) {
    lines.push(
      `  2. 重启后运行 ${options.statusCommand(plan.provider)}，确认"生效中"显示的是 ${plan.activated.name}。`,
      `  3. 或者直接用 ${plan.provider} 的模型发一条消息，能正常回复即说明切换成功。`,
    )
    const rollback =
      plan.previousName !== undefined
        ? `运行 ${options.switchCommand(plan.provider, plan.previousName)} 切回原 key`
        : `运行 ${options.removeCommand(plan.provider, plan.activated.name)} 撤销`
    lines.push(`如果失败（例如 401、key 无效）：${rollback}，然后再重启一次。`)
  } else {
    lines.push(`  2. 重启后运行 ${options.statusCommand(plan.provider)}，确认该 provider 已无生效 key。`)
    if (options.authBackup !== undefined) lines.push(`撤销：把 ${options.authBackup} 复制回 auth.json，然后再重启一次。`)
  }
  return lines.join("\n")
}
