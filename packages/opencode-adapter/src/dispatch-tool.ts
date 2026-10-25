import { tool, type ToolContext, type ToolDefinition, type PluginInput } from "@opencode-ai/plugin"
import {
  loadPluginConfig,
  resolveRoleModel,
  resolveRoleModelChain,
  type JanusPluginConfig,
} from "./plugin-config.ts"
import {
  DISPATCH_ROLES,
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
import path from "node:path"

export { splitModel, errorText, isRetryableModelError }

/**
 * The ten dispatch roles: the four research specialists and the writer, the
 * two entry delegates (consultant, coder), the economical leaf (lite), the
 * mechanical lane (coder-lite), and the optional host build target.
 */
export { DISPATCH_ROLES }
export type { DispatchRole }

const DISPATCH_MARKER = "[consultation-dispatch:v1] "

export interface RoleTarget {
  agentName: string
  model?: string
}

export function resolveRoleTarget(
  config: JanusPluginConfig,
  role: DispatchRole,
): RoleTarget {
  switch (role) {
    case "explorer":
      return { agentName: config.explorer_agent, model: resolveRoleModel(config, "explorer") }
    case "analyst":
      return { agentName: config.analyst_agent, model: resolveRoleModel(config, "analyst") }
    case "critic":
      return { agentName: config.critic_agent, model: resolveRoleModel(config, "critic") }
    case "verifier":
      return { agentName: config.verifier_agent, model: resolveRoleModel(config, "verifier") }
    case "writer":
      if (config.writer_delegate_agent !== undefined) {
        return { agentName: config.writer_delegate_agent, model: config.writer_delegate_model }
      }
      return { agentName: config.writer_agent, model: resolveRoleModel(config, "writer") }
    case "coder":
      return { agentName: config.coder_agent, model: resolveRoleModel(config, "coder") }
    case "lite":
      return { agentName: config.lite_agent, model: resolveRoleModel(config, "lite") }
    case "coder-lite":
      return { agentName: config.coder_lite_agent, model: resolveRoleModel(config, "coder-lite") }
    case "build":
      return { agentName: config.build_agent, model: config.build_model }
    case "consultant":
      return { agentName: "consultant", model: resolveRoleModel(config, "consultant") }
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
 * It dispatches ONLY to the consultation roles (`consultant`, `coder`, `lite`,
 * `explorer`, `analyst`, `critic`, `verifier`, `writer`, `coder-lite`, `build`)
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
      "Dispatch ONLY to a consultation role (consultant, coder, lite, explorer, analyst, critic, verifier, writer, coder-lite, build). Returns its result or a recoverable job id if still working after a soft wait; call janus_dispatch_wait with that job id to continue waiting. Pass return_handle: true to receive a completed JSON envelope (job_id, session_id, attempt, text) instead of plain text on success, whose session_id can be reused with janus_dispatch_continue; pending and failed results are unchanged.",
    args: {
      role: tool.schema.enum(DISPATCH_ROLES),
      prompt: tool.schema.string(),
      return_handle: tool.schema.boolean().optional(),
    },
    async execute(args, context: ToolContext): Promise<string> {
      const config = await loadPluginConfig(process.env)
      const enabled: Record<DispatchRole, boolean> = {
        explorer: true,
        analyst: true,
        critic: config.critic_enabled,
        verifier: config.verifier_enabled,
        writer: config.writer_enabled || config.writer_delegate_agent !== undefined,
        coder: config.coder_enabled,
        lite: config.lite_enabled,
        "coder-lite": config.coder_lite_enabled,
        build: config.build_enabled,
        consultant: true,
      }
      if (!enabled[args.role]) return `Error: ${args.role} is disabled by configuration`

      const { agentName, model } = resolveRoleTarget(config, args.role)
      const modelChain: Array<string | null> =
        args.role === "build" || (args.role === "writer" && config.writer_delegate_agent !== undefined)
          ? [model ?? null]
          : resolveRoleModelChain(config, args.role).map((m) => m ?? null)

      return lifecycle.launch({
        role: args.role,
        prompt: args.prompt,
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
      role: tool.schema.enum(DISPATCH_ROLES).optional(),
    },
    async execute(args, context: ToolContext): Promise<string> {
      const parsed = parseContinueArgs(args)
      if (!parsed.ok) return `Error: ${parsed.error.message}`
      const { session_id: targetSessionID, prompt } = parsed.value
      const config = await loadPluginConfig(process.env)

      // Resolve the target session in the caller's workspace.
      const targetResult = await sdk.session.get({
        path: { id: targetSessionID },
        query: { directory: context.directory },
      })
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
        explorer: true,
        analyst: true,
        critic: config.critic_enabled,
        verifier: config.verifier_enabled,
        writer: config.writer_enabled || config.writer_delegate_agent !== undefined,
        coder: config.coder_enabled,
        lite: config.lite_enabled,
        "coder-lite": config.coder_lite_enabled,
        build: config.build_enabled,
        consultant: true,
      }
      if (!enabled[role]) return `Error: ${role} is disabled by configuration`

      // Idle check: a busy/retrying target must be waited on, not re-prompted.
      // A status map that omits the session reports idle.
      const statusResult = await sdk.session.status({ query: { directory: context.directory } })
      const status = statusResult.data?.[targetSessionID]
      if (status !== undefined && status.type !== "idle") {
        return `Error: target session is ${status.type}; wait for the active job first (janus_dispatch_wait)`
      }

      const { agentName, model } = resolveRoleTarget(config, role)
      const modelChain: Array<string | null> =
        role === "build" || (role === "writer" && config.writer_delegate_agent !== undefined)
          ? [model ?? null]
          : resolveRoleModelChain(config, role).map((m) => m ?? null)

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
