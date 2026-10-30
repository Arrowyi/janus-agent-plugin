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
  DISPATCH_ROLES,
  parseDispatchRole,
  createKeyedMutex,
  parseContinueArgs,
  parseWaitArgs,
  type Clock,
  type DispatchRole,
  type DispatchSdk,
  type KeyedMutex,
} from "./dispatch-contract.ts"
import { createDispatchLifecycle, createSystemClock, type DispatchLifecycle } from "./dispatch-lifecycle.ts"
import { createDispatchCancel } from "./dispatch-cancel.ts"
import { loadJob } from "./dispatch-journal.ts"
import { splitModel, errorText, isRetryableModelError } from "./dispatch-helpers.ts"
import {
  DISPATCH_PROTOCOLS,
  PROTOCOL_ROLES,
  loadProtocolCard,
  prependProtocolCard,
} from "./dispatch-protocol.ts"
import path from "node:path"

export { splitModel, errorText, isRetryableModelError }

/**
 * The ten dispatch roles: the four research/review specialists and the writer,
 * the two entry delegates (consultant, coder), the economical leaf (ask-lite),
 * and the mechanical lane (coder-lite).
 */
export { DISPATCH_ROLES }
export type { DispatchRole }

const DISPATCH_MARKER = "[consultation-dispatch:v1] "

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
    case "explorer":
      return { agentName: config.explorer_agent, model: resolveRoleModel(config, "explorer", options) }
    case "analyst":
      return { agentName: config.analyst_agent, model: resolveRoleModel(config, "analyst", options) }
    case "critic":
      return { agentName: config.critic_agent, model: resolveRoleModel(config, "critic", options) }
    case "arch-critic":
      return { agentName: config.arch_critic_agent, model: resolveRoleModel(config, "arch-critic", options) }
    case "auditor":
      return { agentName: config.auditor_agent, model: resolveRoleModel(config, "auditor", options) }
    case "writer":
      // A configured delegate keeps host-defined model selection; mode/tier
      // overrides apply only to the bundled writer.
      if (config.writer_delegate_agent !== undefined) {
        return { agentName: config.writer_delegate_agent, model: config.writer_delegate_model }
      }
      return { agentName: config.writer_agent, model: resolveRoleModel(config, "writer", options) }
    case "coder":
      return { agentName: config.coder_agent, model: resolveRoleModel(config, "coder", options) }
    case "ask-lite":
      return { agentName: config.ask_lite_agent, model: resolveRoleModel(config, "ask-lite", options) }
    case "coder-lite":
      return { agentName: config.coder_lite_agent, model: resolveRoleModel(config, "coder-lite", options) }
    case "consultant":
      return { agentName: config.consultant_agent, model: resolveRoleModel(config, "consultant", options) }
  }
}

export interface DispatchToolDeps {
  readonly clock?: Clock
  readonly mutex?: KeyedMutex
  readonly lifecycle?: DispatchLifecycle
}

/**
 * Build the four consultation job tools with one shared coordinator set.
 *
 * It dispatches ONLY to the consultation roles (`consultant`, `coder`,
 * `ask-lite`, `explorer`, `analyst`, `critic`, `arch-critic`, `auditor`,
 * `writer`, `coder-lite`)
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
  const lifecycle =
    deps.lifecycle ??
    createDispatchLifecycle({ sdk, clock, mutex })
  const cancelHandler = createDispatchCancel({ sdk, clock, mutex })

  const dispatch = tool({
    description:
      "Dispatch ONLY to a consultation role (consultant, coder, ask-lite, explorer, analyst, critic, arch-critic, auditor, writer, coder-lite). Returns its result or a recoverable job id if still working after a soft wait; call janus_dispatch_wait with that job id to continue waiting. Optional mode, tier, and protocol select the model and prepend a methodology card to the first turn. Pass return_handle: true to receive a completed JSON envelope (job_id, session_id, attempt, text) instead of plain text on success, whose session_id can be reused with janus_dispatch_continue; pending and failed results are unchanged.",
    args: {
      role: tool.schema.string(),
      prompt: tool.schema.string(),
      return_handle: tool.schema.boolean().optional(),
      mode: tool.schema.string().optional(),
      tier: tool.schema.enum(["fast", "standard", "deep"]).optional(),
      protocol: tool.schema.enum(DISPATCH_PROTOCOLS).optional(),
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
      if (args.protocol !== undefined && !PROTOCOL_ROLES[args.protocol].includes(role)) {
        return `Error: protocol ${args.protocol} is not supported by role ${role}; use ${PROTOCOL_ROLES[args.protocol].join(" or ")}`
      }
      const protocolCard = args.protocol === undefined ? "" : await loadProtocolCard(args.protocol)
      const prompt = prependProtocolCard(args.prompt, protocolCard)
      const config = await loadPluginConfig(process.env)
      const enabled: Record<DispatchRole, boolean> = {
        explorer: config.explorer_enabled,
        analyst: config.analyst_enabled,
        critic: config.critic_enabled,
        "arch-critic": config.arch_critic_enabled,
        auditor: config.auditor_enabled,
        writer: config.writer_enabled || config.writer_delegate_agent !== undefined,
        "ask-lite": config.ask_lite_enabled,
        coder: config.coder_enabled,
        "coder-lite": config.coder_lite_enabled,
        consultant: true,
      }
      if (!enabled[role]) return `Error: ${role} is disabled by configuration`

      const { agentName, model } = resolveRoleTarget(config, role, { mode, tier })
      const modelChain: Array<string | null> =
        role === "writer" && config.writer_delegate_agent !== undefined
          ? [model ?? null]
          : resolveRoleModelChain(config, role, { mode, tier }).map((m) => m ?? null)

      return lifecycle.launch({
        role,
        prompt,
        agentName,
        modelChain,
        parentID: context.sessionID,
        directory: context.directory,
        signal: context.abort,
        returnHandle: args.return_handle,
      })
    },
  })

  const continueTool = tool({
    description:
      "Continue an existing dispatch session with a new prompt. session_id comes from a janus_dispatch return_handle completed envelope or a pending envelope. Reuse is limited to the same caller and workspace, an idle dispatch session (not busy/retrying); returns the specialist's response text, or a recoverable pending envelope whose job_id works with janus_dispatch_wait. Never continue a pending job (wait for it first) and never pass a continuation job_id as session_id — use the original session_id.",
    args: {
      session_id: tool.schema.string(),
      prompt: tool.schema.string(),
      role: tool.schema.string().optional(),
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
      if (loaded.spec.role === "build") {
        return 'Error: the "build" role was removed; continue the original session only if its agent still exists, or start a fresh coder dispatch with tier: "deep"'
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
        explorer: config.explorer_enabled,
        analyst: config.analyst_enabled,
        critic: config.critic_enabled,
        "arch-critic": config.arch_critic_enabled,
        auditor: config.auditor_enabled,
        writer: config.writer_enabled || config.writer_delegate_agent !== undefined,
        "ask-lite": config.ask_lite_enabled,
        coder: config.coder_enabled,
        "coder-lite": config.coder_lite_enabled,
        consultant: true,
      }
      if (!enabled[role]) return `Error: ${role} is disabled by configuration`

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
      return outcome
    },
  })

  const wait = tool({
    description:
      "Retrieve a consultation job's result or detect completion, waiting up to wait_ms (default 300000, max 300000; 0 takes one snapshot). Soft expiry preserves the job and returns a recoverable job id, not a specialist failure.",
    args: {
      job_id: tool.schema.string(),
      wait_ms: tool.schema.number().optional(),
    },
    async execute(args, context: ToolContext): Promise<string> {
      const parsed = parseWaitArgs(args)
      if (!parsed.ok) return `Error: ${parsed.error.message}`
      return lifecycle.wait({
        jobID: parsed.value.job_id,
        waitMs: parsed.value.wait_ms,
        parentID: context.sessionID,
        directory: context.directory,
        signal: context.abort,
      })
    },
  })

  const cancel = tool({
    description:
      "Request cancellation of a pending consultation job. May return a cancelling status if cancellation is not yet confirmed; use janus_dispatch_wait to reconcile. Already completed results are preserved.",
    args: { job_id: tool.schema.string() },
    async execute(args, context: ToolContext): Promise<string> {
      return cancelHandler.cancel({
        jobID: args.job_id,
        parentID: context.sessionID,
        directory: context.directory,
        signal: context.abort,
      })
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
