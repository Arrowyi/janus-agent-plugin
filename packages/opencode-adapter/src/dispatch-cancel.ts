import { serializeOutcome, type CancelIntent, type Clock, type DispatchOutcome, type DispatchRole, type DispatchSdk, type KeyedMutex } from "./dispatch-contract.ts"
import { makeEnvelope, observationToOutcome } from "./dispatch-helpers.ts"
import { appendRecord, loadJob, type LoadedJob } from "./dispatch-journal.ts"
import { observeDispatch, STARTUP_GRACE_MS, type ObservationOutcome } from "./dispatch-observer.ts"

export interface CancelInput {
  readonly jobID: string
  readonly parentID: string
  readonly directory: string
  readonly signal?: AbortSignal
}

export interface CreateDispatchCancelInput {
  readonly sdk: DispatchSdk
  readonly clock?: Clock
  readonly mutex: KeyedMutex
}

export interface ActiveAttempt {
  readonly index: number
  readonly model: string | null
  readonly sessionID: string
  readonly requestMessageID: string
}

export function findActiveAttempt(loaded: LoadedJob): ActiveAttempt | undefined {
  const reservationByIndex = new Map(loaded.reservations.map((r) => [r.attempt_index, r]))
  const receiptsByIndex = new Map<number, typeof loaded.receipts>()
  for (const receipt of loaded.receipts) {
    const list = receiptsByIndex.get(receipt.attempt_index) ?? []
    list.push(receipt)
    receiptsByIndex.set(receipt.attempt_index, list)
  }
  let activeIndex = -1
  let activeReceipt: (typeof loaded.receipts)[number] | undefined
  for (const [index, list] of receiptsByIndex) {
    const first = list[0]
    if (list.some((r) => r.session_id !== first?.session_id || r.message_id !== first?.message_id)) return undefined
    if (index > activeIndex) {
      activeIndex = index
      activeReceipt = first
    }
  }
  if (activeReceipt === undefined) return undefined
  if (loaded.reservations.some((reservation) => reservation.attempt_index > activeIndex && !receiptsByIndex.has(reservation.attempt_index))) return undefined
  const reservation = reservationByIndex.get(activeReceipt.attempt_index)
  if (reservation === undefined) return undefined
  return { index: activeReceipt.attempt_index, model: reservation.model, sessionID: activeReceipt.session_id, requestMessageID: activeReceipt.message_id }
}

export function createSystemClock(): Clock {
  return {
    now: () => Date.now(),
    sleep: (ms, signal) => new Promise<void>((resolve, reject) => {
      if (signal?.aborted) { reject(new DOMException("aborted", "AbortError")); return }
      const onAbort = () => {
        clearTimeout(timer)
        reject(new DOMException("aborted", "AbortError"))
      }
      const timer = setTimeout(() => {
        signal?.removeEventListener("abort", onAbort)
        resolve()
      }, ms)
      signal?.addEventListener("abort", onAbort, { once: true })
    }),
  }
}

export interface CancelReconciliation {
  readonly sdk: DispatchSdk
  readonly clock: Clock
  readonly loaded: LoadedJob
  readonly active: ActiveAttempt
  /** Caller's startup grace; the snapshot decays it by the attempt's durable age. */
  readonly startupGraceMs?: number
}

/**
 * Builds the `sdk.session.status` probe shared by `observeAttempt` and
 * `snapshot`. A successful but session-less response maps the requested
 * session to `idle` (the host omits idle sessions from the active map); a
 * missing/non-object response is unknown and a transport error throws so the
 * observer records a probe failure rather than a false idle.
 */
export function createSessionStatusProbe(
  sdk: DispatchSdk,
  directory: string,
  sessionID: string,
): () => Promise<{ readonly status: string } | undefined> {
  return async () => {
    const result = await sdk.session.status({ query: { directory } })
    if (result.error !== undefined) throw result.error
    if (result.data === undefined || typeof result.data !== "object" || result.data === null) return undefined
    const status = (result.data as Readonly<Record<string, { readonly type: string }>>)[sessionID]
    return { status: status?.type ?? "idle" }
  }
}

export interface ReconcileObservationInput {
  readonly sdk: DispatchSdk
  readonly clock: Clock
  readonly jobID: string
  readonly directory: string
  readonly role: DispatchRole
  readonly attempt: { readonly index: number; readonly model: string | null; readonly sessionID: string }
  readonly cancelIntents: ReadonlyArray<CancelIntent>
  readonly waitedMs: number
}

/**
 * The single ObservationOutcome -> DispatchOutcome conversion point. A host
 * stop detected by the observer is made monotonic by persisting one
 * `cancel-intent` with `reason: "host-stopped"` before the cancelled envelope
 * is returned; a failed write fails closed to a non-terminal `unknown` so an
 * unpersisted terminal verdict can never be handed to the caller.
 */
export async function reconcileObservationOutcome(
  observation: ObservationOutcome,
  input: ReconcileObservationInput,
): Promise<DispatchOutcome> {
  if (observation.kind === "cancelled" && observation.hostStopped === true) {
    const persisted = input.cancelIntents.some((intent) => intent.reason === "host-stopped")
    if (!persisted) {
      const written = await appendRecord(input.sdk, {
        jobID: input.jobID,
        directory: input.directory,
        record: { v: 1, kind: "cancel-intent", job_id: input.jobID, intent_at: input.clock.now(), reason: "host-stopped" },
      })
      if (!written.ok) {
        return makeEnvelope(
          "unknown",
          input.jobID,
          input.role,
          input.attempt,
          input.attempt.sessionID,
          input.waitedMs,
          "host stop detected but cancel intent could not be persisted; retry wait",
        )
      }
    }
  }
  return observationToOutcome(observation, input.jobID, input.role, input.attempt, input.waitedMs)
}

function hostStoppedCancelled(
  jobID: string,
  role: DispatchRole,
  attempt: { readonly index: number; readonly model: string | null; readonly sessionID: string },
  waitedMs: number,
): DispatchOutcome {
  return observationToOutcome(
    { kind: "cancelled", reason: "child session stopped by host before response completed" },
    jobID,
    role,
    attempt,
    waitedMs,
  )
}

function diagnosticsFor(before: ObservationOutcome, after?: ObservationOutcome) {
  if (after !== undefined && (after.kind === "pending" || after.kind === "unknown")) return after.diagnostics
  if (before.kind === "pending" || before.kind === "unknown") return before.diagnostics
  return undefined
}

function snapshot(input: CancelReconciliation): Promise<ObservationOutcome> {
  const reservation = input.loaded.reservations.find((record) => record.attempt_index === input.active.index)
  const elapsedMs = reservation === undefined ? 0 : Math.max(0, input.clock.now() - reservation.reserved_at)
  const effectiveGraceMs = Math.max(0, (input.startupGraceMs ?? STARTUP_GRACE_MS) - elapsedMs)
  const directory = input.loaded.spec.directory
  return observeDispatch({
    sdk: input.sdk, clock: input.clock, jobID: input.loaded.jobID,
    childSessionID: input.active.sessionID, requestMessageID: input.active.requestMessageID,
    directory, waitBudgetMs: 0, startupGraceMs: effectiveGraceMs,
    sessionStatus: createSessionStatusProbe(input.sdk, directory, input.active.sessionID),
  })
}

// Caller holds the job mutex and has durably persisted cancel intent.
export async function abortAndReconcile(input: CancelReconciliation): Promise<DispatchOutcome> {
  const { sdk, loaded, active, clock } = input
  const start = clock.now()
  const reconcile = (observation: ObservationOutcome, waitedMs: number) =>
    reconcileObservationOutcome(observation, {
      sdk, clock, jobID: loaded.jobID, directory: loaded.spec.directory, role: loaded.spec.role,
      attempt: active, cancelIntents: loaded.cancelIntents, waitedMs,
    })
  const before = await snapshot(input)
  switch (before.kind) {
    case "completed":
    case "cancelled":
      return reconcile(before, clock.now() - start)
    case "failed":
    case "unknown":
      return makeEnvelope("cancelling", loaded.jobID, loaded.spec.role, active, active.sessionID, clock.now() - start, "cancel intent retained; no confirmed active execution", diagnosticsFor(before))
    case "pending":
      break
    default: {
      const exhaustive: never = before
      return exhaustive
    }
  }
  const response = await sdk.session.abort({ path: { id: active.sessionID }, query: { directory: loaded.spec.directory } })
    .catch((error: unknown) => ({ error }))
  const after = await snapshot(input)
  switch (after.kind) {
    case "completed":
    case "cancelled":
      return reconcile(after, clock.now() - start)
    case "failed":
    case "unknown":
    case "pending":
      return makeEnvelope("cancelling", loaded.jobID, loaded.spec.role, active, active.sessionID, clock.now() - start,
        response.error === undefined ? "cancel requested; awaiting terminal evidence" : "cancel transport failed; intent retained for retry",
        diagnosticsFor(before, after))
    default: {
      const exhaustive: never = after
      return exhaustive
    }
  }
}

export function createDispatchCancel(input: CreateDispatchCancelInput): { readonly cancel: (request: CancelInput) => Promise<string> } {
  const clock = input.clock ?? createSystemClock()
  const unavailable = () => serializeOutcome({ kind: "failure", reason: "consultation dispatch unavailable" })
  async function cancel(request: CancelInput): Promise<string> {
    return input.mutex.withLock(request.jobID, async () => {
      const result = await loadJob(input.sdk, { jobID: request.jobID, directory: request.directory, expectedParentID: request.parentID })
      if (!result.ok) return unavailable()
      const loaded = result.value
      const active = findActiveAttempt(loaded)
      const hostStopped = loaded.cancelIntents.some((intent) => intent.reason === "host-stopped")
      const reconcile = (observation: ObservationOutcome, waitedMs: number) =>
        reconcileObservationOutcome(observation, {
          sdk: input.sdk, clock, jobID: loaded.jobID, directory: loaded.spec.directory, role: loaded.spec.role,
          attempt: active ?? { index: loaded.reservations.at(-1)?.attempt_index ?? 0, model: loaded.reservations.at(-1)?.model ?? null, sessionID: loaded.jobID },
          cancelIntents: loaded.cancelIntents, waitedMs,
        })
      let evidence: ObservationOutcome | undefined
      if (active !== undefined) {
        evidence = await snapshot({ sdk: input.sdk, clock, loaded, active })
        switch (evidence.kind) {
          case "completed":
          case "cancelled":
            return serializeOutcome(await reconcile(evidence, 0))
          case "failed":
          case "pending":
          case "unknown":
            break
          default: {
            const exhaustive: never = evidence
            return exhaustive
          }
        }
        // Host-stop short-circuit: reuse this pre-snapshot (no second read); a
        // racing terminal already returned above, so anything else is cancelled
        // with zero sdk.session.abort calls.
        if (hostStopped) {
          if (evidence.kind === "failed") return serializeOutcome(observationToOutcome(evidence, loaded.jobID, loaded.spec.role, active, 0))
          return serializeOutcome(hostStoppedCancelled(loaded.jobID, loaded.spec.role, active, 0))
        }
      } else if (hostStopped) {
        return serializeOutcome(hostStoppedCancelled(loaded.jobID, loaded.spec.role,
          { index: loaded.reservations.at(-1)?.attempt_index ?? 0, model: loaded.reservations.at(-1)?.model ?? null, sessionID: loaded.jobID }, 0))
      }
      if (loaded.cancelIntents.length === 0) {
        const written = await appendRecord(input.sdk, { jobID: loaded.jobID, directory: loaded.spec.directory,
          record: { v: 1, kind: "cancel-intent", job_id: loaded.jobID, intent_at: clock.now() } })
        if (!written.ok) return serializeOutcome({ kind: "failure", reason: "cancel intent could not be persisted; job retained" })
      }
      if (active === undefined) {
        return serializeOutcome(makeEnvelope("cancelling", loaded.jobID, loaded.spec.role,
          { index: loaded.reservations.at(-1)?.attempt_index ?? 0, model: loaded.reservations.at(-1)?.model ?? null },
          loaded.jobID, 0, "cancel intent retained; awaiting attempt reconciliation"))
      }
      return serializeOutcome(await abortAndReconcile({ sdk: input.sdk, clock, loaded, active }))
    }, request.signal).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") {
        return serializeOutcome({ kind: "failure", reason: "cancel observation interrupted; existing intent retained" })
      }
      return unavailable()
    })
  }
  return { cancel }
}
