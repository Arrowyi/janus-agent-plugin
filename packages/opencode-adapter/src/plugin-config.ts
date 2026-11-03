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
const roleCapsSchema = z
  .object({
  common_explorer: z.number().int().min(0).default(0),
  consultant_analyst: z.number().int().min(0).default(0),
  consultant_critic: z.number().int().min(0).default(0),
  coder_reviewer: z.number().int().min(0).default(0),
  consultant_auditor: z.number().int().min(0).default(0),
  author_writer: z.number().int().min(0).default(0),
  })
  .strict()

const CONFIG_ROLES = [
  "janus",
  "simple",
  "consultant",
  "architect",
  "coder",
  "author",
  "common-explorer",
  "consultant-auditor",
  "consultant-analyst",
  "consultant-critic",
  "coder-reviewer",
  "author-writer",
  "author-reviewer",
  "coder-lite",
] as const

const CONFIG_MODES = ["select", "verify", "roadmap", "research", "guide", "design", "doc"] as const
const CONFIG_TIERS = ["fast", "standard", "deep"] as const

/** Normalize a public mode input to its canonical name. */
export function normalizeConfigMode(value: string): ConfigMode | undefined {
  const normalized = value.trim().toLowerCase()
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

export const JanusPluginConfigSchema = z
  .object({
  $schema: z.string().optional(),
  janus_agent: z.string().default("janus"),
  janus_model: z.string().optional(),
  janus_enabled: z.boolean().default(true),
  // Simple quick-answer entry.
  simple_agent: z.string().default("simple"),
  simple_model: z.string().optional(),
  simple_enabled: z.boolean().default(true),
  simple_workspace_dir: z.string().min(1).optional(),
  consultant_agent: z.string().default("consultant"),
  consultant_model: z.string().optional(),
  // Architect: the design-team entry that writes design.md.
  architect_agent: z.string().default("architect"),
  architect_model: z.string().optional(),
  architect_enabled: z.boolean().default(true),
  coder_agent: z.string().default("coder"),
  coder_model: z.string().optional(),
  coder_enabled: z.boolean().default(true),
  // Author: the documentation-team entry that writes the author brief.
  author_agent: z.string().default("author"),
  author_model: z.string().optional(),
  author_enabled: z.boolean().default(true),
  // Shared research floor plus the consultation team's specialists.
  common_explorer_agent: z.string().default("common-explorer"),
  common_explorer_model: z.string().optional(),
  common_explorer_enabled: z.boolean().default(true),
  consultant_analyst_agent: z.string().default("consultant-analyst"),
  consultant_analyst_model: z.string().optional(),
  consultant_analyst_enabled: z.boolean().default(true),
  consultant_critic_agent: z.string().default("consultant-critic"),
  consultant_critic_model: z.string().optional(),
  consultant_critic_enabled: z.boolean().default(true),
  consultant_auditor_agent: z.string().default("consultant-auditor"),
  consultant_auditor_model: z.string().optional(),
  consultant_auditor_enabled: z.boolean().default(true),
  // coder's independent reviewer: design pre-mortems
  // and code/plan review.
  coder_reviewer_agent: z.string().default("coder-reviewer"),
  coder_reviewer_model: z.string().optional(),
  coder_reviewer_enabled: z.boolean().default(true),
  // author's scoped-write executor.
  author_writer_agent: z.string().default("author-writer"),
  author_writer_model: z.string().optional(),
  author_writer_enabled: z.boolean().default(true),
  // author's independent read-only document reviewer; separate from the
  // R&D coder-reviewer so document review never depends on a design.md
  // baseline or shares the writer's model family.
  author_reviewer_agent: z.string().default("author-reviewer"),
  author_reviewer_model: z.string().optional(),
  author_reviewer_enabled: z.boolean().default(true),
  // Project-relative directories the bundled writer may write approved
  // document files into. `[]` disables writer file writes (read-only
  // fallback: the writer returns prose and the author publishes).
  writer_docs_roots: z.array(z.string().min(1)).default(["userdoc"]),
  writer_delegate_agent: z.string().optional(),
  writer_delegate_model: z.string().optional(),
  coder_lite_agent: z.string().default("coder-lite"),
  coder_lite_model: z.string().optional(),
  coder_lite_enabled: z.boolean().default(true),
  // Optional per-mode and per-tier model overrides. Precedence at dispatch:
  // mode_models[mode][role] > tier_models[tier][role] > <role>_model >
  // TIER_MODEL_DEFAULTS[tier][role] > MODEL_DEFAULTS[role].
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
  .strict()

export type JanusPluginConfig = z.infer<typeof JanusPluginConfigSchema>

// Shipped defaults, tuned for an OpenCode Go Plus subscription plus the small
// Zen pay-per-use spend the review/audit seats need (2026-11-02).
//
// Pool economics: `deepseek-v4.1-flash`, `glm-5.3`, `glm-5.3-flash`,
// `gemini-4-argon`, `kimi-k3.1-pro`, and `grok-4.7` all route through
// `opencode-go`, so a Go Plus allowance absorbs their usage at a separate
// per-model monthly cap; `claude-sonnet-5-5` is Zen pay-per-use and stays on
// the low-frequency judgment seats. Concentrating the high-volume roles on the
// large `deepseek-v4.1-flash` / `glm-5.3-flash` caps keeps the small
// `gemini-4-argon` and `kimi-k3.1-pro` caps free for the seats that need them.
//
// Judgment/audit stays cross-family so a challenger never shares a family with
// the role it audits: consultant and architect/author are Google
// `gemini-4-argon` (AA index 53, lowest AA-Omniscience hallucination rate,
// 1M context, TB4.0 57.6% Vals); consultant-analyst is Moonshot
// `kimi-k3.1-pro` (AA-LCR 86.3%, GDPval-AA 1846, TB4.0 63.6% Vals);
// consultant-critic, coder-reviewer, and author-writer are Anthropic
// `claude-sonnet-5-5` (Vals Index 70.85%, TB4.0 64.1% Vals / 70.6% vendor,
// clean prose); consultant-auditor is xAI `grok-4.7` (AA-Briefcase 1657,
// AA-Omniscience hallucination 29% — the fourth family). The documentation
// team closes a three-family loop: Google editor-in-chief (`author`),
// Anthropic writer (`author-writer`), Moonshot reviewer (`author-reviewer`,
// `kimi-k3.1-pro` long-context close reading at one call per document).
//
// Coding: `coder` is `glm-5.3` (TB4.0 38.9% Vals) with a shipped deep-tier
// uplift to `kimi-k3.1-pro` for L3 work (see TIER_MODEL_DEFAULTS);
// `coder-lite` is `glm-5.3-flash` (TB4.0 37.4% Vals at $1.22 per run), the
// strongest small mechanical lane. Entry/retrieval: `janus` is
// `glm-5.3-flash` (latency and tool-call stability at a flat $0.15/$0.50) and
// `simple`/`common-explorer` are `deepseek-v4.1-flash` (1M context, largest Go
// Plus cap). Every role resolves to a single model with no fallback. An
// explicitly configured `consultant_model` still feeds architect and author
// (see resolveUserScalarRoleModel), and any user `<role>_model` beats a
// shipped tier default.
export const MODEL_DEFAULTS = {
  janus: "opencode-go/glm-5.3-flash",
  simple: "opencode-go/deepseek-v4.1-flash",
  consultant: "opencode-go/gemini-4-argon",
  architect: "opencode-go/gemini-4-argon",
  coder: "opencode-go/glm-5.3",
  author: "opencode-go/gemini-4-argon",
  "common-explorer": "opencode-go/deepseek-v4.1-flash",
  "consultant-auditor": "opencode-go/grok-4.7",
  "consultant-analyst": "opencode-go/kimi-k3.1-pro",
  "consultant-critic": "opencode/claude-sonnet-5-5",
  "coder-reviewer": "opencode/claude-sonnet-5-5",
  "author-writer": "opencode/claude-sonnet-5-5",
  "author-reviewer": "opencode-go/kimi-k3.1-pro",
  "coder-lite": "opencode-go/glm-5.3-flash",
} as const

export type ModelRole = keyof typeof MODEL_DEFAULTS
export type ConfigMode = (typeof CONFIG_MODES)[number]
export type ConfigTier = (typeof CONFIG_TIERS)[number]
export type RoleModelMap = Partial<Record<ModelRole, string>>

/**
 * Shipped per-tier model routing. A user `tier_models` entry or an explicit
 * `<role>_model` still wins; this only supplies the default the plugin runs
 * when the user has configured nothing. The single entry is coder's L3
 * uplift: L0-L2 coding stays on `glm-5.3` (`coder`'s scalar default) and a
 * `tier: "deep"` dispatch uses `kimi-k3.1-pro`, the strongest coding model in
 * the Go Plus pool (TB4.0 63.6% Vals).
 */
export const TIER_MODEL_DEFAULTS: Partial<Record<ConfigTier, RoleModelMap>> = {
  deep: {
    coder: "opencode-go/kimi-k3.1-pro",
  },
}

export interface RoleModelOptions {
  readonly mode?: ConfigMode
  readonly tier?: ConfigTier
}

/**
 * The user's explicitly configured scalar model for a role, or undefined when
 * the user configured nothing. Architect and author also inherit an explicitly
 * configured consultant model so an upgrade does not silently downgrade the
 * users who tuned it.
 */
function resolveUserScalarRoleModel(
  config: JanusPluginConfig,
  role: ModelRole,
): string | undefined {
  switch (role) {
    case "janus":
      return config.janus_model
    case "simple":
      return config.simple_model
    case "consultant":
      return config.consultant_model
    case "architect":
      return config.architect_model ?? config.consultant_model
    case "coder":
      return config.coder_model
    case "author":
      return config.author_model ?? config.consultant_model
    case "common-explorer":
      return config.common_explorer_model
    case "consultant-auditor":
      return config.consultant_auditor_model
    case "consultant-analyst":
      return config.consultant_analyst_model
    case "consultant-critic":
      return config.consultant_critic_model
    case "coder-reviewer":
      return config.coder_reviewer_model
    case "author-writer":
      return config.author_writer_model
    case "author-reviewer":
      return config.author_reviewer_model
    case "coder-lite":
      return config.coder_lite_model
  }
}

function resolveScalarRoleModel(config: JanusPluginConfig, role: ModelRole): string {
  return resolveUserScalarRoleModel(config, role) ?? MODEL_DEFAULTS[role]
}

/**
 * Resolve the model for a role with the configured precedence:
 * mode_models[mode][role] > tier_models[tier][role] > <role>_model >
 * TIER_MODEL_DEFAULTS[tier][role] > MODEL_DEFAULTS[role].
 *
 * The shipped tier default sits below the user's scalar model so an explicit
 * `<role>_model` choice is never silently overridden at dispatch time; a user
 * who wants a different tier model sets `tier_models` itself.
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
  const userScalar = resolveUserScalarRoleModel(config, role)
  if (userScalar !== undefined) return userScalar
  if (options.tier !== undefined) {
    const tierDefault = TIER_MODEL_DEFAULTS[options.tier]?.[role]
    if (tierDefault !== undefined) return tierDefault
  }
  return MODEL_DEFAULTS[role]
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
  common_explorer: number
  consultant_analyst: number
  consultant_critic: number
  coder_reviewer: number
  consultant_auditor: number
  author_writer: number
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
  fast: { common_explorer: 5, consultant_analyst: 0, consultant_critic: 0, coder_reviewer: 0, consultant_auditor: 0, author_writer: 0 },
  standard: { common_explorer: 5, consultant_analyst: 1, consultant_critic: 1, coder_reviewer: 1, consultant_auditor: 1, author_writer: 1 },
  deep: { common_explorer: 5, consultant_analyst: 3, consultant_critic: 2, coder_reviewer: 2, consultant_auditor: 2, author_writer: 2 },
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

  const result = JanusPluginConfigSchema.safeParse(parsed)
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
