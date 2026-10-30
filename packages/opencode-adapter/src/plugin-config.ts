import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"

import { stripJsonc } from "./jsonc.ts"

export { stripJsonc }

/**
 * Zod schema for the janus-agent plugin config.
 *
 * Loaded from `$JANUS_CONFIG` or
 * `$XDG_CONFIG_HOME/janus-agent/config.jsonc` or
 * `~/.config/janus-agent/config.jsonc`.
 */
const roleCapsSchema = z.object({
  explorer: z.number().int().min(0).default(0),
  analyst: z.number().int().min(0).default(0),
  critic: z.number().int().min(0).default(0),
  arch_critic: z.number().int().min(0).default(0),
  auditor: z.number().int().min(0).default(0),
  writer: z.number().int().min(0).default(0),
})

const CONFIG_ROLES = [
  "janus",
  "ask-lite",
  "consultant",
  "coder",
  "explorer",
  "auditor",
  "analyst",
  "critic",
  "arch-critic",
  "writer",
  "coder-lite",
] as const

const CONFIG_MODES = ["select", "verify", "roadmap", "research", "guide", "design", "doc"] as const
const CONFIG_TIERS = ["fast", "standard", "deep"] as const

/** Normalize a public mode input, accepting the legacy plan/author names. */
export function normalizeConfigMode(value: string): ConfigMode | undefined {
  const normalized = value.trim().toLowerCase()
  if (normalized === "plan") return "roadmap"
  if (normalized === "author") return "doc"
  return (CONFIG_MODES as readonly string[]).includes(normalized)
    ? (normalized as ConfigMode)
    : undefined
}

const roleModelMapShape = Object.fromEntries(
  CONFIG_ROLES.map((role) => [role, z.string().optional()]),
) as Record<(typeof CONFIG_ROLES)[number], z.ZodOptional<z.ZodString>>

const RoleModelMapSchema = z.object(roleModelMapShape).strict()

const ModeModelsSchema = z
  .object(Object.fromEntries(CONFIG_MODES.map((mode) => [mode, RoleModelMapSchema.optional()])))
  .strict()

const TierModelsSchema = z
  .object(Object.fromEntries(CONFIG_TIERS.map((tier) => [tier, RoleModelMapSchema.optional()])))
  .strict()

export const JanusPluginConfigSchema = z.object({
  janus_agent: z.string().default("janus"),
  janus_model: z.string().optional(),
  janus_enabled: z.boolean().default(true),
  consultant_agent: z.string().default("consultant"),
  consultant_model: z.string().optional(),
  critic_agent: z.string().default("critic"),
  critic_model: z.string().optional(),
  critic_enabled: z.boolean().default(true),
  auditor_agent: z.string().default("auditor"),
  auditor_model: z.string().optional(),
  auditor_enabled: z.boolean().default(true),
  arch_critic_agent: z.string().default("arch-critic"),
  arch_critic_model: z.string().optional(),
  arch_critic_enabled: z.boolean().default(true),
  explorer_agent: z.string().default("explorer"),
  explorer_model: z.string().optional(),
  explorer_enabled: z.boolean().default(true),
  analyst_agent: z.string().default("analyst"),
  analyst_model: z.string().optional(),
  analyst_enabled: z.boolean().default(true),
  writer_agent: z.string().default("writer"),
  writer_model: z.string().optional(),
  writer_enabled: z.boolean().default(true),
  // Project-relative directories the bundled writer may write approved
  // document files into. `[]` disables writer file writes (read-only
  // fallback: the writer returns prose and the consultant publishes).
  writer_docs_roots: z.array(z.string().min(1)).default(["userdoc"]),
  writer_delegate_agent: z.string().optional(),
  writer_delegate_model: z.string().optional(),
  coder_agent: z.string().default("coder"),
  coder_model: z.string().optional(),
  coder_enabled: z.boolean().default(true),
  ask_lite_agent: z.string().default("ask-lite"),
  ask_lite_model: z.string().optional(),
  ask_lite_enabled: z.boolean().default(true),
  ask_lite_workspace_dir: z.string().min(1).optional(),
  coder_lite_agent: z.string().default("coder-lite"),
  coder_lite_model: z.string().optional(),
  coder_lite_enabled: z.boolean().default(true),
  // Optional per-mode and per-tier model overrides. Precedence at dispatch:
  // mode_models[mode][role] > tier_models[tier][role] > <role>_model >
  // MODEL_DEFAULTS[role].
  mode_models: ModeModelsSchema.optional(),
  tier_models: TierModelsSchema.optional(),
  // Global model-adaptation prompt map, keyed by the provider-agnostic
  // normalized model key (see normalizeModelKey: provider prefix stripped,
  // lowercased, alphanumerics only). An explicit "" disables that model's
  // block; the plugin otherwise falls back to its shipped
  // assets/model-prompts library.
  model_prompts: z.record(z.string()).optional(),
  team_caps: z
    .object({
      round_cap: z.number().int().positive(),
      explorer_cap: z.number().int().positive(),
      critic_search_cap: z.number().int().positive(),
    })
    .optional(),
  tier_role_caps: z
    .object({
      fast: roleCapsSchema,
      standard: roleCapsSchema,
      deep: roleCapsSchema,
    })
    .optional(),
  cost_guard_provider_usd: z.number().positive().optional(),
  install_skill: z.boolean().default(true),
  install_commands: z.boolean().default(true),
  memory_enabled: z.boolean().default(true),
  embedding: z
    .object({
      base_url: z.string(),
      api_key_env: z.string(),
      model: z.string(),
      dimensions: z.number(),
    })
    .optional(),
})

export type JanusPluginConfig = z.infer<typeof JanusPluginConfigSchema>

/**
 * Legacy config keys accepted as aliases. New keys win when both are present;
 * the alias is applied before Zod defaults so a defaulted new key cannot shadow
 * a user's old value.
 */
export const LEGACY_CONFIG_ALIASES: Readonly<Record<string, string>> = {
  agent_model: "consultant_model",
  lite_agent: "ask_lite_agent",
  lite_model: "ask_lite_model",
  lite_enabled: "ask_lite_enabled",
  lite_workspace_dir: "ask_lite_workspace_dir",
  verifier_agent: "auditor_agent",
  verifier_model: "auditor_model",
  verifier_enabled: "auditor_enabled",
}

const LEGACY_ROLE_ALIASES: Readonly<Record<string, string>> = {
  verifier: "auditor",
  lite: "ask-lite",
  arch_critic: "arch-critic",
  coder_lite: "coder-lite",
  ask_lite: "ask-lite",
}

const LEGACY_MODE_ALIASES: Readonly<Record<string, string>> = {
  plan: "roadmap",
  author: "doc",
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function renameKeys(
  value: unknown,
  aliases: Readonly<Record<string, string>>,
): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined
  const entries = Object.entries(value)
  const isLegacy = (key: string) => aliases[key] !== undefined
  const out: Record<string, unknown> = {}

  // Canonical (new) keys win regardless of object iteration order. Apply them
  // first, then fill only the canonical slots that are still empty from the
  // legacy aliases.
  for (const [key, entry] of entries) {
    if (!isLegacy(key)) out[key] = entry
  }
  for (const [key, entry] of entries) {
    if (!isLegacy(key)) continue
    const canonical = aliases[key]!
    if (out[canonical] === undefined) out[canonical] = entry
  }
  return out
}

/**
 * Normalize legacy config keys and role/mode map keys before schema parsing.
 * New keys always win over their old aliases.
 */
export function normalizeConfigAliases(raw: unknown): unknown {
  if (!isRecord(raw)) return raw
  const out: Record<string, unknown> = { ...raw }

  for (const [legacy, canonical] of Object.entries(LEGACY_CONFIG_ALIASES)) {
    if (out[canonical] === undefined && out[legacy] !== undefined) out[canonical] = out[legacy]
    delete out[legacy]
  }

  // build_* was removed with the host build role; leave the keys to Zod's
  // default stripping so old configs keep loading.
  delete out.build_agent
  delete out.build_model
  delete out.build_enabled

  if (isRecord(out.mode_models)) {
    const modes = renameKeys(out.mode_models, LEGACY_MODE_ALIASES) ?? {}
    out.mode_models = Object.fromEntries(
      Object.entries(modes).map(([mode, map]) => [mode, renameKeys(map, LEGACY_ROLE_ALIASES) ?? map]),
    )
  }
  if (isRecord(out.tier_models)) {
    out.tier_models = Object.fromEntries(
      Object.entries(out.tier_models).map(([tier, map]) => [tier, renameKeys(map, LEGACY_ROLE_ALIASES) ?? map]),
    )
  }
  if (isRecord(out.tier_role_caps)) {
    out.tier_role_caps = Object.fromEntries(
      Object.entries(out.tier_role_caps).map(([tier, caps]) => [
        tier,
        isRecord(caps) ? renameKeys(caps, { verifier: "auditor", "arch-critic": "arch_critic", arch_critic: "arch_critic" }) ?? caps : caps,
      ]),
    )
  }
  return out
}

// Cross-family audit structure: challenger (gemini) ≠ consultant (glm) ≠
// analyst (qwen), so the challenge roles never share a model family with the
// roles they audit — independent audit is restored. critic, auditor, and
// arch-critic share gemini-3.8-flash (judgment ceiling: GPQA 95.3 / HLE 47.8 /
// ARC-AGI-2 89.2), running on Zen pay-per-use ($1.50/$7.50) rather than a Go
// pool — accepted because they are read-only, low-frequency challenge roles
// (tier caps: fast 0 / standard 1 / deep 2), where judgment quality outranks
// pool accounting. consultant runs glm-5.3 (TB4.0 41.8%, strongest
// hard-agentic; the previous deepseek-v4-pro default was EOL-tracked — DeepSeek
// routes it to V4.1-Flash). consultant and explorer route through
// `opencode-go` so a Go/Go Plus subscription allowance absorbs their usage
// (DeepSeek is served there at the same price as the direct API, with a
// monthly per-model allowance). analyst is qwen3.8-max (qwen3.7-max was
// retired from Go). explorer and ask-lite share deepseek-v4.1-flash. writer is
// claude-sonnet-5-5 (TB4.0 70.6% vs 5's 12.4% — the previous
// claude-sonnet-5 default's reputation collapsed) and, like every role,
// resolves to a single model with no fallback. ask-lite is the economical
// quick-answer entry on V4.1-Flash. coder is the judgment-heavy coding entry,
// defaulting to the same strong agentic model as the consultant; coder-lite is
// the mechanical lane on GLM-5.3-Flash (agentic-strong at half of
// V4.1-Flash's peak price). The host build role was removed; coder owns
// heavy coding and can take a deep-tier model override.
export const MODEL_DEFAULTS = {
  janus: "opencode-go/glm-5.3",
  "ask-lite": "opencode-go/deepseek-v4.1-flash",
  consultant: "opencode-go/glm-5.3",
  coder: "opencode-go/glm-5.3",
  explorer: "opencode-go/deepseek-v4.1-flash",
  auditor: "opencode/gemini-3.8-flash",
  analyst: "opencode-go/qwen3.8-max",
  critic: "opencode/gemini-3.8-flash",
  "arch-critic": "opencode/gemini-3.8-flash",
  writer: "opencode/claude-sonnet-5-5",
  "coder-lite": "opencode-go/glm-5.3-flash",
} as const

export type ModelRole = keyof typeof MODEL_DEFAULTS
export type ConfigMode = (typeof CONFIG_MODES)[number]
export type ConfigTier = (typeof CONFIG_TIERS)[number]
export type RoleModelMap = Partial<Record<ModelRole, string>>

export interface RoleModelOptions {
  readonly mode?: ConfigMode
  readonly tier?: ConfigTier
}

function resolveScalarRoleModel(config: JanusPluginConfig, role: ModelRole): string {
  switch (role) {
    case "janus":
      return config.janus_model ?? MODEL_DEFAULTS.janus
    case "ask-lite":
      return config.ask_lite_model ?? MODEL_DEFAULTS["ask-lite"]
    case "consultant":
      return config.consultant_model ?? MODEL_DEFAULTS.consultant
    case "coder":
      return config.coder_model ?? MODEL_DEFAULTS.coder
    case "explorer":
      return config.explorer_model ?? MODEL_DEFAULTS.explorer
    case "auditor":
      return config.auditor_model ?? MODEL_DEFAULTS.auditor
    case "analyst":
      return config.analyst_model ?? MODEL_DEFAULTS.analyst
    case "critic":
      return config.critic_model ?? MODEL_DEFAULTS.critic
    case "arch-critic":
      return config.arch_critic_model ?? MODEL_DEFAULTS["arch-critic"]
    case "writer":
      return config.writer_model ?? MODEL_DEFAULTS.writer
    case "coder-lite":
      return config.coder_lite_model ?? MODEL_DEFAULTS["coder-lite"]
  }
}

/**
 * Resolve the model for a role with the configured precedence:
 * mode_models[mode][role] > tier_models[tier][role] > <role>_model >
 * MODEL_DEFAULTS[role].
 */
export function resolveRoleModel(
  config: JanusPluginConfig,
  role: ModelRole,
  options: RoleModelOptions = {},
): string {
  if (options.mode !== undefined) {
    const modeModel = config.mode_models?.[options.mode]?.[role]
    if (modeModel !== undefined) return modeModel
  }
  if (options.tier !== undefined) {
    const tierModel = config.tier_models?.[options.tier]?.[role]
    if (tierModel !== undefined) return tierModel
  }
  return resolveScalarRoleModel(config, role)
}

export function resolveRoleModelChain(
  config: JanusPluginConfig,
  role: ModelRole,
  options: RoleModelOptions = {},
): string[] {
  return [resolveRoleModel(config, role, options)]
}

export interface TeamCapsConfig {
  round_cap: number
  explorer_cap: number
  critic_search_cap: number
}

export interface RoleCapsConfig {
  explorer: number
  analyst: number
  critic: number
  arch_critic: number
  auditor: number
  writer: number
}

export interface TierRoleCapsConfig {
  fast: RoleCapsConfig
  standard: RoleCapsConfig
  deep: RoleCapsConfig
}

export const TEAM_CAPS_DEFAULTS: TeamCapsConfig = {
  round_cap: 3,
  explorer_cap: 5,
  critic_search_cap: 5,
}

export const TIER_ROLE_CAPS_DEFAULTS: TierRoleCapsConfig = {
  fast: { explorer: 5, analyst: 0, critic: 0, arch_critic: 0, auditor: 0, writer: 0 },
  standard: { explorer: 5, analyst: 1, critic: 1, arch_critic: 1, auditor: 1, writer: 1 },
  deep: { explorer: 5, analyst: 3, critic: 2, arch_critic: 2, auditor: 2, writer: 2 },
}

export const COST_GUARD_USD_DEFAULT = 10

export function resolveTeamCaps(config: JanusPluginConfig): TeamCapsConfig {
  const caps = config.team_caps
  return {
    round_cap: caps?.round_cap ?? TEAM_CAPS_DEFAULTS.round_cap,
    explorer_cap: caps?.explorer_cap ?? TEAM_CAPS_DEFAULTS.explorer_cap,
    critic_search_cap: caps?.critic_search_cap ?? TEAM_CAPS_DEFAULTS.critic_search_cap,
  }
}

export function resolveTierRoleCaps(config: JanusPluginConfig): TierRoleCapsConfig {
  const tiers = config.tier_role_caps
  return {
    fast: tiers?.fast ?? TIER_ROLE_CAPS_DEFAULTS.fast,
    standard: tiers?.standard ?? TIER_ROLE_CAPS_DEFAULTS.standard,
    deep: tiers?.deep ?? TIER_ROLE_CAPS_DEFAULTS.deep,
  }
}

export function resolveCostGuardUsd(config: JanusPluginConfig): number {
  return config.cost_guard_provider_usd ?? COST_GUARD_USD_DEFAULT
}

/**
 * Normalize `writer_docs_roots` entries into clean project-relative paths.
 *
 * Per root: trim whitespace, strip leading `./`, strip trailing `/`. Reject
 * empty strings, absolute paths (POSIX or Windows-style), `~` shortcuts, any
 * `..` segment, and a root that normalizes to `.` or empty (the whole
 * project is never a writer root). Nested relative paths such as
 * `docs/guides` are allowed. Throws an Error naming the invalid root.
 */
export function normalizeWriterDocsRoots(roots: string[]): string[] {
  const normalized: string[] = []
  for (const root of roots) {
    let candidate = root.trim()
    if (candidate.length === 0) {
      throw new Error(`invalid writer_docs_roots root "${root}": an empty string is not a valid root`)
    }
    while (candidate.startsWith("./")) candidate = candidate.slice(2)
    candidate = candidate.replace(/\/+$/, "")
    if (candidate.startsWith("/") || candidate.startsWith("\\\\") || /^[a-zA-Z]:[\\/]/.test(candidate)) {
      throw new Error(
        `invalid writer_docs_roots root "${root}": absolute paths are not allowed; use a project-relative path`,
      )
    }
    if (candidate === "~" || candidate.startsWith("~/") || candidate.startsWith("~\\")) {
      throw new Error(
        `invalid writer_docs_roots root "${root}": "~" shortcuts are not allowed; use a project-relative path`,
      )
    }
    if (candidate === ".." || candidate.split(/[\\/]/).includes("..")) {
      throw new Error(
        `invalid writer_docs_roots root "${root}": ".." segments are not allowed; a root must stay inside the project`,
      )
    }
    if (candidate.length === 0 || candidate === ".") {
      throw new Error(
        `invalid writer_docs_roots root "${root}": the whole project is not a valid writer root`,
      )
    }
    normalized.push(candidate)
  }
  return normalized
}

/**
 * Resolve the plugin config file path from environment variables.
 *
 * Priority: `$JANUS_CONFIG` >
 * `$XDG_CONFIG_HOME/janus-agent/config.jsonc` >
 * `~/.config/janus-agent/config.jsonc`.
 *
 * Returns `undefined` when no path can be derived (no HOME and no
 * XDG_CONFIG_HOME and no JANUS_CONFIG).
 */
export function resolvePluginConfigPath(env: NodeJS.ProcessEnv): string | undefined {
  if (env.JANUS_CONFIG && env.JANUS_CONFIG.length > 0) {
    return env.JANUS_CONFIG
  }
  const xdg = env.XDG_CONFIG_HOME
  if (xdg && xdg.length > 0) {
    return join(xdg, "janus-agent", "config.jsonc")
  }
  const home = env.HOME
  if (!home || home.length === 0) return undefined
  return join(home, ".config", "janus-agent", "config.jsonc")
}

function formatZodError(error: z.ZodError): string {
  return error.issues
    .map((issue) => `  at ${issue.path.join(".")}: ${issue.message}`)
    .join("\n")
}

/**
 * Load and validate the janus-agent plugin config.
 *
 * A missing config file is tolerated and yields the schema defaults.
 * An invalid config (unparseable JSON or failed zod validation) throws
 * an `Error` with a message that names the config file path.
 */
export async function loadPluginConfig(env: NodeJS.ProcessEnv): Promise<JanusPluginConfig> {
  const configPath = resolvePluginConfigPath(env)

  if (!configPath) {
    return JanusPluginConfigSchema.parse({})
  }

  let rawText: string
  try {
    rawText = await readFile(configPath, "utf8")
  } catch {
    return JanusPluginConfigSchema.parse({})
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(stripJsonc(rawText))
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    throw new Error(`janus-agent config: invalid JSON in ${configPath}: ${detail}`)
  }

  const result = JanusPluginConfigSchema.safeParse(normalizeConfigAliases(parsed))
  if (!result.success) {
    throw new Error(
      `janus-agent config: invalid configuration in ${configPath}:\n${formatZodError(result.error)}`,
    )
  }

  // Root-level semantic validation beyond the schema shape, so an invalid
  // writer root fails config load with a message that names the file.
  try {
    normalizeWriterDocsRoots(result.data.writer_docs_roots)
  } catch (e) {
    const detail = e instanceof Error ? e.message : String(e)
    throw new Error(`janus-agent config: ${detail} (in ${configPath})`)
  }

  return result.data
}
