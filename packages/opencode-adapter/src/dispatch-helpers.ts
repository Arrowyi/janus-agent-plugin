import type { DispatchEnvelope, DispatchOutcome, DispatchRole, DispatchSessionStatus, PendingAsk } from "./dispatch-contract.ts"
import type { ObservationDiagnostics, ObservationOutcome } from "./dispatch-observer.ts"
import type { PermissionAskRegistry } from "./permission-ask.ts"

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
  pending_asks?: NonNullable<DispatchEnvelope["pending_asks"]>
} {
  const fields: {
    last_activity_ms?: number
    running_tool?: string
    running_tool_ms?: number
    session_status?: DispatchSessionStatus
    stalled_suspect?: true
    pending_asks?: NonNullable<DispatchEnvelope["pending_asks"]>
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
  // The asks reached the observer already sanitized by permission-ask.ts (the
  // single owner of D3 sanitization); attach them verbatim, never re-sanitize.
  if (diagnostics.pending_asks !== undefined && diagnostics.pending_asks.length > 0) {
    fields.pending_asks = [...diagnostics.pending_asks] as NonNullable<DispatchEnvelope["pending_asks"]>
  }
  return fields
}

const UNTRUSTED_ASK_TAG = "[untrusted-child-request]"
/** Single-line cap for the patterns preview carried in a reason string. */
const MAX_ASK_PREVIEW_CHARS = 120

function askPreview(ask: PendingAsk): string {
  const permissions = ask.patterns.join(", ").slice(0, MAX_ASK_PREVIEW_CHARS)
  const patternText = permissions.length > 0 ? ` (${permissions})` : ""
  return `${UNTRUSTED_ASK_TAG} ${ask.permission}${patternText} on session ${ask.sessionID}`
}

function coordinatorRecoveryReason(
  preview: string,
  jobID: string,
  marker: { readonly coordinatorSessionID: string; readonly descendantJobIDs: ReadonlyArray<string> },
): string {
  // Step 2 waits on the dispatch JOB-ROOT id (what `janus_dispatch_wait`
  // resolves), while step 3 continues the coordinator SESSION (what
  // `janus_dispatch_continue` reuses). They differ on retry attempts and
  // continuations, so never collapse them onto one identifier.
  const step3 = marker.descendantJobIDs.length > 0
    ? `(3) janus_dispatch_continue(${marker.coordinatorSessionID}) and have it collect the result of the listed descendant job ids: ${marker.descendantJobIDs.join(", ")}`
    : `(3) janus_dispatch_continue(${marker.coordinatorSessionID}) and have it collect the descendant child session's result`
  return `coordinator turn ended early while a descendant sub-session still holds a pending permission ask. ${preview}. Recovery: (1) janus_permission_reply for the ask, (2) janus_dispatch_wait(${jobID}) to observe the coordinator job, ${step3}.`
}

/**
 * Self-describing reason for a non-terminal result that carries pending asks,
 * taking precedence over {@link stalledSuspectReason} (except for a locally
 * aborted observation, which never gets extra reason text). Returns undefined
 * when no ask is attached.
 */
export function pendingAskReason(diagnostics: ObservationDiagnostics | undefined): string | undefined {
  if (diagnostics === undefined || diagnostics.aborted === true) return undefined
  const asks = diagnostics.pending_asks
  if (asks === undefined || asks.length === 0) return undefined
  const preview = asks.map(askPreview).join("; ")
  const ended = diagnostics.coordinator_turn_ended
  if (ended !== undefined) {
    // Hop 0 of a surfaced ask is always the observed dispatch job root.
    const jobID = asks[0]?.job_chain[0]?.job_id ?? ended.coordinatorSessionID
    return coordinatorRecoveryReason(preview, jobID, ended)
  }
  if (diagnostics.is_dispatched_subsession_caller === true) {
    return `${preview}. This ask belongs to a descendant sub-session: call janus_dispatch_wait immediately and never finish its turn or cancel the child job while it is pending; the top-level caller answers it with janus_permission_reply.`
  }
  if (diagnostics.same_turn_re_yield === true) {
    return `STOP WAITING: ${preview}. This ask was already surfaced this turn; answer it with janus_permission_reply, then janus_dispatch_wait again.`
  }
  return `${preview}. Answer it with janus_permission_reply (once, always, or reject), then janus_dispatch_wait to keep observing.`
}

/** Marker appended to a coordinator completion that ended its turn early. */
export const COORDINATOR_TURN_ENDED_MARKER = "[coordinator-turn-ended-early:"

/**
 * The single marker-append helper. Peek-then-consume so exactly one completed
 * construction surfaces the terminal guard's marker; later constructions find
 * nothing, and an aborted call (which never builds a completed outcome) never
 * consumes it.
 */
export function appendCoordinatorTurnEndedMarker(
  registry: PermissionAskRegistry | undefined,
  jobID: string | undefined,
  text: string,
): string {
  if (registry === undefined || jobID === undefined) return text
  if (registry.peekCoordinatorTurnEnded(jobID) === undefined) return text
  const marker = registry.consumeCoordinatorTurnEnded(jobID)
  if (marker === undefined) return text
  return `${text}\n[coordinator-turn-ended-early: coordinatorSessionID=${marker.coordinatorSessionID}, descendantJobIDs=[${marker.descendantJobIDs.join(", ")}]]`
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
  askRegistry?: PermissionAskRegistry,
): DispatchOutcome {
  switch (observation.kind) {
    case "completed":
      return { kind: "success", text: appendCoordinatorTurnEndedMarker(askRegistry, jobID, observation.text) }
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
        pendingAskReason(observation.diagnostics) ??
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
        pendingAskReason(observation.diagnostics) ?? stalledSuspectReason(observation.diagnostics) ?? observation.reason,
        observation.diagnostics,
      )
  }
}
