import { mkdirSync, realpathSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { homedir } from "node:os"
import { basename, join, resolve } from "node:path"
import { createHash } from "node:crypto"
import { resolveAsset } from "./asset-paths.ts"
import {
  normalizeWriterDocsRoots,
  resolveCostGuardUsd,
  resolveRoleModel,
  resolveTeamCaps,
  resolveTierRoleCaps,
  type JanusPluginConfig,
} from "./plugin-config.ts"

interface MutableConfig {
  agent?: Record<string, unknown>
}

interface ConsultantAgentEntry {
  mode: "primary"
  prompt: string
  model: string
  permission: Record<string, unknown>
}

interface SubagentEntry {
  mode: "subagent"
  description: string
  prompt: string
  model: string
  permission: Record<string, string>
}

const RUNTIME_BINDINGS_PLACEHOLDER = /<!--\s*RUNTIME-BINDINGS[\s\S]*?-->/

const MODEL_PROMPT_PLACEHOLDER = /<!--\s*MODEL-PROMPT[\s\S]*?-->/

const COMMON_BASE_ASSET = "principles/common-base.md"

const COMMON_WRITE_ASSET = "principles/common-write.md"

const RESEARCH_LEAF_ASSET = "principles/research-leaf.md"

const DISPATCH_HUB_ASSET = "principles/dispatch-hub.md"

const MODE_ROUTING_ASSET = "principles/mode-routing.md"

const REASONING_FAILURES_ASSET = "principles/reasoning-failures.md"

const CLAIM_TYPES_ASSET = "principles/claim-types.md"

const EXPLORER_DESCRIPTION =
  "Search and information-gathering specialist. Gathers graded sources for specific claims and returns a structured report. Dispatched by the consultant and may fan out to multiple instances."

const ANALYST_DESCRIPTION =
  "Independent analysis pass. Reasons over gathered evidence when interpretation, conflicting sources, or important trade-offs could change the conclusion; returns a structured analysis. Model diversity is a runtime property reported in bindings, not a role guarantee."

const CRITIC_DESCRIPTION =
  "Adversarial counter-evidence reviewer. Independently searches for opposing, qualifying, and superseding sources when a consequential conclusion or uncertain plan step needs challenge; runs design pre-mortems for one-way decisions and reports only correctness-affecting problems."

const VERIFIER_DESCRIPTION =
  "Source intent and influence specialist. Audits user reviews, promotional claims, and purportedly independent third-party material when sponsorship, coordination, or provenance is relevant or uncertain; reports observable signals and missing evidence rather than assuming clean."

const WRITER_DESCRIPTION =
  "Scoped-write author executor for `author` consultations and the sole author of reader-facing prose. Produces the pre-approval writing blueprint, drafts and maintains approved document files under the configured writer roots, and runs coherence and editorial passes; targeted web lookups with a source ledger only — no shell, no dispatch, no memory."

const LITE_DESCRIPTION =
  "Economical quick-answer entry (DeepSeek V4.1-Flash by default) for low-risk facts, concepts, and simple how-to. A leaf: never dispatches; escalates multi-source/contested questions to the consultant, coding to the coder, and general questions to janus."

const CODER_DESCRIPTION =
  "Coding entry point and execution specialist. Owns coding, debugging, refactoring, tests, and repository work; selects a direct, brief-plan, design-gate, or quality-gate process by task weight; dispatches coder-lite for mechanical work and build for an optional stronger model."

const CODER_LITE_DESCRIPTION =
  "Cheap mechanical coding executor (GLM-5.3-Flash by default) for fully specified, decision-free, mechanically repeatable coding tasks: batch renames/moves, copy-adapt from existing in-repo patterns, formatting and lint fixes, boilerplate from explicit templates, simple tests following existing patterns, spec-complete CRUD glue. Stops and reports up on anything ambiguous, judgment-heavy, debugging, protocol-precision, cross-module, or security-sensitive — never attempts them."

const JANUS_DESCRIPTION =
  "Daily-driver primary and default entry point. Handles general questions, light tasks, and routing: dispatches consultant for evidence work, coder for coding, and lite for quick answers. Does not do deep research or heavy coding itself."

interface CodingLaneEntry {
  mode: "subagent"
  description: string
  prompt: string
  model: string
  steps: number
  permission: Record<string, unknown>
}

export const READONLY_BASH_RULES: Record<string, "allow"> = {
  ls: "allow",
  "ls *": "allow",
  pwd: "allow",
  "echo *": "allow",
  "cat *": "allow",
  "head *": "allow",
  "tail *": "allow",
  "wc *": "allow",
  "file *": "allow",
  "stat *": "allow",
  "du *": "allow",
  "df *": "allow",
  "which *": "allow",
  whoami: "allow",
  id: "allow",
  date: "allow",
  "date *": "allow",
  uname: "allow",
  "uname *": "allow",
  printenv: "allow",
  "printenv *": "allow",
  "git status": "allow",
  "git status *": "allow",
  "git log": "allow",
  "git log *": "allow",
  "git diff": "allow",
  "git diff *": "allow",
  "git show": "allow",
  "git show *": "allow",
}

interface AllModeAgentEntry {
  mode: "all"
  description: string
  prompt: string
  model: string
  permission: Record<string, unknown>
}

/**
 * Resolve lite's pre-approved writable workspace directory:
 * `lite_workspace_dir` > `$XDG_DATA_HOME/janus-agent/lite` >
 * `$HOME/.local/share/janus-agent/lite`.
 */
export function resolveLiteWorkspaceDir(
  pluginConfig: JanusPluginConfig,
  env: NodeJS.ProcessEnv = process.env,
): string {
  if (pluginConfig.lite_workspace_dir !== undefined) return pluginConfig.lite_workspace_dir
  const home = env.HOME !== undefined && env.HOME.length > 0 ? env.HOME : homedir()
  const dataHome =
    env.XDG_DATA_HOME !== undefined && env.XDG_DATA_HOME.length > 0
      ? env.XDG_DATA_HOME
      : join(home, ".local", "share")
  return join(dataHome, "janus-agent", "lite")
}

/**
 * Resolve the fixed author state directory:
 * `$XDG_DATA_HOME/janus-agent/author` > `$HOME/.local/share/janus-agent/author`.
 * The consultant writes author briefs there; the writer only reads them.
 */
export function resolveAuthorStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME !== undefined && env.HOME.length > 0 ? env.HOME : homedir()
  const dataHome =
    env.XDG_DATA_HOME !== undefined && env.XDG_DATA_HOME.length > 0
      ? env.XDG_DATA_HOME
      : join(home, ".local", "share")
  return join(dataHome, "janus-agent", "author")
}

/**
 * Resolve the fixed design state directory:
 * `$XDG_DATA_HOME/janus-agent/design` > `$HOME/.local/share/janus-agent/design`.
 * The consultant writes design records there; the coder only reads them.
 */
export function resolveDesignStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const home = env.HOME !== undefined && env.HOME.length > 0 ? env.HOME : homedir()
  const dataHome =
    env.XDG_DATA_HOME !== undefined && env.XDG_DATA_HOME.length > 0
      ? env.XDG_DATA_HOME
      : join(home, ".local", "share")
  return join(dataHome, "janus-agent", "design")
}

/**
 * Compute the stable per-project id used in author brief paths:
 * sanitized project basename + first 8 hex of a sha256 over the resolved
 * absolute directory, e.g. `my-project-a1b2c3d4`. Same directory always
 * yields the same id; two projects sharing a basename differ in the hash.
 */
export function computeProjectId(directory: string): string {
  const absolute = resolve(directory)
  const sanitized = basename(absolute)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+/, "")
    .replace(/-+$/, "")
  const base = sanitized.length > 0 ? sanitized : "project"
  const hash = createHash("sha256").update(absolute).digest("hex").slice(0, 8)
  return `${base}-${hash}`
}

/**
 * lite's permissions: read tools allowed, its own workspace writable
 * without asking, everything else asks, and dispatch denied (leaf node).
 * Pattern objects put the `"*"` catch-all first (last matching rule wins).
 */
export function buildLitePermission(workspaceDir: string): Record<string, unknown> {
  return {
    webfetch: "allow",
    websearch: "allow",
    edit: { "*": "ask", [`${workspaceDir}/**`]: "allow" },
    bash: { "*": "ask", ...READONLY_BASH_RULES },
    external_directory: { [`${workspaceDir}/**`]: "allow" },
    task: "deny",
  }
}

/**
 * Build the runtime bindings block injected into the lite agent prompt.
 * Reports the memory MCP server, lite's model, the escalation targets, the
 * pre-approved workspace, the memory namespace, and the leaf rule.
 */
export function buildLiteRuntimeBindings(
  pluginConfig: JanusPluginConfig,
  workspaceDir: string,
  namespace: string,
): string {
  const memoryLine = pluginConfig.memory_enabled
    ? "- Memory MCP server name: `janus-memory` (tools: memory_recall, memory_expand, memory_prepare, memory_commit, memory_manage)"
    : "- Memory: DISABLED by configuration (saving and recall are unavailable)"

  const modelLine = `- Lite model: \`${resolveRoleModel(pluginConfig, "lite")}\``

  const consultantLine = `- Consultant: \`consultant\` (\`${resolveRoleModel(pluginConfig, "consultant")}\`) — escalate multi-source evidence, decisions, and documents`
  const coderLine = `- Coder: \`${pluginConfig.coder_agent}\` (\`${resolveRoleModel(pluginConfig, "coder")}\`) — escalate coding and repository work`
  const janusLine = `- Janus: \`${pluginConfig.janus_agent}\` (\`${resolveRoleModel(pluginConfig, "janus")}\`) — escalate general questions that need more context`

  const workspaceLine = `- Your writable workspace: \`${workspaceDir}\` — the only location where creating files is pre-approved; every other write asks first`

  const namespaceLine = `- Memory namespace: \`${namespace}\``

  return `## Runtime Bindings (injected by opencode-adapter)\n${memoryLine}\n${modelLine}\n${consultantLine}\n${coderLine}\n${janusLine}\n- You are a leaf: do not dispatch another agent; escalate instead.\n${workspaceLine}\n${namespaceLine}`
}

/**
 * Register the `lite` agent (mode "all": user-selectable entry, but a leaf
 * that never dispatches). Reads `assets/agents/lite.md`, injects the runtime
 * bindings block, attempts to create the workspace directory (non-fatal), and
 * never clobbers a pre-existing user-defined entry.
 */
export async function registerLite(
  config: MutableConfig,
  pluginConfig: JanusPluginConfig,
  namespace: string,
): Promise<void> {
  const agentName = pluginConfig.lite_agent
  if (config.agent?.[agentName]) return

  const workspaceDir = resolveLiteWorkspaceDir(pluginConfig)
  try {
    mkdirSync(workspaceDir, { recursive: true })
  } catch {
    // Non-fatal: the permission pattern still ships; writes there may fail.
  }

  const assembledPrompt = await assemblePrompt(pluginConfig, {
    assetFile: "agents/lite.md",
    model: resolveRoleModel(pluginConfig, "lite"),
    runtimeBlock: buildLiteRuntimeBindings(pluginConfig, workspaceDir, namespace),
  })

  const entry: AllModeAgentEntry = {
    mode: "all",
    description: LITE_DESCRIPTION,
    prompt: assembledPrompt,
    model: resolveRoleModel(pluginConfig, "lite"),
    permission: buildLitePermission(workspaceDir),
  }

  if (!config.agent) config.agent = {}
  config.agent[agentName] = entry
}

/**
 * Shared job-tool discipline line for every dispatching role's runtime
 * bindings. The consultant appends its author-mode writer-session rule.
 */
const DISPATCH_JOB_TOOLS_LINE =
  "- Job tools: `janus_dispatch` (role, prompt; optional `return_handle: true` returns a completed envelope with `job_id`, `session_id`, and the success `text`) uses a soft wait; pending/unknown is not failure. Continue the same job with `janus_dispatch_wait` (job_id, wait_ms?; integer 0..300000, default 300000; 0 snapshots). Only `janus_dispatch_cancel` (job_id) requests cancellation; cancelling is not confirmed cancellation. `janus_dispatch_continue` (session_id, prompt, role?) sends a new prompt to an existing idle dispatch session from the same caller and workspace; never re-dispatch a pending job and never continue a pending job — wait on it first."

const CONSULTANT_WRITER_SESSION_LINE =
  " In author mode, store the first writer dispatch envelope's `session_id` as `writer_session_id` in the brief and use `janus_dispatch_continue` for that document's maintenance edits (one writer session per document, no cross-document reuse); on a lost, foreign, or busy writer session, wait or make a fresh dispatch with the brief and update the stored id."

/**
 * coder's runtime bindings: its own model, the coding lanes it may dispatch,
 * and the job-tool discipline. No memory namespace (coding sessions use the
 * repo's AGENTS.md, not consultation memory).
 */
export function buildCoderRuntimeBindings(
  pluginConfig: JanusPluginConfig,
  design?: DesignBinding,
): string {
  const modelLine = `- Coder model: \`${resolveRoleModel(pluginConfig, "coder")}\``
  const coderLiteLine = pluginConfig.coder_lite_enabled
    ? `- Mechanical lane: \`${pluginConfig.coder_lite_agent}\` (\`${resolveRoleModel(pluginConfig, "coder-lite")}\`) for fully specified mechanical coding and file tasks`
    : "- Mechanical lane: coder-lite DISABLED by configuration"
  const buildLine = pluginConfig.build_enabled
    ? `- Optional stronger-model lane: role \`build\` routes to agent \`${pluginConfig.build_agent}\` (\`${pluginConfig.build_model ?? "host default model"}\`)`
    : "- Optional stronger-model lane: build DISABLED by configuration"
  const designLine =
    design !== undefined
      ? `- Design record: \`${design.designStateDir}/${design.projectId}\` — read \`design.md\` and write \`plan.md\` there; you never edit \`design.md\``
      : undefined
  const dispatchLine = DISPATCH_JOB_TOOLS_LINE
  const lines = [modelLine, coderLiteLine, buildLine]
  if (designLine !== undefined) lines.push(designLine)
  lines.push(dispatchLine)
  return `## Runtime Bindings (injected by opencode-adapter)\n${lines.join("\n")}`
}

/**
 * Register the `coder` coding entry (mode "all": user-selectable primary and
 * dispatchable subagent). Full host permissions; it is a primary execution
 * seat, not a read-only specialist.
 */
export async function registerCoder(
  config: MutableConfig,
  pluginConfig: JanusPluginConfig,
  directory?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (config.agent?.[pluginConfig.coder_agent]) return

  const designStateDir = resolveDesignStateDir(env)
  const design: DesignBinding | undefined =
    directory !== undefined
      ? { designStateDir, projectId: computeProjectId(directory) }
      : undefined
  const assembledPrompt = await assemblePrompt(pluginConfig, {
    assetFile: "agents/coder.md",
    model: resolveRoleModel(pluginConfig, "coder"),
    fragments: [DISPATCH_HUB_ASSET],
    runtimeBlock: buildCoderRuntimeBindings(pluginConfig, design),
  })

  const entry: AllModeAgentEntry = {
    mode: "all",
    description: CODER_DESCRIPTION,
    prompt: assembledPrompt,
    model: resolveRoleModel(pluginConfig, "coder"),
    permission: { external_directory: { [`${designStateDir}/**`]: "allow" } },
  }

  if (!config.agent) config.agent = {}
  config.agent[pluginConfig.coder_agent] = entry
}

/**
 * coder-lite's permissions: workspace edits allowed without asking (the edit
 * resource is location-relative for workspace paths, so "*" matches them and
 * the later "/*" rule only matches external absolute paths), external edits
 * ask, read-only bash allowed, everything else asks, and further subagent
 * dispatch is denied (leaf node).
 */
export function buildCoderLitePermission(): Record<string, unknown> {
  return {
    edit: { "*": "allow", "/*": "ask" },
    bash: { "*": "ask", ...READONLY_BASH_RULES },
    webfetch: "allow",
    websearch: "allow",
    task: "deny",
  }
}

/**
 * Register the `coder-lite` mechanical coding lane: mode "subagent", a static
 * prompt (leaf node — never dispatches, so no runtime bindings block), a
 * step cap of 50 with report-up, and the workspace-allow permission set.
 * A pre-existing user-defined entry under the same name is left untouched.
 */
export async function registerCoderLite(
  config: MutableConfig,
  pluginConfig: JanusPluginConfig,
): Promise<void> {
  const agentName = pluginConfig.coder_lite_agent
  if (config.agent?.[agentName]) return

  const prompt = await assemblePrompt(pluginConfig, {
    assetFile: "agents/coder-lite.md",
    model: resolveRoleModel(pluginConfig, "coder-lite"),
  })

  const entry: CodingLaneEntry = {
    mode: "subagent",
    description: CODER_LITE_DESCRIPTION,
    prompt,
    model: resolveRoleModel(pluginConfig, "coder-lite"),
    steps: 50,
    permission: buildCoderLitePermission(),
  }

  if (!config.agent) config.agent = {}
  config.agent[agentName] = entry
}

/**
 * Build the runtime bindings block injected into the janus agent prompt.
 *
 * Janus is the daily-driver primary and does not attach to memory, so its
 * block reports only what it needs to orchestrate: its own model, the
 * entry/specialist targets it routes to (consultant, coder, lite, explorer),
 * and the dispatch job-tool discipline. No memory namespace, no workspace.
 */
export function buildJanusRuntimeBindings(pluginConfig: JanusPluginConfig): string {
  const modelLine = `- Janus model: \`${resolveRoleModel(pluginConfig, "janus")}\``

  const consultantLine = `- \`consultant\` (agent \`consultant\`, \`${resolveRoleModel(pluginConfig, "consultant")}\`) — evidence-graded research, decisions, durable documents; dispatch via \`janus_dispatch\` (role="consultant")`
  const coderLine = `- \`coder\` (agent \`${pluginConfig.coder_agent}\`, \`${resolveRoleModel(pluginConfig, "coder")}\`) — coding, debugging, refactoring, tests, repo work; dispatch via \`janus_dispatch\` (role="coder")`
  const liteLine = pluginConfig.lite_enabled
    ? `- \`lite\` (agent \`${pluginConfig.lite_agent}\`, \`${resolveRoleModel(pluginConfig, "lite")}\`) — quick facts, concepts, simple how-to`
    : "- Economical entry: lite DISABLED by configuration"
  const explorerLine = `- \`explorer\` (agent \`${pluginConfig.explorer_agent}\`, \`${resolveRoleModel(pluginConfig, "explorer")}\`) — bounded evidence gathering with a specific claim list and search plan`

  const dispatchLine = DISPATCH_JOB_TOOLS_LINE

  return `## Runtime Bindings (injected by opencode-adapter)\n${modelLine}\n${consultantLine}\n${coderLine}\n${liteLine}\n${explorerLine}\n${dispatchLine}`
}

/**
 * Register the `janus` daily-driver primary agent: mode "all" (user-selectable
 * primary AND dispatchable), no memory attachment, a layered prompt (role
 * asset + model-adaptation block + common base + common write + runtime bindings), and
 * the resolved janus model. A pre-existing user-defined entry under the same
 * name is left untouched.
 */
export async function registerJanus(
  config: MutableConfig,
  pluginConfig: JanusPluginConfig,
): Promise<void> {
  if (config.agent?.[pluginConfig.janus_agent]) return

  const assembledPrompt = await assemblePrompt(pluginConfig, {
    assetFile: "agents/janus.md",
    model: resolveRoleModel(pluginConfig, "janus"),
    fragments: [DISPATCH_HUB_ASSET, MODE_ROUTING_ASSET],
    runtimeBlock: buildJanusRuntimeBindings(pluginConfig),
  })

  const entry: AllModeAgentEntry = {
    mode: "all",
    description: JANUS_DESCRIPTION,
    prompt: assembledPrompt,
    model: resolveRoleModel(pluginConfig, "janus"),
    permission: {},
  }

  if (!config.agent) config.agent = {}
  config.agent[pluginConfig.janus_agent] = entry
}

/**
 * Author binding lines for the consultant runtime bindings: where the author
 * brief lives and which write mode the bundled writer runs in. Supplied by
 * the adapter when the project directory is known; omitted otherwise.
 */
export interface AuthorBinding {
  authorStateDir: string
  projectId: string
}

/**
 * Design binding lines: the fixed design state dir and the project id whose
 * directory holds this project's design records. Supplied when the project
 * directory is known; omitted otherwise.
 */
export interface DesignBinding {
  designStateDir: string
  projectId: string
}

/**
 * Build the runtime bindings block that the adapter injects into the
 * consultant agent prompt.
 *
 * Reports: the memory MCP server (or DISABLED), the consultant model, the
 * team subagents with their models, the writer write mode and author brief
 * location, and the memory namespace.
 */
export function buildRuntimeBindings(
  pluginConfig: JanusPluginConfig,
  namespace: string,
  author?: AuthorBinding,
  design?: DesignBinding,
): string {
  const memoryLine = pluginConfig.memory_enabled
    ? "- Memory MCP server name: `janus-memory` (tools: memory_recall, memory_expand, memory_prepare, memory_commit, memory_manage)"
    : "- Memory: DISABLED by configuration (saving and recall are unavailable)"

  const consultantModelLine = `- Consultant model: \`${resolveRoleModel(pluginConfig, "consultant")}\``

  const roleParts = [
    `explorer \`${pluginConfig.explorer_agent}\` (${resolveRoleModel(pluginConfig, "explorer")})`,
    `analyst \`${pluginConfig.analyst_agent}\` (${resolveRoleModel(pluginConfig, "analyst")})`,
  ]
  roleParts.push(
    pluginConfig.critic_enabled
      ? `critic \`${pluginConfig.critic_agent}\` (${resolveRoleModel(pluginConfig, "critic")})`
      : "critic DISABLED by configuration",
  )
  roleParts.push(
    pluginConfig.verifier_enabled
      ? `verifier \`${pluginConfig.verifier_agent}\` (${resolveRoleModel(pluginConfig, "verifier")})`
      : "verifier DISABLED by configuration",
  )
  roleParts.push(
    pluginConfig.writer_delegate_agent !== undefined
      ? `writer delegated to \`${pluginConfig.writer_delegate_agent}\``
      : pluginConfig.writer_enabled
        ? `writer \`${pluginConfig.writer_agent}\` (${resolveRoleModel(pluginConfig, "writer")})`
        : "writer DISABLED by configuration",
  )
  const teamLine = `- Team subagents: ${roleParts.join(", ")}`

  const liteLine = pluginConfig.lite_enabled
    ? `- Economical leaf: \`${pluginConfig.lite_agent}\` (\`${resolveRoleModel(pluginConfig, "lite")}\`) for bounded quick-answer tasks`
    : "- Economical leaf: lite DISABLED by configuration"
  const coderLine = pluginConfig.coder_enabled
    ? `- Coding delegate: \`${pluginConfig.coder_agent}\` (\`${resolveRoleModel(pluginConfig, "coder")}\`) for code examples and bounded code tasks; it owns the coding lanes`
    : "- Coding delegate: coder DISABLED by configuration"

  const caps = resolveTeamCaps(pluginConfig)
  const tiers = resolveTierRoleCaps(pluginConfig)
  const costGuard = resolveCostGuardUsd(pluginConfig)

  const capsLine = `- Team maximums (not targets): round_cap=${caps.round_cap}, explorer<=${caps.explorer_cap}, critic_searches<=${caps.critic_search_cap} per round`
  const tierMatrixLine = `- Tier role maximums (not a required roster): fast(e${tiers.fast.explorer},a${tiers.fast.analyst},c${tiers.fast.critic},v${tiers.fast.verifier},w${tiers.fast.writer}) standard(e${tiers.standard.explorer},a${tiers.standard.analyst},c${tiers.standard.critic},v${tiers.standard.verifier},w${tiers.standard.writer}) deep(e${tiers.deep.explorer},a${tiers.deep.analyst},c${tiers.deep.critic},v${tiers.deep.verifier},w${tiers.deep.writer})`
  const costLine = `- Cost guard: ~$${costGuard} per provider (advisory, converge when approaching)`

  const namespaceLine = `- Memory namespace: \`${namespace}\``
  const dispatchLine = DISPATCH_JOB_TOOLS_LINE + CONSULTANT_WRITER_SESSION_LINE

  const writerRoots = normalizeWriterDocsRoots(pluginConfig.writer_docs_roots)
  const writerModeLine =
    writerRoots.length > 0
      ? `- Writer write mode: \`scoped\` — the writer is the sole author of reader-facing prose and the sole writer of approved document files under ${writerRoots.map((root) => `\`${root}\``).join(", ")} (\`writer_docs_roots\`); you do not edit those roots in scoped mode`
      : "- Writer write mode: `read-only` (`writer_docs_roots` is empty) — the writer returns prose or patches; you apply and publish the returned text as the disclosed publisher"

  const authorLine =
    author !== undefined
      ? `- Author state dir: \`${author.authorStateDir}\`; project id: \`${author.projectId}\` — create and update the author brief at \`${author.authorStateDir}/${author.projectId}/<docId>/brief.md\`; the writer reads it and never writes it`
      : undefined

  const designLine =
    design !== undefined
      ? `- Design state dir: \`${design.designStateDir}\`; project id: \`${design.projectId}\` — designs live at \`${design.designStateDir}/${design.projectId}/<designId>/design.md\`; you write and maintain the design record, the coder reads it`
      : undefined

  const lines = [
    "## Runtime Bindings (injected by opencode-adapter)",
    memoryLine,
    consultantModelLine,
    teamLine,
    liteLine,
    coderLine,
    dispatchLine,
    capsLine,
    tierMatrixLine,
    costLine,
    writerModeLine,
    ...(authorLine !== undefined ? [authorLine] : []),
    ...(designLine !== undefined ? [designLine] : []),
    namespaceLine,
  ]
  return lines.join("\n")
}

/**
 * Inject the runtime bindings block into the consultant prompt body.
 *
 * If the body contains a `<!-- RUNTIME-BINDINGS ... -->` placeholder
 * comment, it is replaced by the block. Otherwise the block is appended
 * at the end of the body.
 */
export function injectRuntimeBindings(body: string, runtimeBlock: string): string {
  if (RUNTIME_BINDINGS_PLACEHOLDER.test(body)) {
    return body.replace(RUNTIME_BINDINGS_PLACEHOLDER, runtimeBlock)
  }
  return body + "\n\n" + runtimeBlock
}

/**
 * Normalize a model id ("provider/model") into a provider-agnostic match key.
 *
 * The key strips the provider prefix (everything up to and including the last
 * "/"), lowercases the remainder, and keeps only ASCII letters and digits —
 * so `deepseek/deepseek-v4-pro` and `opencode-go/deepseek-v4-pro` both resolve
 * to `deepseekv4pro`, and the same model-prompt block drives either provider.
 * The shipped library files (`assets/model-prompts/<key>.md`) and the
 * `model_prompts` config keys use this exact normalized form.
 */
export function normalizeModelKey(modelId: string): string {
  return modelId
    .slice(modelId.lastIndexOf("/") + 1)
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "")
}

/**
 * Resolve the model-adaptation block for a model, keyed by the model itself
 * and decoupled from both the agent and the provider: the user's global
 * `model_prompts` map wins (keyed by the normalized model key; an explicit ""
 * disables that model's block), else the shipped
 * `assets/model-prompts/<key>.md` block if a file for the model exists, else
 * empty.
 */
export async function resolveModelPrompt(
  pluginConfig: JanusPluginConfig,
  resolvedModel: string,
): Promise<string> {
  const key = normalizeModelKey(resolvedModel)
  const override = pluginConfig.model_prompts?.[key]
  if (override !== undefined) return override
  try {
    return await readFile(resolveAsset(`model-prompts/${key}.md`), "utf8")
  } catch {
    return ""
  }
}

/**
 * Inject the model-adaptation block into an agent asset body. An empty block
 * returns the body unchanged (the placeholder comment stays inert), so
 * no-block assembly is byte-identical to the raw asset.
 */
export function injectModelPrompt(body: string, block: string): string {
  if (block.length === 0) return body
  if (MODEL_PROMPT_PLACEHOLDER.test(body)) {
    return body.replace(MODEL_PROMPT_PLACEHOLDER, block)
  }
  return `${body}\n\n## Driving This Model\n\n${block}`
}

/**
 * Load the shared baseline block injected into every plugin-owned agent
 * prompt. Reads `assets/principles/common-base.md`; a missing asset is a
 * deployment error and propagates.
 */
export async function loadCommonBase(): Promise<string> {
  return readFile(resolveAsset(COMMON_BASE_ASSET), "utf8")
}

/**
 * Load the shared write-discipline block (persistent file-change
 * confirmation). Reads `assets/principles/common-write.md`; read-only roles
 * omit it.
 */
export async function loadCommonWrite(): Promise<string> {
  return readFile(resolveAsset(COMMON_WRITE_ASSET), "utf8")
}

/**
 * Append one shared principle block to an assembled prompt body. An empty
 * block returns the body unchanged. Used for the common-base and
 * common-write layers in assembly order.
 */
export function injectCommonPrinciples(body: string, block: string): string {
  if (block.trim().length === 0) return body
  return `${body}\n\n${block.trim()}`
}

/**
 * Load a shared principle fragment (a file under `assets/principles/`).
 * A missing or empty fragment is a deployment error and propagates.
 */
async function loadPrincipleFragment(asset: string): Promise<string> {
  const text = (await readFile(resolveAsset(asset), "utf8")).trim()
  if (text.length === 0) throw new Error(`prompt fragment ${asset} is empty`)
  return text
}

interface PromptAssembly {
  assetFile: string
  model: string
  fragments?: readonly string[]
  /** Shared baseline block; defaults to true. */
  includeCommonBase?: boolean
  /** Persistent file-change gate; defaults to true, false for read-only roles. */
  includeCommonWrite?: boolean
  runtimeBlock?: string
}

/**
 * Assemble one role prompt in the fixed layer order:
 * role asset -> model-adaptation block -> principle fragments -> common-base
 * -> common-write -> runtime bindings.
 *
 * Read-only roles omit only the common-write layer, which they can never act
 * on. Fragment-free assemblies stay byte-identical to the previous
 * per-register sequence, so adding the helper does not move existing text.
 */
async function assemblePrompt(
  pluginConfig: JanusPluginConfig,
  options: PromptAssembly,
): Promise<string> {
  let prompt = injectModelPrompt(
    await readFile(resolveAsset(options.assetFile), "utf8"),
    await resolveModelPrompt(pluginConfig, options.model),
  )
  for (const fragment of options.fragments ?? []) {
    prompt = `${prompt}\n\n${await loadPrincipleFragment(fragment)}`
  }
  if (options.includeCommonBase !== false) {
    prompt = injectCommonPrinciples(prompt, await loadCommonBase())
  }
  if (options.includeCommonWrite !== false) {
    prompt = injectCommonPrinciples(prompt, await loadCommonWrite())
  }
  return options.runtimeBlock === undefined
    ? prompt
    : injectRuntimeBindings(prompt, options.runtimeBlock)
}

/**
 * Register the `consultant` primary agent into the OpenCode config.
 *
 * Reads `assets/agents/consultant.md`, injects the runtime bindings block
 * (including the author state dir, project id, and writer write mode when
 * the project `directory` is supplied), and sets `config.agent["consultant"]`
 * with `mode: "primary"` and the resolved consultant model. A pre-existing
 * user-defined `consultant` agent entry is left untouched (never clobbered).
 */
export async function registerConsultantAgent(
  config: MutableConfig,
  pluginConfig: JanusPluginConfig,
  namespace: string,
  directory?: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  if (config.agent?.["consultant"]) return

  const authorStateDir = resolveAuthorStateDir(env)
  const designStateDir = resolveDesignStateDir(env)
  for (const dir of [authorStateDir, designStateDir]) {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      // Non-fatal: the permission still ships; the write may ask later.
    }
  }
  const projectId = directory !== undefined ? computeProjectId(directory) : undefined
  const author: AuthorBinding | undefined =
    projectId !== undefined ? { authorStateDir, projectId } : undefined
  const design: DesignBinding | undefined =
    projectId !== undefined ? { designStateDir, projectId } : undefined
  const assembledPrompt = await assemblePrompt(pluginConfig, {
    assetFile: "agents/consultant.md",
    model: resolveRoleModel(pluginConfig, "consultant"),
    fragments: [DISPATCH_HUB_ASSET, MODE_ROUTING_ASSET],
    runtimeBlock: buildRuntimeBindings(pluginConfig, namespace, author, design),
  })

  const entry: ConsultantAgentEntry = {
    mode: "primary",
    prompt: assembledPrompt,
    model: resolveRoleModel(pluginConfig, "consultant"),
    permission: {
      external_directory: {
        [`${authorStateDir}/**`]: "allow",
        [`${designStateDir}/**`]: "allow",
      },
    },
  }

  if (!config.agent) config.agent = {}
  config.agent["consultant"] = entry
}

/**
 * Register a read-only team subagent. Reads the role asset, sets
 * `mode: "subagent"`, a fixed model, a description, and a `permission.edit`
 * of "deny" so the role can gather and critique but never edit. Read-only
 * roles keep the common baseline but skip the common-write gate. A
 * pre-existing user-defined entry under the same name is left untouched.
 */
async function registerReadOnlySubagent(
  config: MutableConfig,
  options: {
    name: string
    description: string
    assetFile: string
    model: string
    pluginConfig: JanusPluginConfig
    /** Extra principle fragments appended after the research-leaf fragment. */
    extraFragments?: readonly string[]
  },
): Promise<void> {
  if (config.agent?.[options.name]) return

  const prompt = await assemblePrompt(options.pluginConfig, {
    assetFile: options.assetFile,
    model: options.model,
    fragments: [RESEARCH_LEAF_ASSET, ...(options.extraFragments ?? [])],
    includeCommonWrite: false,
  })

  const entry: SubagentEntry = {
    mode: "subagent",
    description: options.description,
    prompt,
    model: options.model,
    permission: { edit: "deny", bash: "deny", task: "deny" },
  }

  if (!config.agent) config.agent = {}
  config.agent[options.name] = entry
}

export async function registerExplorer(
  config: MutableConfig,
  pluginConfig: JanusPluginConfig,
): Promise<void> {
  await registerReadOnlySubagent(config, {
    name: pluginConfig.explorer_agent,
    description: EXPLORER_DESCRIPTION,
    assetFile: "agents/explorer.md",
    model: resolveRoleModel(pluginConfig, "explorer"),
    pluginConfig,
  })
}

export async function registerAnalyst(
  config: MutableConfig,
  pluginConfig: JanusPluginConfig,
): Promise<void> {
  await registerReadOnlySubagent(config, {
    name: pluginConfig.analyst_agent,
    description: ANALYST_DESCRIPTION,
    assetFile: "agents/analyst.md",
    model: resolveRoleModel(pluginConfig, "analyst"),
    pluginConfig,
    extraFragments: [REASONING_FAILURES_ASSET, CLAIM_TYPES_ASSET],
  })
}

export async function registerConsultationCritic(
  config: MutableConfig,
  pluginConfig: JanusPluginConfig,
): Promise<void> {
  await registerReadOnlySubagent(config, {
    name: pluginConfig.critic_agent,
    description: CRITIC_DESCRIPTION,
    assetFile: "agents/consultation-critic.md",
    model: resolveRoleModel(pluginConfig, "critic"),
    pluginConfig,
    extraFragments: [REASONING_FAILURES_ASSET],
  })
}

export async function registerVerifier(
  config: MutableConfig,
  pluginConfig: JanusPluginConfig,
): Promise<void> {
  await registerReadOnlySubagent(config, {
    name: pluginConfig.verifier_agent,
    description: VERIFIER_DESCRIPTION,
    assetFile: "agents/consultation-verifier.md",
    model: resolveRoleModel(pluginConfig, "verifier"),
    pluginConfig,
  })
}

/**
 * writer's permissions. With roots: edit is denied everywhere except the
 * configured writer roots (`"*": "deny"` first, allow rules after — last
 * matching rule wins), bash and dispatch are denied, web lookups are
 * allowed, and `external_directory` grants access to the fixed author state
 * dir so the writer can read the brief (writes there still hit
 * `edit: "*" -> deny`). With `roots: []` (read-only fallback) edit is denied
 * outright and the writer returns prose for the consultant to publish.
 *
 * Root allow rules are emitted both project-relative (`userdoc/**`) and, when
 * the project `directory` is known, anchored to it in absolute form (the
 * directory as supplied plus its realpath, each with and without the leading
 * slash). The host matches edit permission patterns literally against the
 * file path the writer's tools submit, and glob/read hand the writer
 * realpath'd absolute paths, so a relative-only allow rule never matches
 * those calls and the write falls through to the catch-all deny.
 */
export function buildWriterPermission(
  roots: string[],
  authorStateDir: string,
  directory?: string,
): Record<string, unknown> {
  if (roots.length === 0) {
    return {
      edit: "deny",
      bash: "deny",
      task: "deny",
      webfetch: "allow",
      websearch: "allow",
    }
  }
  const edit: Record<string, string> = { "*": "deny" }
  const anchors = writerRootAnchors(directory)
  for (const root of roots) {
    edit[`${root}/**`] = "allow"
    for (const anchor of anchors) {
      edit[`${anchor}/${root}/**`] = "allow"
    }
  }
  return {
    edit,
    bash: "deny",
    task: "deny",
    webfetch: "allow",
    websearch: "allow",
    external_directory: { [`${authorStateDir}/**`]: "allow" },
  }
}

/**
 * Absolute anchors for writer root allow rules: the resolved project
 * directory as supplied and its realpath, each with and without the leading
 * slash (the host's edit-permission evaluation normalizes submitted paths
 * differently per permission type, so both forms are covered).
 */
function writerRootAnchors(directory: string | undefined): string[] {
  if (directory === undefined || directory.length === 0) return []
  const anchors = new Set<string>()
  const base = resolve(directory)
  anchors.add(base)
  anchors.add(base.replace(/^\//, ""))
  try {
    const real = realpathSync(base)
    anchors.add(real)
    anchors.add(real.replace(/^\//, ""))
  } catch {
    // The directory may not exist yet (unit tests); the as-supplied anchor
    // still covers paths the host resolves the same way.
  }
  return [...anchors]
}

/**
 * Build the runtime bindings block injected into the writer agent prompt:
 * its model, write mode (`scoped` with roots, `read-only` without), the
 * writable roots, the author state dir to read briefs from, the targeted
 * search budget, and the leaf rule (no bash, no dispatch, no memory).
 */
export function buildWriterRuntimeBindings(
  pluginConfig: JanusPluginConfig,
  authorStateDir: string,
): string {
  const roots = normalizeWriterDocsRoots(pluginConfig.writer_docs_roots)

  const modelLine = `- Writer model: \`${resolveRoleModel(pluginConfig, "writer")}\``

  const modeLine =
    roots.length > 0
      ? "- Write mode: `scoped` — write only exact approved document files under the writable roots; every other path is denied"
      : "- Write mode: `read-only` — no file writes; return the full prose or a patch; the consultant publishes it"

  const rootsLine =
    roots.length > 0
      ? `- Writable roots (\`writer_docs_roots\`): ${roots.map((root) => `\`${root}\``).join(", ")} — only approved document files under these roots; never source, config, README, or AGENTS files`
      : "- Writable roots (`writer_docs_roots`): none — the roots array is empty, so the writer is read-only and the consultant publishes"

  const authorLine = `- Author state dir: \`${authorStateDir}\` — read the brief at the supplied path; never write the brief, the manifest, or memory`

  const searchLine =
    "- Search budget: about 10 targeted web lookups per section — log every lookup in the source ledger; broad or contested research goes back to the consultant as a researchRequest"

  const leafLine =
    "- You are a leaf: no bash, no dispatch (`task: deny`), no memory tools; never dispatch explorer"

  return `## Runtime Bindings (injected by opencode-adapter)\n${modelLine}\n${modeLine}\n${rootsLine}\n${authorLine}\n${searchLine}\n${leafLine}`
}

/**
 * Register the `writer` author executor: mode "subagent", a step cap of 80,
 * the layered prompt (role asset + model block + common base/write + writer
 * runtime bindings), scoped-write permissions over the configured writer
 * roots (anchored to the project `directory` when supplied), and the fixed
 * author state dir created (non-fatal) so briefs are readable. A
 * `writer_delegate_agent` short-circuits registration; a pre-existing
 * user-defined entry under the same name is left untouched.
 */
export async function registerWriter(
  config: MutableConfig,
  pluginConfig: JanusPluginConfig,
  env: NodeJS.ProcessEnv = process.env,
  directory?: string,
): Promise<void> {
  if (pluginConfig.writer_delegate_agent !== undefined) return
  const agentName = pluginConfig.writer_agent
  if (config.agent?.[agentName]) return

  const roots = normalizeWriterDocsRoots(pluginConfig.writer_docs_roots)
  const authorStateDir = resolveAuthorStateDir(env)
  try {
    mkdirSync(authorStateDir, { recursive: true })
  } catch {
    // Non-fatal: the consultant passes the brief content in the dispatch;
    // reads of the brief path may fail until the directory exists.
  }

  const assembledPrompt = await assemblePrompt(pluginConfig, {
    assetFile: "agents/writer.md",
    model: resolveRoleModel(pluginConfig, "writer"),
    runtimeBlock: buildWriterRuntimeBindings(pluginConfig, authorStateDir),
  })

  const entry: CodingLaneEntry = {
    mode: "subagent",
    description: WRITER_DESCRIPTION,
    prompt: assembledPrompt,
    model: resolveRoleModel(pluginConfig, "writer"),
    steps: 80,
    permission: buildWriterPermission(roots, authorStateDir, directory),
  }

  if (!config.agent) config.agent = {}
  config.agent[agentName] = entry
}
