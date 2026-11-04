import { copyFile, mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { dirname } from "node:path"
import { applyEdits, modify, type FormattingOptions } from "jsonc-parser"

import {
  fieldDefault,
  resolveField,
  roleFieldPrefix,
  splitKey,
  type ConfigField,
  type ResolvedField,
} from "./config-catalog.ts"
import { stripJsonc } from "./jsonc.ts"
import {
  CONFIG_ROLES,
  JanusPluginConfigSchema,
  TIER_MODEL_DEFAULTS,
  formatZodError,
  normalizeWriterDocsRoots,
  resolveCostGuardUsd,
  resolvePluginConfigPath,
  resolveRoleModel,
  resolveTeamCaps,
  resolveTierRoleCaps,
  type JanusPluginConfig,
  type ModelRole,
} from "./plugin-config.ts"

const FORMATTING: FormattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" }
const EMPTY_CONFIG_TEXT = "{}\n"

export interface ValidationResult {
  /** The user's object as written, without schema defaults. */
  readonly raw: Record<string, unknown> | undefined
  /** The validated config with defaults, when valid. */
  readonly config: JanusPluginConfig | undefined
  readonly errors: readonly string[]
}

export interface ConfigState extends ValidationResult {
  readonly path: string
  readonly exists: boolean
  readonly text: string
}

export type ConfigOp =
  | { readonly kind: "set"; readonly key: string; readonly value: string }
  | { readonly kind: "unset"; readonly key: string }
  | { readonly kind: "reset" }

export interface ValueChange {
  readonly key: string
  readonly before: unknown
  readonly after: unknown
}

export interface ChangePlan {
  readonly path: string
  readonly exists: boolean
  readonly before: string
  readonly after: string
  readonly changes: readonly ValueChange[]
  readonly diff: string
  readonly noop: boolean
  readonly errors: readonly string[]
}

export type FieldSource = "user" | "inherited" | "default" | "unset"

export interface EffectiveValue {
  readonly value: unknown
  readonly source: FieldSource
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function getAtPath(value: unknown, path: readonly string[]): unknown {
  let current = value
  for (const segment of path) {
    if (!isRecord(current)) return undefined
    current = current[segment]
  }
  return current
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b)
}

export function validateConfigText(text: string): ValidationResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(stripJsonc(text))
  } catch (e) {
    return { raw: undefined, config: undefined, errors: [`JSONC 解析失败: ${e instanceof Error ? e.message : String(e)}`] }
  }
  if (!isRecord(parsed)) {
    return { raw: undefined, config: undefined, errors: ["配置文件顶层必须是一个对象 {…}"] }
  }
  const result = JanusPluginConfigSchema.safeParse(parsed)
  if (!result.success) {
    return { raw: parsed, config: undefined, errors: [`schema 校验失败:\n${formatZodError(result.error)}`] }
  }
  try {
    normalizeWriterDocsRoots(result.data.writer_docs_roots)
  } catch (e) {
    return { raw: parsed, config: undefined, errors: [e instanceof Error ? e.message : String(e)] }
  }
  return { raw: parsed, config: result.data, errors: [] }
}

export async function readConfigState(env: NodeJS.ProcessEnv): Promise<ConfigState> {
  const path = resolvePluginConfigPath(env)
  if (path === undefined) {
    throw new Error("无法确定配置文件路径：JANUS_CONFIG、XDG_CONFIG_HOME、HOME 都未设置")
  }
  let text: string
  try {
    text = await readFile(path, "utf8")
  } catch {
    return { path, exists: false, text: "", raw: {}, config: JanusPluginConfigSchema.parse({}), errors: [] }
  }
  return { path, exists: true, text, ...validateConfigText(text) }
}

/** Convert a user-typed value into the field's JSON value. */
export function coerceValue(field: ConfigField, input: string): { ok: true; value: unknown } | { ok: false; error: string } {
  const text = input.trim()
  const fail = (error: string) => ({ ok: false as const, error })
  switch (field.type) {
    case "boolean": {
      const lowered = text.toLowerCase()
      if (["true", "on", "yes", "1", "开", "开启", "启用", "是"].includes(lowered)) return { ok: true, value: true }
      if (["false", "off", "no", "0", "关", "关闭", "停用", "禁用", "否"].includes(lowered)) return { ok: true, value: false }
      return fail(`${field.key} 只接受 true/false（开/关）`)
    }
    case "integer":
    case "number": {
      const value = Number(text)
      if (text.length === 0 || !Number.isFinite(value)) return fail(`${field.key} 需要一个数字`)
      if (field.type === "integer" && !Number.isInteger(value)) return fail(`${field.key} 需要一个整数`)
      return { ok: true, value }
    }
    case "string[]": {
      if (text.startsWith("[")) {
        try {
          const value: unknown = JSON.parse(text)
          if (Array.isArray(value) && value.every((item) => typeof item === "string")) return { ok: true, value }
        } catch {
          // fall through to the error below
        }
        return fail(`${field.key} 需要字符串数组，例如 ["docs","userdoc"]`)
      }
      if (["", "空", "无", "none"].includes(text)) return { ok: true, value: [] }
      return { ok: true, value: text.split(/[,，、\s]+/).filter((item) => item.length > 0) }
    }
    case "object":
    case "record": {
      try {
        const value: unknown = JSON.parse(text)
        if (isRecord(value)) return { ok: true, value }
      } catch {
        // fall through to the error below
      }
      return fail(`${field.key} 需要一个 JSON 对象，例如 ${field.example ?? "{…}"}`)
    }
    case "model":
    case "string": {
      let value = text
      if (text.startsWith("\"") && text.endsWith("\"") && text.length >= 2) {
        try {
          value = JSON.parse(text) as string
        } catch {
          return fail(`${field.key} 的引号不匹配`)
        }
      }
      if (field.type === "model" && !/^[^\s/]+\/\S+$/.test(value)) {
        return fail(`${field.key} 的模型格式应为 provider/model，例如 ${field.example ?? "opencode-go/glm-5.3"}`)
      }
      if (field.type === "string" && value.length === 0 && field.key !== "model_prompts.<model_key>") {
        return fail(`${field.key} 不能为空；想恢复默认请用 unset`)
      }
      return { ok: true, value }
    }
  }
}

function edit(text: string, path: readonly string[], value: unknown): string {
  const base = text.trim().length === 0 ? EMPTY_CONFIG_TEXT : text
  return applyEdits(base, modify(base, [...path], value, { formattingOptions: FORMATTING }))
}

/** Line diff: changed lines only, `-` before and `+` after, with line numbers. */
export function lineDiff(before: string, after: string): string {
  const a = before.length === 0 ? [] : before.replace(/\n$/, "").split("\n")
  const b = after.replace(/\n$/, "").split("\n")
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0))
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      const row = lcs[i] as number[]
      row[j] = a[i] === b[j] ? (lcs[i + 1]?.[j + 1] ?? 0) + 1 : Math.max(lcs[i + 1]?.[j] ?? 0, row[j + 1] ?? 0)
    }
  }
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      i++
      j++
    } else if (j < b.length && (i >= a.length || (lcs[i]?.[j + 1] ?? 0) >= (lcs[i + 1]?.[j] ?? 0))) {
      out.push(`+${String(j + 1).padStart(4)} | ${b[j]}`)
      j++
    } else {
      out.push(`-${String(i + 1).padStart(4)} | ${a[i]}`)
      i++
    }
  }
  return out.join("\n")
}

function finishPlan(
  state: ConfigState,
  after: string,
  changes: ValueChange[],
  extraErrors: string[] = [],
  textChangeOnly = false,
): ChangePlan {
  const noop =
    after === state.text ||
    (!textChangeOnly && changes.every((change) => deepEqual(change.before, change.after)))
  const validation = validateConfigText(after)
  return {
    path: state.path,
    exists: state.exists,
    before: state.text,
    after,
    changes,
    diff: noop ? "" : lineDiff(state.text, after),
    noop,
    errors: [...extraErrors, ...validation.errors],
  }
}

function errorPlan(state: ConfigState, error: string): ChangePlan {
  return { path: state.path, exists: state.exists, before: state.text, after: state.text, changes: [], diff: "", noop: true, errors: [error] }
}

/** Remove now-empty parent objects left behind by a deletion. */
function pruneEmptyParents(text: string, path: readonly string[]): string {
  let current = text
  for (let depth = path.length - 1; depth > 0; depth--) {
    const parent = path.slice(0, depth)
    const value = getAtPath(validateConfigText(current).raw, parent)
    if (!isRecord(value) || Object.keys(value).length > 0) break
    current = edit(current, parent, undefined)
  }
  return current
}

function planSet(state: ConfigState, resolved: ResolvedField, input: string): ChangePlan {
  const coerced = coerceValue(resolved.field, input)
  if (!coerced.ok) return errorPlan(state, coerced.error)
  const key = resolved.path.join(".")
  const before = effectiveValue(state, resolved.path).value
  let text = state.text
  const seed = resolved.field.seedParent
  if (seed !== undefined && getAtPath(state.raw, splitKey(seed.key)) === undefined) {
    text = edit(text, splitKey(seed.key), seed.value)
  }
  if (deepEqual(before, coerced.value)) {
    return { ...finishPlan(state, state.text, []), noop: true }
  }
  return finishPlan(state, edit(text, resolved.path, coerced.value), [{ key, before, after: coerced.value }])
}

function planUnset(state: ConfigState, key: string): ChangePlan {
  const resolved = resolveField(key)
  const path = resolved?.path ?? splitKey(key.trim())
  const before = getAtPath(state.raw, path)
  if (before === undefined) {
    if (resolved === undefined) return errorPlan(state, `未知配置项 "${key}"；用 catalog 查看可配置项`)
    return { ...finishPlan(state, state.text, []), noop: true }
  }
  const seed = resolved?.field.seedParent
  if (resolved !== undefined && seed !== undefined) {
    const restored = fieldDefault(resolved)
    let text = edit(state.text, path, restored)
    const seedPath = splitKey(seed.key)
    if (deepEqual(getAtPath(validateConfigText(text).raw, seedPath), seed.value)) {
      text = edit(text, seedPath, undefined)
    }
    return finishPlan(state, text, [{ key: path.join("."), before, after: restored }], [], true)
  }
  const text = pruneEmptyParents(edit(state.text, path, undefined), path)
  const restored = resolved === undefined ? undefined : fieldDefault(resolved)
  return finishPlan(state, text, [{ key: path.join("."), before, after: restored }], [], true)
}

/**
 * Preview a change against the current file. The plan carries the full new
 * text, a line diff, and the validation errors of the result; it never
 * touches disk.
 */
export function planChange(state: ConfigState, op: ConfigOp): ChangePlan {
  if (op.kind === "reset") {
    const isEmpty = state.raw !== undefined && Object.keys(state.raw).length === 0
    if (isEmpty && state.text.trim() === "{}") return { ...finishPlan(state, state.text, []), noop: true }
    return finishPlan(state, EMPTY_CONFIG_TEXT, [{ key: "(全部)", before: state.raw ?? state.text, after: {} }])
  }
  if (op.kind === "unset") return planUnset(state, op.key)
  const resolved = resolveField(op.key)
  if (resolved === undefined) return errorPlan(state, `未知配置项 "${op.key}"；用 catalog 查看可配置项`)
  return planSet(state, resolved, op.value)
}

export interface ApplyResult {
  readonly path: string
  readonly backupPath: string | undefined
}

/**
 * Write a validated plan: back up the existing file to `<path>.bak`, write a
 * temp file, rename it into place, and read it back.
 */
export async function applyChange(plan: ChangePlan): Promise<ApplyResult> {
  if (plan.errors.length > 0) throw new Error(`改动未通过校验，未写入:\n${plan.errors.join("\n")}`)
  if (plan.noop) throw new Error("没有需要写入的改动")
  await mkdir(dirname(plan.path), { recursive: true })
  let backupPath: string | undefined
  if (plan.exists) {
    backupPath = `${plan.path}.bak`
    await copyFile(plan.path, backupPath)
  }
  const tmp = `${plan.path}.tmp`
  await writeFile(tmp, plan.after, "utf8")
  await rename(tmp, plan.path)
  const written = await readFile(plan.path, "utf8")
  if (written !== plan.after) throw new Error(`回读内容与预期不一致：${plan.path}`)
  return { path: plan.path, backupPath }
}

function modelRoleFor(key: string): ModelRole | undefined {
  return CONFIG_ROLES.find((role) => `${roleFieldPrefix(role)}_model` === key)
}

/** The value the plugin actually runs with for a path, and where it comes from. */
export function effectiveValue(state: ConfigState, path: readonly string[]): EffectiveValue {
  const config = state.config ?? JanusPluginConfigSchema.parse({})
  const userValue = getAtPath(state.raw, path)
  if (userValue !== undefined) return { value: userValue, source: "user" }

  const top = path[0] ?? ""
  const role = path.length === 1 ? modelRoleFor(top) : undefined
  if (role !== undefined) {
    const value = resolveRoleModel(config, role)
    const inherited = (role === "architect" || role === "author") && config.consultant_model !== undefined
    return { value, source: inherited ? "inherited" : "default" }
  }
  let value: unknown
  if (top === "team_caps") value = getAtPath(resolveTeamCaps(config), path.slice(1))
  else if (top === "tier_role_caps") value = getAtPath(resolveTierRoleCaps(config), path.slice(1))
  else if (top === "cost_guard_provider_usd") value = resolveCostGuardUsd(config)
  else if (top === "tier_models") value = getAtPath(config.tier_models, path.slice(1)) ?? getAtPath(TIER_MODEL_DEFAULTS, path.slice(1))
  else value = getAtPath(config, path)
  return { value, source: value === undefined ? "unset" : "default" }
}

/** Every concrete path the user has set, including nested map entries. */
export function userSetPaths(raw: Record<string, unknown> | undefined): string[][] {
  const out: string[][] = []
  const walk = (value: unknown, path: string[]) => {
    const resolved = path.length > 0 ? resolveField(path.join(".")) : undefined
    const isLeaf = resolved !== undefined && resolved.field.type !== "object" && resolved.field.type !== "record"
    if (path.length > 0 && (isLeaf || !isRecord(value))) {
      out.push(path)
      return
    }
    if (isRecord(value)) for (const [key, child] of Object.entries(value)) walk(child, [...path, key])
  }
  walk(raw, [])
  return out
}
