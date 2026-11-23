import type { DispatchEnvelope, DispatchOutcome, DispatchRole, DispatchSessionStatus } from "./dispatch-contract.ts"
import type { ObservationDiagnostics, ObservationOutcome } from "./dispatch-observer.ts"

export const RETRYABLE_MODEL_ERROR_CODES = ["402", "429", "500", "502", "503", "504"] as const

export function errorText(error: unknown): string {
  if (typeof error !== "object" || error === null || !("name" in error)) return "unrecognized provider error"
  const name = error.name
  if (name !== "APIError" && name !== "MessageAbortedError" && name !== "ProviderAuthError" && name !== "UnknownError" && name !== "MessageOutputLengthError") return "unrecognized provider error"
  const fields: string[] = [name]
  for (const source of [error, "data" in error ? error.data : undefined]) {
    if (typeof source === "object" && source !== null && "statusCode" in source && typeof source.statusCode === "number" && Number.isFinite(source.statusCode)) fields.push(String(source.statusCode))
  }
  return fields.join(": ")
}

export function isRetryableModelError(error: unknown): boolean {
  const sources = [error, typeof error === "object" && error !== null && "data" in error ? error.data : undefined]
  return sources.some((source) => {
    const text = typeof source === "string" ? source : typeof source === "object" && source !== null && "message" in source && typeof source.message === "string" ? source.message : ""
    return RETRYABLE_MODEL_ERROR_CODES.some((code) => text.includes(code)) ||
      (typeof source === "object" && source !== null && "statusCode" in source && typeof source.statusCode === "number" && RETRYABLE_MODEL_ERROR_CODES.some((code) => Number(code) === source.statusCode))
  })
}

/**
 * Split a `provider/model` id into its OpenCode prompt parts.
 * Throws when the id has no `provider/model` separator.
 */
export function splitModel(model: string): { providerID: string; modelID: string } {
  const separator = model.indexOf("/")
  if (separator <= 0 || separator === model.length - 1) {
    throw new Error(`invalid model id "${model}": expected "provider/model"`)
  }
  return { providerID: model.slice(0, separator), modelID: model.slice(separator + 1) }
}

export function formatModel(model: string | null | undefined, agentName: string): string {
  return model ?? `host model of ${agentName}`
}

const PROVIDER_ERROR_NAMES = "APIError|ProviderAuthError|UnknownError|MessageOutputLengthError"
const PROVIDER_ERROR_PREFIX = new RegExp(`^(${PROVIDER_ERROR_NAMES})`)
const EMBEDDED_PROVIDER_ERROR = new RegExp(` (${PROVIDER_ERROR_NAMES})[: ]`)

/**
 * True when a failure text was produced by a recognized provider/model error
 * (per `errorText`), not the unrecognized fallback. Only these carry the
 * model-configuration remediation hint.
 */
export function isProviderErrorText(text: string): boolean {
  return PROVIDER_ERROR_PREFIX.test(text)
}

/**
 * True when a wrapper message embeds a provider-shaped error text (per
 * `errorText`), e.g. a synchronous `LaunchError` reporting
 * "promptAsync failed: UnknownError: 404".
 */
export function embedsProviderErrorText(text: string): boolean {
  return EMBEDDED_PROVIDER_ERROR.test(text)
}

/**
 * Role → plugin-config model-field map. Explicit so hyphenated role names
 * map to their underscored config fields.
 */
export const ROLE_MODEL_FIELDS: Record<DispatchRole, string> = {
  consultant: "consultant_model",
  "tech-lead": "tech_lead_model",
  author: "author_model",
  simple: "simple_model",
  "common-explorer": "common_explorer_model",
  "consultant-analyst": "consultant_analyst_model",
  "consultant-critic": "consultant_critic_model",
  "consultant-auditor": "consultant_auditor_model",
  "solution-reviewer": "solution_reviewer_model",
  coder: "coder_model",
  "coder-reviewer": "coder_reviewer_model",
  "author-writer": "author_writer_model",
  "author-reviewer": "author_reviewer_model",
}

/**
 * Remediation hint appended to provider/model dispatch failures so a
 * non-Go user immediately knows how to fix the default model set.
 */
export function modelFailureHint(role: DispatchRole, model: string | null | undefined): string {
  const label = model !== undefined && model !== null && model.length > 0 ? ` (model: ${model})` : ""
  const field = ROLE_MODEL_FIELDS[role]
  return `${label}. Hint: default models assume an OpenCode Go subscription. If this provider is not configured on this machine, set "${field}" in ~/.config/janus-agent/config.jsonc (or point $JANUS_CONFIG at your config), then retry the dispatch.`
}

export function buildChainFailureMessage(
  role: DispatchRole,
  tried: ReadonlyArray<string>,
  lastError: string,
): string {
  const hint = isProviderErrorText(lastError) ? modelFailureHint(role, tried.at(-1)) : ""
  return `Error: ${role} dispatch failed on every model in the chain (${tried.join(" -> ")}): ${lastError}${hint}; degrade by answering inline and say so.`
}

const SESSION_STATUSES: ReadonlyArray<DispatchSessionStatus> = ["idle", "busy", "retry"]

/**
 * The health subset of an envelope, each field included only when the observer
 * supplied a strictly valid value. The envelope schema is the second guard.
 */
function healthEnvelopeFields(diagnostics: ObservationDiagnostics | undefined): {
  last_activity_ms?: number
  running_tool?: string
  running_tool_ms?: number
  session_status?: DispatchSessionStatus
  stalled_suspect?: true
} {
  const fields: {
    last_activity_ms?: number
    running_tool?: string
    running_tool_ms?: number
    session_status?: DispatchSessionStatus
    stalled_suspect?: true
  } = {}
  if (diagnostics === undefined) return fields
  if (diagnostics.last_activity_ms !== undefined && Number.isInteger(diagnostics.last_activity_ms) && diagnostics.last_activity_ms >= 0) {
    fields.last_activity_ms = diagnostics.last_activity_ms
  }
  const tool = diagnostics.running_tool?.trim()
  if (tool !== undefined && tool.length > 0) fields.running_tool = tool
  if (diagnostics.running_tool_ms !== undefined && Number.isInteger(diagnostics.running_tool_ms) && diagnostics.running_tool_ms >= 0) {
    fields.running_tool_ms = diagnostics.running_tool_ms
  }
  if (diagnostics.session_status !== undefined && SESSION_STATUSES.includes(diagnostics.session_status)) {
    fields.session_status = diagnostics.session_status
  }
  if (diagnostics.stalled_suspect === true) fields.stalled_suspect = true
  return fields
}

/**
 * Self-describing reason for a stalled non-terminal turn. Returns undefined
 * when the turn is not stalled (or was aborted locally, which never gets extra
 * reason text).
 */
function stalledSuspectReason(diagnostics: ObservationDiagnostics | undefined): string | undefined {
  if (diagnostics === undefined || diagnostics.stalled_suspect !== true || diagnostics.aborted === true) return undefined
  if (diagnostics.running_tool !== undefined) {
    const ms = diagnostics.running_tool_ms ?? diagnostics.last_activity_ms
    if (ms === undefined) return undefined
    return `tool "${diagnostics.running_tool}" has been running for ${ms}ms without new activity (stalled_suspect); call janus_dispatch_wait to keep waiting or janus_dispatch_cancel to abort`
  }
  if (diagnostics.last_activity_ms === undefined && diagnostics.running_tool_ms === undefined) return undefined
  // Blank-name running tools emit no `running_tool` (normalized away upstream)
  // but do emit a name-independent `running_tool_ms`; quote the honest age —
  // the larger of the activity gap and the tool-part age — so a flag that
  // fired via the tool's age never reports a sub-threshold activity gap.
  const ms = Math.max(diagnostics.last_activity_ms ?? 0, diagnostics.running_tool_ms ?? 0)
  return `no specialist activity for ${ms}ms (stalled_suspect); call janus_dispatch_wait to keep waiting or janus_dispatch_cancel to abort`
}

export function makeEnvelope(
  status: DispatchEnvelope["status"],
  jobID: string,
  role: DispatchRole,
  attempt: { index: number; model: string | null },
  sessionID: string,
  waitedMs: number,
  reason: string,
  diagnostics?: ObservationDiagnostics,
  next: DispatchEnvelope["next"] = "janus_dispatch_wait",
): DispatchOutcome {
  const envelope: DispatchEnvelope = {
    v: 1,
    status,
    job_id: jobID,
    role,
    attempt: { index: attempt.index, model: attempt.model },
    session_id: sessionID,
    waited_ms: Math.max(0, Math.floor(waitedMs)),
    reason,
    next,
    ...healthEnvelopeFields(diagnostics),
  }
  return { kind: "nonterminal", envelope }
}

export function observationToOutcome(
  observation: ObservationOutcome,
  jobID: string,
  role: DispatchRole,
  attempt: { index: number; model: string | null; sessionID: string },
  waitedMs: number,
): DispatchOutcome {
  switch (observation.kind) {
    case "completed":
      return { kind: "success", text: observation.text }
    case "cancelled":
      return {
        kind: "cancelled",
        envelope: {
          v: 1,
          status: "cancelled",
          job_id: jobID,
          role,
          attempt: { index: attempt.index, model: attempt.model },
          session_id: attempt.sessionID,
          waited_ms: Math.max(0, Math.floor(waitedMs)),
          reason: observation.reason ?? "dispatch was cancelled",
          next: "janus_dispatch_wait",
        },
      }
    case "failed":
      return {
        kind: "failure",
        reason: `${role} dispatch failed: ${observation.error}${
          isProviderErrorText(observation.error) ? modelFailureHint(role, attempt.model) : ""
        }`,
      }
    case "pending":
      return makeEnvelope(
        "pending",
        jobID,
        role,
        attempt,
        attempt.sessionID,
        waitedMs,
        stalledSuspectReason(observation.diagnostics) ??
          (observation.diagnostics?.aborted ? "observation aborted" : observation.diagnostics?.reason ??
            (observation.diagnostics?.status === "retry" ? "specialist is retrying" : observation.diagnostics?.status === "busy" ? "specialist is busy" : "waiting for specialist")),
        observation.diagnostics,
      )
    case "unknown":
      return makeEnvelope(
        "unknown",
        jobID,
        role,
        attempt,
        attempt.sessionID,
        waitedMs,
        stalledSuspectReason(observation.diagnostics) ?? observation.reason,
        observation.diagnostics,
      )
  }
}
