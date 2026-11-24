import type { Clock, DispatchRole, DispatchSdk, JobSpec } from "./dispatch-contract.ts"
import { appendRecord, createAttemptSession } from "./dispatch-journal.ts"
import { errorText, splitModel } from "./dispatch-helpers.ts"
import { COORDINATOR_ROLES, observeDispatch, type ObservationOutcome } from "./dispatch-observer.ts"
import { createSessionStatusProbe, type ActiveAttempt } from "./dispatch-cancel.ts"
import type { PendingAsksProbe, PermissionAskRegistry } from "./permission-ask.ts"

export class LaunchError extends Error {
  constructor(message: string, readonly jobID?: string) {
    super(message)
  }
}

export interface AttemptContext {
  readonly sdk: DispatchSdk
  readonly clock: Clock
  /** Shared ask registry; absent in tests and any no-dependency construction. */
  readonly askRegistry?: PermissionAskRegistry
  /** Per-observation pending-ask probe bound lazily to the observed job. */
  readonly pendingAsksProbe?: PendingAsksProbe
}

export interface AttemptObservation {
  readonly jobID: string
  readonly directory: string
  readonly active: ActiveAttempt
  readonly waitBudgetMs: number
  readonly signal?: AbortSignal
  readonly startupGraceMs?: number
  /** The caller-facing dispatch target (the observed session's parent). */
  readonly parentID?: string
  /** The dispatched role, used to gate the coordinator terminal guard. */
  readonly role?: DispatchRole
}

export interface AttemptSubmission {
  readonly jobID: string
  readonly spec: JobSpec
  readonly index: number
  readonly waitBudgetMs: number
  readonly signal?: AbortSignal
  readonly startupGraceMs?: number
}

let requestCounter = 0
function makeAttemptRequestID(): string {
  requestCounter++
  return `msg-attempt-${requestCounter}-${Math.random().toString(36).slice(2, 8)}`
}

export async function observeAttempt(context: AttemptContext, request: AttemptObservation): Promise<ObservationOutcome> {
  const { sdk, clock, askRegistry, pendingAsksProbe } = context
  const askRequest =
    pendingAsksProbe === undefined || request.role === undefined
      ? {}
      : {
          parentID: request.parentID,
          checkSubtreeAsksOnCompletion: COORDINATOR_ROLES.has(request.role),
          pendingAsks: () => {
            // Skip the real probe while nothing is recorded for this
            // directory, so an ask-free poll keeps the exact pre-escalation
            // SDK call trace (the probe bootstraps with its own session read).
            if (askRegistry !== undefined && askRegistry.getActive(request.directory).length === 0) {
              return Promise.resolve(undefined)
            }
            return pendingAsksProbe({
              jobID: request.jobID,
              childSessionID: request.active.sessionID,
              parentID: request.parentID,
              role: request.role!,
            })
          },
          ...(askRegistry !== undefined
            ? {
                getAskVersion: () => askRegistry.getVersion(request.directory),
                waitForAskWake: (seenVersion: number, signal?: AbortSignal) =>
                  askRegistry.waitForAskWake(request.directory, seenVersion, signal),
              }
            : {}),
        }
  const observation = await observeDispatch({
    sdk, clock, jobID: request.jobID, directory: request.directory,
    childSessionID: request.active.sessionID, requestMessageID: request.active.requestMessageID,
    waitBudgetMs: request.waitBudgetMs, signal: request.signal, startupGraceMs: request.startupGraceMs,
    sessionStatus: createSessionStatusProbe(sdk, request.directory, request.active.sessionID),
    ...askRequest,
  })
  // The terminal guard only exposes the marker; the registry that later
  // consumes it lives here, at the real observation call site.
  if (observation.kind === "pending" && observation.diagnostics?.coordinator_turn_ended !== undefined) {
    askRegistry?.recordCoordinatorTurnEnded(request.jobID, observation.diagnostics.coordinator_turn_ended)
  }
  return observation
}

export async function launchAttempt(context: AttemptContext, request: AttemptSubmission): Promise<{ readonly attempt: ActiveAttempt; readonly observation: ObservationOutcome }> {
  const { sdk, clock } = context
  const { jobID, spec, index } = request
  const model = spec.model_chain[index] ?? null
  const requestMessageID = makeAttemptRequestID()
  const reservation = await appendRecord(sdk, { jobID, directory: spec.directory, record: {
    v: 1, kind: "attempt-reservation", job_id: jobID, attempt_index: index,
    model, message_id: requestMessageID, reserved_at: clock.now(),
  } })
  if (!reservation.ok) throw new LaunchError(`failed to persist attempt reservation: ${reservation.error.message}`, jobID)
  let sessionID = spec.session_id ?? jobID
  if (index > 0) {
    // Retry attempts always run in a fresh attempt child session, even for a
    // continuation job whose attempt 0 reused the target session.
    const child = await createAttemptSession(sdk, { jobID, directory: spec.directory, role: spec.role })
    if (!child.ok) throw new LaunchError(`failed to create attempt session: ${child.error.message}`, jobID)
    sessionID = child.value.sessionID
  }
  // A fresh launch (or continuation of a target session) is a new attempt, not
  // a cancelled one: clear any cancel epoch left on the reused target and mark
  // the attempt session as dispatched so an ask on it keeps escalating.
  context.askRegistry?.clearSessionCancelled(sessionID)
  context.askRegistry?.dispatchedSessionIDs.add(sessionID)
  const receipt = await appendRecord(sdk, { jobID, directory: spec.directory, messageID: makeAttemptRequestID(), record: {
    v: 1, kind: "attempt-receipt", job_id: jobID, attempt_index: index,
    session_id: sessionID, message_id: requestMessageID, received_at: clock.now(),
  } })
  if (!receipt.ok) throw new LaunchError(`failed to persist attempt receipt: ${receipt.error.message}`, jobID)
  const attempt: ActiveAttempt = { index, model, sessionID, requestMessageID }
  if (typeof sdk.session.promptAsync !== "function") {
    throw new LaunchError("promptAsync capability unavailable on installed SDK", jobID)
  }
  const result = await Promise.resolve().then(() => sdk.session.promptAsync({
    path: { id: sessionID }, query: { directory: spec.directory }, body: {
      agent: spec.agent_name, model: model === null ? undefined : splitModel(model),
      parts: [{ type: "text", text: spec.prompt }], messageID: requestMessageID,
    },
  })).catch((error: unknown) => ({ error }))
  if (result.error !== undefined) {
    const error = result.error
    const hasStatus = typeof error === "object" && error !== null && (
      ("status" in error && typeof error.status === "number") ||
      ("statusCode" in error && typeof error.statusCode === "number") ||
      ("code" in error && typeof error.code === "number")
    )
    if (hasStatus) throw new LaunchError(`promptAsync failed: ${errorText(error)}`, jobID)
    return { attempt, observation: { kind: "unknown", reason: "promptAsync acknowledgement lost" } }
  }
  return { attempt, observation: await observeAttempt(context, {
    jobID, directory: spec.directory, active: attempt, waitBudgetMs: request.waitBudgetMs,
    signal: request.signal, startupGraceMs: request.startupGraceMs,
    parentID: spec.parent_id, role: spec.role,
  }) }
}
