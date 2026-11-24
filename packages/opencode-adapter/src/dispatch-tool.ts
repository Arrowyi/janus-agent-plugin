import { tool, type ToolContext, type ToolDefinition, type PluginInput } from "@opencode-ai/plugin"
import {
  loadPluginConfig,
  resolveRoleModel,
  resolveRoleModelChain,
  normalizeConfigMode,
  type ConfigMode,
  type ConfigTier,
  type JanusPluginConfig,
} from "./plugin-config.ts"
import {
  DISPATCH_MARKER,
  DISPATCH_ROLES,
  DISPATCH_STAGES,
  PERMISSION_REPLY_DECISIONS,
  PERMISSION_REPLY_TOOL_NAME,
  PermissionReplyArgsSchema,
  TWO_TIER_DISPATCH_ROLES,
  parseDispatchRole,
  parseOutcomeEnvelope,
  createKeyedMutex,
  parseContinueArgs,
  parseWaitArgs,
  type Clock,
  type DispatchPermissionSdk,
  type DispatchRole,
  type DispatchSdk,
  type KeyedMutex,
} from "./dispatch-contract.ts"
import { createDispatchLifecycle, createSystemClock, type DispatchLifecycle } from "./dispatch-lifecycle.ts"
import { createDispatchCancel } from "./dispatch-cancel.ts"
import { loadJob } from "./dispatch-journal.ts"
import {
  CODER_HARD_CEILING_TOKENS,
  CONTEXT_WATERMARK_TOKENS,
  enforceContinueReviewGuard,
  enforceDispatchReviewGuard,
  enforcePermissionReplyGuard,
  readCallerContextTokens,
} from "./dispatch-guard.ts"
import { PermissionAskRegistry, createPendingAsksProbe, findLastHumanUserMessageID, resolvePermissionSdk, type PendingAsksProbe } from "./permission-ask.ts"
import { splitModel, errorText, isRetryableModelError } from "./dispatch-helpers.ts"
import { annotateAuthorReviewerReturn } from "./dispatch-review-report.ts"
import {
  DISPATCH_PROTOCOLS,
  PROTOCOL_ROLES,
  loadProtocolCard,
  prependProtocolCard,
} from "./dispatch-protocol.ts"
import path from "node:path"

export { splitModel, errorText, isRetryableModelError }

/**
 * The thirteen dispatch roles: the shared research floor, the four
 * consultation / R&D specialists, the R&D team's tech-lead entry and its
 * independent solution reviewer, the documentation executor and its
 * independent reviewer, and the three entry delegates (consultant, coder,
 * author) plus the economical leaf (simple). `janus` and `architect` are
 * primary entries and are intentionally not dispatchable.
 */
export { DISPATCH_ROLES }
export type { DispatchRole }

/**
 * Roles whose job spec records the dispatch tier. Only the jobs the
 * review-seat floor reads back — coder tasks, author-writer units, and their
 * review seats — write it; every other role omits it even when the caller
 * passes a tier.
 */
const TIER_PERSISTING_ROLES: ReadonlySet<DispatchRole> = new Set([
  "coder",
  "coder-reviewer",
  "solution-reviewer",
  "author-writer",
  "author-reviewer",
])

/**
 * Rejection text for a dispatched sub-session trying to dispatch a primary
 * coordinator role; undefined for every other role, which keeps their call
 * trace free of the extra session.get.
 */
function dagGuardRejection(role: DispatchRole): string | undefined {
  switch (role) {
    case "consultant":
      return "Error: dispatched session cannot dispatch consultant; return the consultation request to the primary caller"
    case "tech-lead":
      return "Error: dispatched session cannot dispatch tech-lead; return the coding task to the primary caller"
    case "author":
      return "Error: dispatched session cannot dispatch author; return the documentation request to the primary caller"
    default:
      return undefined
  }
}

/**
 * Decorate a `janus_dispatch`, `janus_dispatch_wait`, or
 * `janus_dispatch_continue` completion return with the caller context
 * watermark. Plain-text forms (success and `Error:` text) get one appended
 * marker line; envelope forms get a `context_watermark` field instead —
 * appending free text would break `parseOutcomeEnvelope` consumers. A
 * cancelled envelope and any context below the threshold pass through
 * unchanged; an unreadable context never decorates.
 */
function applyContextWatermark(text: string, callerTokens: number | undefined): string {
  if (callerTokens === undefined || callerTokens < CONTEXT_WATERMARK_TOKENS) return text
  const parsed = parseOutcomeEnvelope(text)
  if (parsed.ok) {
    if (parsed.value.status === "cancelled") return text
    const envelope = JSON.parse(text) as Record<string, unknown>
    envelope.context_watermark = callerTokens
    return JSON.stringify(envelope)
  }
  return `${text}\n[context-watermark: ${callerTokens} tokens >= ${CONTEXT_WATERMARK_TOKENS}; checkpoint at milestone boundary]`
}

export interface RoleTarget {
  agentName: string
  model?: string
}

export interface RoleTargetOptions {
  readonly mode?: ConfigMode
  readonly tier?: ConfigTier
}

export function resolveRoleTarget(
  config: JanusPluginConfig,
  role: DispatchRole,
  options: RoleTargetOptions = {},
): RoleTarget {
  switch (role) {
    case "common-explorer":
      return { agentName: config.common_explorer_agent, model: resolveRoleModel(config, "common-explorer", options) }
    case "consultant-analyst":
      return { agentName: config.consultant_analyst_agent, model: resolveRoleModel(config, "consultant-analyst", options) }
    case "consultant-critic":
      return { agentName: config.consultant_critic_agent, model: resolveRoleModel(config, "consultant-critic", options) }
    case "coder-reviewer":
      return { agentName: config.coder_reviewer_agent, model: resolveRoleModel(config, "coder-reviewer", options) }
    case "consultant-auditor":
      return { agentName: config.consultant_auditor_agent, model: resolveRoleModel(config, "consultant-auditor", options) }
    case "author-writer":
      // A configured delegate keeps host-defined model selection; mode/tier
      // overrides apply only to the bundled author-writer.
      if (config.writer_delegate_agent !== undefined) {
        return { agentName: config.writer_delegate_agent, model: config.writer_delegate_model }
      }
      return { agentName: config.author_writer_agent, model: resolveRoleModel(config, "author-writer", options) }
    case "author-reviewer":
      return { agentName: config.author_reviewer_agent, model: resolveRoleModel(config, "author-reviewer", options) }
    case "coder":
      return { agentName: config.coder_agent, model: resolveRoleModel(config, "coder", options) }
    case "tech-lead":
      return { agentName: config.tech_lead_agent, model: resolveRoleModel(config, "tech-lead", options) }
    case "solution-reviewer":
      return { agentName: config.solution_reviewer_agent, model: resolveRoleModel(config, "solution-reviewer", options) }
    case "simple":
      return { agentName: config.simple_agent, model: resolveRoleModel(config, "simple", options) }
    case "consultant":
      return { agentName: config.consultant_agent, model: resolveRoleModel(config, "consultant", options) }
    case "author":
      return { agentName: config.author_agent, model: resolveRoleModel(config, "author", options) }
  }
}

export interface DispatchToolDeps {
  readonly clock?: Clock
  readonly mutex?: KeyedMutex
  readonly lifecycle?: DispatchLifecycle
  /** Shared permission-ask registry; a fresh one is created when absent. */
  readonly askRegistry?: PermissionAskRegistry
  /** Pending-ask probe; defaults to the production probe over the same client. */
  readonly pendingAsksProbe?: PendingAsksProbe
  /** Host permission surface; defaults to the surface resolved from the client. */
  readonly permissionSdk?: DispatchPermissionSdk
}

/**
 * Build the four consultation job tools with one shared coordinator set.
 *
 * It dispatches ONLY to the thirteen dispatchable roles (`consultant`,
 * `tech-lead`, `author`, `simple`, `common-explorer`, `consultant-analyst`,
 * `consultant-critic`, `consultant-auditor`, `solution-reviewer`, `coder`,
 * `coder-reviewer`, `author-writer`, `author-reviewer`)
 * using the recoverable lifecycle coordinator. `janus_dispatch_continue`
 * reuses an existing dispatch session from the same caller. It is additive:
 * it neither shadows nor interferes with the built-in `task` tool or any
 * other plugin's tools.
 */
export function createJanusDispatchTools(
  client: PluginInput["client"],
  deps: DispatchToolDeps = {},
) {
  const sdk = client as unknown as DispatchSdk
  const clock = deps.clock ?? createSystemClock()
  const mutex = deps.mutex ?? createKeyedMutex()
  const askRegistry = deps.askRegistry ?? new PermissionAskRegistry()
  const permissionSdk = deps.permissionSdk ?? resolvePermissionSdk(client)
  // The probe performs real lineage/pull reads, so the per-observation gate in
  // dispatch-attempt/dispatch-cancel skips it entirely while the registry has
  // no active asks — a completed leaf/coordinator with nothing to escalate
  // keeps the exact pre-escalation call trace.
  const pendingAsksProbe = deps.pendingAsksProbe ?? createPendingAsksProbe(client, askRegistry, clock)
  const lifecycle =
    deps.lifecycle ??
    createDispatchLifecycle({
      sdk, clock, mutex, askRegistry, pendingAsksProbe,
      ...(permissionSdk !== undefined ? { permissionSdk } : {}),
    })
  const cancelHandler = createDispatchCancel({
    sdk, clock, mutex, askRegistry, pendingAsksProbe,
    ...(permissionSdk !== undefined ? { permissionSdk } : {}),
  })

  const dispatch = tool({
    description:
      "Dispatch ONLY to a dispatchable role (consultant, tech-lead, author, simple, common-explorer, consultant-analyst, consultant-critic, consultant-auditor, solution-reviewer, coder, coder-reviewer, author-writer, author-reviewer). Returns its result or a recoverable job id if still working after a soft wait; call janus_dispatch_wait with that job id to continue waiting. Optional mode, tier, and protocol select the model and prepend a methodology card to the first turn. Pass return_handle: true to receive a completed JSON envelope (job_id, session_id, attempt, text) instead of plain text on success, whose session_id can be reused with janus_dispatch_continue; pending and failed results are unchanged.",
    args: {
      role: tool.schema.string(),
      prompt: tool.schema.string(),
      return_handle: tool.schema.boolean().optional(),
      mode: tool.schema.string().optional(),
      tier: tool.schema.enum(["fast", "standard", "deep"]).optional(),
      protocol: tool.schema.enum(DISPATCH_PROTOCOLS).optional(),
      reviews_job_ids: tool.schema.string().array().optional(),
      stage: tool.schema.enum(DISPATCH_STAGES).optional(),
    },
    async execute(args, context: ToolContext): Promise<string> {
      const roleResult = parseDispatchRole(args.role)
      if (!roleResult.ok) return `Error: ${roleResult.error.message}`
      const role = roleResult.value
      let mode: ConfigMode | undefined
      if (args.mode !== undefined) {
        mode = normalizeConfigMode(args.mode)
        if (mode === undefined) return `Error: invalid mode "${args.mode}"; expected select, verify, roadmap, research, guide, doc, or design`
      }
      const tier: ConfigTier | undefined = args.tier
      if (tier === "deep" && (TWO_TIER_DISPATCH_ROLES as readonly string[]).includes(role)) {
        return `Error: ${role} runs only the fast and standard tiers; dispatch tier: "standard" (configured via tier_models.standard.${role} or ${role.replace("-", "_")}_model)`
      }
      if (args.protocol !== undefined && !PROTOCOL_ROLES[args.protocol].includes(role)) {
        return `Error: protocol ${args.protocol} is not supported by role ${role}; use ${PROTOCOL_ROLES[args.protocol].join(" or ")}`
      }
      const protocolCard = args.protocol === undefined ? "" : await loadProtocolCard(args.protocol)
      const prompt = prependProtocolCard(args.prompt, protocolCard)
      const config = await loadPluginConfig(process.env)
      const enabled: Record<DispatchRole, boolean> = {
        "common-explorer": config.common_explorer_enabled,
        "consultant-analyst": config.consultant_analyst_enabled,
        "consultant-critic": config.consultant_critic_enabled,
        "coder-reviewer": config.coder_reviewer_enabled,
        "consultant-auditor": config.consultant_auditor_enabled,
        "author-writer": config.author_writer_enabled || config.writer_delegate_agent !== undefined,
        "author-reviewer": config.author_reviewer_enabled,
        simple: config.simple_enabled,
        coder: config.coder_enabled,
        "tech-lead": config.tech_lead_enabled,
        "solution-reviewer": config.solution_reviewer_enabled,
        consultant: true,
        author: config.author_enabled,
      }
      if (!enabled[role]) return `Error: ${role} is disabled by configuration`

      // Caller context watermark: one read of the caller session's newest
      // completed assistant usage. An unreadable context never blocks a
      // dispatch — it only skips decoration.
      const callerTokens = await readCallerContextTokens(sdk, context.sessionID, context.directory)

      // Hard ceiling for the coding lane: a controller past 350k tokens
      // must checkpoint its state instead of piling more work onto a coder
      // sub-session. Fail-fast before any job session is created.
      if (role === "coder" && callerTokens !== undefined && callerTokens >= CODER_HARD_CEILING_TOKENS) {
        return applyContextWatermark(
          `Error: controller context exceeded ${CODER_HARD_CEILING_TOKENS} tokens hard ceiling; checkpoint to plan.md before continuing. Recovery: update the plan.md ledger and checkpoint state, resume from a fresh tech-lead session with the plan.md path, or reduce context and retry.`,
          callerTokens,
        )
      }

      // Caller DAG guard: a session that is itself a dispatched sub-session
      // must not dispatch a primary coordinator role (consultant, tech-lead,
      // author), so the coordination chain stays free of sub-session ->
      // coordinator recursion. The other ten roles keep their existing call
      // trace (no extra session.get).
      const rejection = dagGuardRejection(role)
      if (rejection !== undefined) {
        const callerResult = await sdk.session.get({
          path: { id: context.sessionID },
          query: { directory: context.directory },
        })
        if (callerResult.error !== undefined) {
          return applyContextWatermark(
            `Error: failed to read caller session: ${context.sessionID} in ${context.directory} (${errorText(callerResult.error)}); retry janus_dispatch`,
            callerTokens,
          )
        }
        if (callerResult.data?.title.startsWith(DISPATCH_MARKER)) {
          return applyContextWatermark(rejection, callerTokens)
        }
      }

      const { agentName, model } = resolveRoleTarget(config, role, { mode, tier })
      const modelChain: Array<string | null> =
        role === "author-writer" && config.writer_delegate_agent !== undefined
          ? [model ?? null]
          : resolveRoleModelChain(config, role, { mode, tier }).map((m) => m ?? null)

      // Author ≠ reviewer guard: a review seat must not share a model or
      // model family with the author it reviews. Fail-fast before any
      // session is created or prompted; non-reviewer roles short-circuit
      // without SDK access.
      const guard = await enforceDispatchReviewGuard(sdk, {
        role,
        protocol: args.protocol,
        stage: args.stage,
        reviewsJobIDs: args.reviews_job_ids,
        reviewerModel: model,
        reviewerTier: tier,
        config,
        directory: context.directory,
      })
      if (!guard.ok) return applyContextWatermark(`Error: ${guard.message}`, callerTokens)

      const launched = await lifecycle.launch({
        role,
        prompt,
        agentName,
        modelChain,
        parentID: context.sessionID,
        directory: context.directory,
        signal: context.abort,
        returnHandle: args.return_handle,
        protocol: args.protocol,
        stage: args.stage,
        ...(tier !== undefined && TIER_PERSISTING_ROLES.has(role) ? { tier } : {}),
      })
      // A dispatch return may carry pending_asks (a first soft-yield usually
      // arrives here); record the same-turn watermark so the reply guard can
      // distinguish the surfacing turn from a later human reply. Write-once and
      // best-effort.
      const dispatched = role === "author-reviewer" ? annotateAuthorReviewerReturn(launched) : launched
      await recordSurfacedTurnWatermark(sdk, askRegistry, {
        text: dispatched,
        callerSessionID: context.sessionID,
        directory: context.directory,
        now: clock.now(),
      })
      return applyContextWatermark(dispatched, callerTokens)
    },
  })

  const continueTool = tool({
    description:
      "Continue an existing dispatch session with a new prompt. session_id comes from a janus_dispatch return_handle completed envelope or a pending envelope. Reuse is limited to the same caller and workspace, an idle dispatch session (not busy/retrying); returns the specialist's response text, or a recoverable pending envelope whose job_id works with janus_dispatch_wait. Never continue a pending job (wait for it first) and never pass a continuation job_id as session_id — use the original session_id.",
    args: {
      session_id: tool.schema.string(),
      prompt: tool.schema.string(),
      role: tool.schema.string().optional(),
      reviews_job_ids: tool.schema.string().array().optional(),
    },
    async execute(args, context: ToolContext): Promise<string> {
      const parsed = parseContinueArgs(args)
      if (!parsed.ok) return `Error: ${parsed.error.message}`
      const { session_id: targetSessionID, prompt } = parsed.value
      const config = await loadPluginConfig(process.env)

      // Resolve the target session in the caller's workspace. A read error is
      // transient and retryable; only an error-free empty result is not-found.
      const targetResult = await sdk.session.get({
        path: { id: targetSessionID },
        query: { directory: context.directory },
      })
      if (targetResult.error !== undefined) {
        return `Error: failed to read target session: ${targetSessionID} in ${context.directory} (${errorText(targetResult.error)}); retry janus_dispatch_continue`
      }
      const target = targetResult.data
      if (target === undefined) {
        return `Error: target session ${targetSessionID} was not found in the current workspace`
      }
      if (path.normalize(target.directory) !== path.normalize(context.directory)) {
        return "Error: target session belongs to a different workspace; session reuse is limited to the same directory"
      }
      if (!target.title.startsWith(DISPATCH_MARKER)) {
        return "Error: target session is not a dispatch session"
      }

      // Resolve the owning job root and the target's role. The target is
      // either a job root owned by this caller, or an attempt child of a
      // normal job root owned by this caller. A continuation job root (its
      // spec carries session_id) is rejected: callers must continue the
      // original session, not a continuation job.
      let jobRootID: string
      let role: DispatchRole
      if (target.parentID === context.sessionID) {
        jobRootID = target.id
      } else if (target.parentID === undefined) {
        return "Error: target dispatch session is not owned by this caller; session reuse is limited to the same caller and workspace"
      } else {
        jobRootID = target.parentID
      }
      const loadedResult = await loadJob(sdk, {
        jobID: jobRootID,
        directory: context.directory,
        expectedParentID: context.sessionID,
      })
      if (!loadedResult.ok) {
        if (loadedResult.error.reason === "read-error") {
          return `Error: target dispatch journal is temporarily unreadable: ${jobRootID} in ${context.directory} (${loadedResult.error.message}); retry janus_dispatch_continue`
        }
        return "Error: target dispatch session is not owned by this caller; session reuse is limited to the same caller and workspace"
      }
      const loaded = loadedResult.value
      if (loaded.spec.session_id !== undefined) {
        return `Error: ${targetSessionID} is a continuation job${target.parentID === context.sessionID ? "" : " attempt"}; use the original dispatch session_id, not a continuation job_id`
      }
      role = loaded.spec.role
      if (target.parentID !== context.sessionID) {
        if (!loaded.children.some((child) => child.id === targetSessionID)) {
          return "Error: target session is not an attempt of an owned dispatch job"
        }
        if (target.title !== `${DISPATCH_MARKER}attempt ${role}`) {
          return `Error: target session title does not match the dispatch role ${role}`
        }
      }
      if (parsed.value.role !== undefined && parsed.value.role !== role) {
        return `Error: role ${parsed.value.role} does not match the target session's dispatch role ${role}`
      }

      const enabled: Record<DispatchRole, boolean> = {
        "common-explorer": config.common_explorer_enabled,
        "consultant-analyst": config.consultant_analyst_enabled,
        "consultant-critic": config.consultant_critic_enabled,
        "coder-reviewer": config.coder_reviewer_enabled,
        "consultant-auditor": config.consultant_auditor_enabled,
        "author-writer": config.author_writer_enabled || config.writer_delegate_agent !== undefined,
        "author-reviewer": config.author_reviewer_enabled,
        simple: config.simple_enabled,
        coder: config.coder_enabled,
        "tech-lead": config.tech_lead_enabled,
        "solution-reviewer": config.solution_reviewer_enabled,
        consultant: true,
        author: config.author_enabled,
      }
      if (!enabled[role]) return `Error: ${role} is disabled by configuration`

      // Author ≠ reviewer guard for continuations: a coder-reviewer or
      // author-reviewer session, or a solution-reviewer session carrying the
      // code_plan_review contract, must again prove reviewer ≠ author before
      // the target session is prompted.
      const guard = await enforceContinueReviewGuard(sdk, {
        targetRole: role,
        targetProtocol: loaded.spec.protocol,
        targetModel: loaded.spec.model_chain[0] ?? null,
        targetTier: loaded.spec.tier,
        targetStage: loaded.spec.stage,
        reviewsJobIDs: parsed.value.reviews_job_ids,
        config,
        directory: context.directory,
      })
      if (!guard.ok) return `Error: ${guard.message}`

      // Caller context watermark on the completion return: same decoration
      // contract as janus_dispatch (cancelled envelopes pass through, an
      // unreadable context never decorates). Validation/ownership errors
      // above stay undecorated, and the coder hard ceiling does not apply
      // to continue.
      const callerTokens = await readCallerContextTokens(sdk, context.sessionID, context.directory)

      // Idle check + continue under one per-target lock. The host can keep
      // reporting a session idle for a sub-second window after the previous
      // `promptAsync`, so two concurrent continues could both pass the probe
      // and double-prompt the same session. The `continue:` key namespace is
      // distinct from the lifecycle's internal `mutex.withLock(jobID)`, so
      // holding it across the status check and the continue call closes that
      // TOCTOU window for plugin-driven continues without deadlocking the
      // lifecycle. The status probe still runs: the lock is a concurrency
      // guard, not a replacement for busy/retry rejection.
      let outcome: string
      try {
        outcome = await mutex.withLock(`continue:${targetSessionID}`, async () => {
          const statusResult = await sdk.session.status({ query: { directory: context.directory } })
          if (statusResult.error !== undefined) {
            return `Error: failed to read target session status: ${targetSessionID} in ${context.directory} (${errorText(statusResult.error)}); retry janus_dispatch_continue`
          }
          // A status map that omits the session reports idle.
          const status = statusResult.data?.[targetSessionID]
          if (status !== undefined && status.type !== "idle") {
            return `Error: target session is ${status.type}; wait for the active job first (janus_dispatch_wait)`
          }

          // A continuation inherits the durable job spec's agent and model
          // chain. Re-resolving from current config could switch models and
          // break the KV-cache prefix the session already established.
          const agentName = loaded.spec.agent_name
          const modelChain = [...loaded.spec.model_chain]

          return lifecycle.continue({
            role,
            prompt,
            agentName,
            modelChain,
            parentID: context.sessionID,
            directory: context.directory,
            sessionID: targetSessionID,
            continuedFrom: jobRootID,
            signal: context.abort,
          })
        }, context.abort)
      } catch (error: unknown) {
        if (error instanceof DOMException && error.name === "AbortError") {
          return "Error: continue aborted before the target session was prompted; retry janus_dispatch_continue"
        }
        throw error
      }
      // A continuation return may carry pending_asks; record the same-turn
      // watermark before the guard-cleared text leaves the tool. Write-once and
      // best-effort.
      const continued = role === "author-reviewer" ? annotateAuthorReviewerReturn(outcome) : outcome
      await recordSurfacedTurnWatermark(sdk, askRegistry, {
        text: continued,
        callerSessionID: context.sessionID,
        directory: context.directory,
        now: clock.now(),
      })
      return applyContextWatermark(continued, callerTokens)
    },
  })

  const wait = tool({
    description:
      "Retrieve a consultation job's result or detect completion, waiting up to wait_ms (default 1800000, max 1800000; 0 takes one snapshot). Soft expiry preserves the job and returns a recoverable job id, not a specialist failure.",
    args: {
      job_id: tool.schema.string(),
      wait_ms: tool.schema.number().optional(),
    },
    async execute(args, context: ToolContext): Promise<string> {
      const parsed = parseWaitArgs(args)
      if (!parsed.ok) return `Error: ${parsed.error.message}`
      // Caller context watermark on the completion return: same decoration
      // contract as janus_dispatch (cancelled envelopes pass through, an
      // unreadable context never decorates). The coder hard ceiling does not
      // apply to wait.
      const callerTokens = await readCallerContextTokens(sdk, context.sessionID, context.directory)
      const waited = await lifecycle.wait({
        jobID: parsed.value.job_id,
        waitMs: parsed.value.wait_ms,
        parentID: context.sessionID,
        directory: context.directory,
        signal: context.abort,
      })
      // A wait return may carry pending_asks; record the same-turn watermark
      // so the reply guard can distinguish the surfacing turn from a later
      // human reply. Write-once and best-effort.
      await recordSurfacedTurnWatermark(sdk, askRegistry, {
        text: waited,
        callerSessionID: context.sessionID,
        directory: context.directory,
        now: clock.now(),
      })
      return applyContextWatermark(waited, callerTokens)
    },
  })

  const cancel = tool({
    description:
      "Request cancellation of a pending consultation job. May return a cancelling status if cancellation is not yet confirmed; use janus_dispatch_wait to reconcile. Already completed results are preserved.",
    args: { job_id: tool.schema.string() },
    async execute(args, context: ToolContext): Promise<string> {
      const outcome = await cancelHandler.cancel({
        jobID: args.job_id,
        parentID: context.sessionID,
        directory: context.directory,
        signal: context.abort,
      })
      // A cancel snapshot may carry pending_asks; record the same-turn
      // watermark so a later reply is not mistaken for a same-turn answer.
      // Write-once and best-effort.
      await recordSurfacedTurnWatermark(sdk, askRegistry, {
        text: outcome,
        callerSessionID: context.sessionID,
        directory: context.directory,
        now: clock.now(),
      })
      return outcome
    },
  })

  return {
    janus_dispatch: dispatch,
    janus_dispatch_wait: wait,
    janus_dispatch_cancel: cancel,
    janus_dispatch_continue: continueTool,
  }
}

export function createJanusDispatchTool(
  client: PluginInput["client"],
  deps: DispatchToolDeps = {},
): ToolDefinition {
  return createJanusDispatchTools(client, deps).janus_dispatch
}

export interface SurfacedTurnWatermarkInput {
  readonly text: string
  readonly callerSessionID: string
  readonly directory: string
  readonly now: number
}

/**
 * Record the same-turn surfacing watermark for any `pending_asks` carried in a
 * tool return (dispatch, wait, continue, or cancel). The watermark is the
 * caller's newest real human user message at surfacing time; the reply guard
 * rejects an answer that arrives before a newer human message. Write-once per
 * requestID and entirely best-effort.
 */
export async function recordSurfacedTurnWatermark(
  sdk: DispatchSdk,
  askRegistry: PermissionAskRegistry,
  input: SurfacedTurnWatermarkInput,
): Promise<void> {
  let parsed: unknown
  try {
    parsed = JSON.parse(input.text)
  } catch {
    return
  }
  if (typeof parsed !== "object" || parsed === null) return
  const pending = (parsed as Record<string, unknown>).pending_asks
  if (!Array.isArray(pending) || pending.length === 0) return
  const requestIDs: string[] = []
  for (const ask of pending) {
    if (typeof ask !== "object" || ask === null) continue
    const requestID = (ask as Record<string, unknown>).requestID
    if (typeof requestID === "string" && requestID.length > 0) requestIDs.push(requestID)
  }
  if (requestIDs.length === 0) return
  let watermark: string | undefined
  try {
    const result = await sdk.session.messages({
      path: { id: input.callerSessionID },
      query: { directory: input.directory },
    })
    if (result.error === undefined && result.data !== undefined) {
      watermark = findLastHumanUserMessageID(result.data, askRegistry.pluginInjectedMessageIDs)
    }
  } catch {
    watermark = undefined
  }
  for (const requestID of requestIDs) {
    askRegistry.markSurfaced(requestID, {
      callerSessionID: input.callerSessionID,
      surfacedAtUserMessageID: watermark,
      surfacedAt: input.now,
    })
  }
}

/**
 * Build the `janus_permission_reply` tool. It parses the non-strict reply args,
 * runs the four-gate runtime guard before any SDK reply call, then forwards
 * the reply (with the optional message) to the resolved permission surface.
 */
export function createPermissionReplyTool(
  client: PluginInput["client"],
  deps: DispatchToolDeps = {},
): Record<string, ToolDefinition> {
  const sdk = client as unknown as DispatchSdk
  const askRegistry = deps.askRegistry ?? new PermissionAskRegistry()
  const clock = deps.clock ?? createSystemClock()
  return {
    [PERMISSION_REPLY_TOOL_NAME]: tool({
      description:
        "Answer a pending permission ask surfaced to you in a dispatch envelope's pending_asks. Supply the ask's sessionID and requestID plus reply (once, always, or reject) and an optional message. Only the top-level user-facing caller may call this; dispatched sub-sessions must surface pending_asks instead.",
      args: {
        sessionID: tool.schema.string(),
        requestID: tool.schema.string(),
        reply: tool.schema.enum(PERMISSION_REPLY_DECISIONS),
        message: tool.schema.string().optional(),
      },
      async execute(args, context: ToolContext): Promise<string> {
        const parsed = PermissionReplyArgsSchema.safeParse(args)
        if (!parsed.success) {
          const detail = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ")
          return `Error: invalid permission reply args: ${detail}`
        }
        const permissionSdk = resolvePermissionSdk(client)
        const outcome = await enforcePermissionReplyGuard(sdk, {
          sessionID: context.sessionID,
          directory: context.directory,
          args: parsed.data,
          askRegistry,
          permissionSdk,
          now: clock.now(),
        })
        if (!outcome.ok) return outcome.message
        if (outcome.action === "already-resolved") return outcome.message
        if (permissionSdk === undefined) {
          return "Error: the host permission surface is unavailable; retry janus_permission_reply when the permission service recovers"
        }
        const { requestID, sessionID, reply, message } = parsed.data
        let result
        try {
          result = await permissionSdk.reply({
            path: { requestID, sessionID },
            body: { reply, ...(message !== undefined ? { message } : {}) },
            query: { directory: context.directory },
          })
        } catch (error: unknown) {
          return `Error: permission reply failed (${errorText(error)}); retry janus_permission_reply`
        }
        if (result.error !== undefined) {
          return `Error: permission reply failed (${errorText(result.error)}); retry janus_permission_reply`
        }
        if (result.data === false) {
          return "Error: the host did not accept the permission reply; the request may already be resolved elsewhere"
        }
        return `Permission request ${requestID} on session ${sessionID} replied: ${reply}`
      },
    }),
  }
}
