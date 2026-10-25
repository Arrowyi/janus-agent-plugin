import { DISPATCH_ROLES, PRODUCTION_WAIT_BUDGET_MS, createKeyedMutex, serializeOutcome, type Clock, type DispatchOutcome, type DispatchRole, type DispatchSdk, type JobSpec, type KeyedMutex } from "./dispatch-contract.ts"
import { createJob, loadJob } from "./dispatch-journal.ts"
import { STARTUP_GRACE_MS } from "./dispatch-observer.ts"
import { buildChainFailureMessage, embedsProviderErrorText, errorText, formatModel, isProviderErrorText, makeEnvelope, modelFailureHint, observationToOutcome } from "./dispatch-helpers.ts"
import { abortAndReconcile, createSystemClock, findActiveAttempt, type ActiveAttempt } from "./dispatch-cancel.ts"
import { launchAttempt, observeAttempt, LaunchError, type AttemptSubmission } from "./dispatch-attempt.ts"
export { createSystemClock } from "./dispatch-cancel.ts"

export interface LaunchInput {
  readonly role: DispatchRole
  readonly prompt: string
  readonly agentName: string
  readonly modelChain: ReadonlyArray<string | null>
  readonly parentID: string
  readonly directory: string
  readonly waitMs?: number
  readonly startupGraceMs?: number
  readonly signal?: AbortSignal
  /**
   * When true, a successful launch returns a completed JSON envelope
   * (job_id, session_id, attempt, waited_ms, text) instead of plain text,
   * so the caller can later reuse `session_id` with
   * `janus_dispatch_continue`. Pending/failed results are unchanged.
   */
  readonly returnHandle?: boolean
}

export interface ContinueInput {
  readonly role: DispatchRole
  readonly prompt: string
  readonly agentName: string
  readonly modelChain: ReadonlyArray<string | null>
  readonly parentID: string
  readonly directory: string
  /** The existing dispatch session the new prompt is sent to. */
  readonly sessionID: string
  /** The original job root that owned the reused target session. */
  readonly continuedFrom: string
  readonly waitMs?: number
  readonly startupGraceMs?: number
  readonly signal?: AbortSignal
}

export interface WaitInput {
  readonly jobID: string
  readonly parentID: string
  readonly directory: string
  readonly waitMs?: number
  readonly startupGraceMs?: number
  readonly signal?: AbortSignal
}

export interface DispatchLifecycle {
  readonly launch: (input: LaunchInput) => Promise<string>
  readonly wait: (input: WaitInput) => Promise<string>
  readonly continue: (input: ContinueInput) => Promise<string>
}

export interface CreateDispatchLifecycleInput {
  readonly sdk: DispatchSdk
  readonly clock?: Clock
  readonly mutex?: KeyedMutex
}

export function createDispatchLifecycle(input: CreateDispatchLifecycleInput): DispatchLifecycle {
  const sdk = input.sdk
  const clock = input.clock ?? createSystemClock()
  const mutex = input.mutex ?? createKeyedMutex()
  const context = { sdk, clock }

  async function resolveAttemptChain(request: AttemptSubmission, startTime: number, blockFallback: boolean): Promise<DispatchOutcome> {
    const { spec, jobID } = request
    const tried: string[] = []
    let lastError = "unknown error"
    for (let index = request.index; index < spec.model_chain.length; index++) {
      if (index > 0) {
        const fresh = await loadJob(sdk, { jobID, directory: spec.directory, expectedParentID: spec.parent_id })
        if (!fresh.ok) return { kind: "failure", reason: "consultation dispatch unavailable" }
        const active = findActiveAttempt(fresh.value)
        const identity = active ?? { index, model: spec.model_chain[index] ?? null, sessionID: jobID }
        if (fresh.value.cancelIntents.length > 0) return makeEnvelope("cancelling", jobID, spec.role, identity, identity.sessionID, clock.now() - startTime, "cancel intent retained; fallback blocked")
        if (active === undefined || active.index !== index - 1) return makeEnvelope("unknown", jobID, spec.role, identity, identity.sessionID, clock.now() - startTime, "journal changed; fallback blocked")
      }
      const { attempt, observation } = await launchAttempt(context, { ...request, index })
      const waitedMs = clock.now() - startTime
      switch (observation.kind) {
        case "completed": return { kind: "success", text: observation.text }
        case "cancelled":
        case "pending":
        case "unknown": return observationToOutcome(observation, jobID, spec.role, attempt, waitedMs)
        case "failed": {
          lastError = observation.error
          tried.push(formatModel(attempt.model, spec.agent_name))
          if (!observation.retryable || blockFallback) {
            const hint = isProviderErrorText(lastError) ? modelFailureHint(spec.role, spec.model_chain[index] ?? null) : ""
            return { kind: "failure", reason: `${spec.role} dispatch failed: ${lastError}${hint}` }
          }
          break
        }
        default: {
          const exhaustive: never = observation
          return exhaustive
        }
      }
    }
    return { kind: "failure", reason: buildChainFailureMessage(spec.role, tried, lastError) }
  }

  interface JobRequest {
    readonly role: DispatchRole
    readonly prompt: string
    readonly agentName: string
    readonly modelChain: ReadonlyArray<string | null>
    readonly parentID: string
    readonly directory: string
    readonly waitMs?: number
    readonly startupGraceMs?: number
    readonly signal?: AbortSignal
  }

  interface ContinuationSpec {
    readonly sessionID: string
    readonly continuedFrom: string
  }

  async function readCompletedHandle(jobID: string, spec: JobSpec): Promise<ActiveAttempt | undefined> {
    const loaded = await loadJob(sdk, { jobID, directory: spec.directory, expectedParentID: spec.parent_id })
    if (!loaded.ok) return undefined
    return findActiveAttempt(loaded.value)
  }

  // One code path for a normal launch and a continuation: both create a job
  // root (a continuation records sessionID/continuedFrom in its spec), run
  // attempt 0 (a continuation prompts spec.session_id, the reused target),
  // and share the recoverable failure/abort handling.
  async function runJob(
    request: JobRequest,
    options: { readonly returnHandle?: boolean; readonly continuation?: ContinuationSpec },
  ): Promise<string> {
    const modelChain = [...request.modelChain]
    const continuation = options.continuation
    const created = await createJob(sdk, {
      parentID: request.parentID, directory: request.directory,
      role: request.role, agentName: request.agentName, modelChain, prompt: request.prompt, clock,
      ...(continuation !== undefined ? { sessionID: continuation.sessionID, continuedFrom: continuation.continuedFrom } : {}),
    })
    if (!created.ok) {
      const identity = created.error.jobID === undefined ? "" : ` (job_id=${created.error.jobID})`
      return serializeOutcome({ kind: "failure", reason: `failed to create job: ${created.error.message}${identity}` })
    }
    const jobID = created.value.jobID
    const spec: JobSpec = {
      v: 1, kind: "job-spec", role: request.role, prompt: request.prompt,
      agent_name: request.agentName, model_chain: modelChain, parent_id: request.parentID,
      directory: request.directory, created_at: clock.now(),
      ...(continuation !== undefined ? { session_id: continuation.sessionID, continued_from: continuation.continuedFrom } : {}),
    }
    const startTime = clock.now()
    return mutex.withLock(jobID, async () => {
      const outcome = await resolveAttemptChain({
        jobID, spec, index: 0, waitBudgetMs: request.waitMs ?? PRODUCTION_WAIT_BUDGET_MS,
        signal: request.signal, startupGraceMs: request.startupGraceMs,
      }, startTime, false)
      if (outcome.kind === "success" && options.returnHandle === true) {
        const handle = await readCompletedHandle(jobID, spec)
        if (handle !== undefined) {
          return JSON.stringify({
            v: 1,
            status: "completed",
            job_id: jobID,
            role: request.role,
            attempt: { index: handle.index, model: handle.model },
            session_id: handle.sessionID,
            waited_ms: Math.max(0, clock.now() - startTime),
            text: outcome.text,
          })
        }
        // Never lose the success text when the handle cannot be read back.
        return `${outcome.text}\n\n(handle unavailable: the completed session id could not be read back; the result above is final)`
      }
      return serializeOutcome(outcome)
    }, request.signal).catch((error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") {
        return serializeOutcome(makeEnvelope("pending", jobID, request.role, { index: 0, model: modelChain[0] ?? null }, continuation?.sessionID ?? jobID, 0, "launch aborted before attempt started"))
      }
      const identity = error instanceof LaunchError && error.jobID !== undefined ? ` (job_id=${error.jobID})` : ""
      const message = error instanceof LaunchError ? error.message : errorText(error)
      const providerShaped = error instanceof LaunchError ? embedsProviderErrorText(message) : isProviderErrorText(message)
      const hint = providerShaped ? modelFailureHint(request.role, modelChain[0] ?? null) : ""
      return serializeOutcome({ kind: "failure", reason: `${request.role} dispatch failed: ${message}${identity}${hint}` })
    })
  }

  async function runLaunch(request: LaunchInput): Promise<string> {
    return runJob(request, { returnHandle: request.returnHandle })
  }

  async function runContinue(request: ContinueInput): Promise<string> {
    return runJob(request, {
      continuation: { sessionID: request.sessionID, continuedFrom: request.continuedFrom },
    })
  }

  async function runWait(request: WaitInput): Promise<string> {
    const waitBudgetMs = request.waitMs ?? PRODUCTION_WAIT_BUDGET_MS
    const waitStartTime = clock.now()
    const binding = { jobID: request.jobID, directory: request.directory, expectedParentID: request.parentID }
    return mutex.withLock(request.jobID, async () => {
      const startTime = clock.now()
      const loadedResult = await loadJob(sdk, binding)
      if (!loadedResult.ok) {
        if (loadedResult.error.reason === "read-error") {
          // Transient transport failure reading the journal, not an invalid job or
          // a specialist failure. Retain job identity and surface a recoverable
          // nonterminal envelope so the caller retries rather than degrading.
          let role: DispatchRole = "analyst"
          try {
            const got = await sdk.session.get({ path: { id: request.jobID }, query: { directory: request.directory } })
            if (got.error === undefined && got.data !== undefined && got.data.title.startsWith("[consultation-dispatch:v1] ")) {
              const candidate = got.data.title.slice("[consultation-dispatch:v1] ".length)
              if ((DISPATCH_ROLES as readonly string[]).includes(candidate)) role = candidate as DispatchRole
            }
          } catch { /* best-effort role recovery on read outage */ }
          return serializeOutcome(makeEnvelope("unknown", request.jobID, role, { index: 0, model: null }, request.jobID, clock.now() - startTime, "job read failed; recovery unavailable, retry wait"))
        }
        return serializeOutcome({ kind: "failure", reason: "consultation dispatch unavailable" })
      }
      const loaded = loadedResult.value
      const blockFallback = loaded.cancelIntents.length > 0
      const active = findActiveAttempt(loaded)
      if (active === undefined) return serializeOutcome(makeEnvelope("unknown", request.jobID, loaded.spec.role,
        { index: loaded.reservations.at(-1)?.attempt_index ?? 0, model: null }, request.jobID,
        clock.now() - startTime, "launch interrupted or no active attempt"))
      const reservation = loaded.reservations.find((record) => record.attempt_index === active.index)
      const elapsedMs = reservation === undefined ? 0 : Math.max(0, clock.now() - reservation.reserved_at)
      const effectiveGraceMs = Math.max(0, (request.startupGraceMs ?? STARTUP_GRACE_MS) - elapsedMs)
      const observationRequest = { jobID: request.jobID, directory: request.directory, active,
        waitBudgetMs, signal: request.signal, startupGraceMs: effectiveGraceMs }
      if (blockFallback) {
        const snapshot = await observeAttempt(context, { ...observationRequest, waitBudgetMs: 0, signal: undefined })
        if (snapshot.kind === "failed") return serializeOutcome(observationToOutcome(snapshot, request.jobID, loaded.spec.role, active, clock.now() - startTime))
        return serializeOutcome(await abortAndReconcile({ sdk, clock, loaded, active }))
      }
      const observation = await observeAttempt(context, observationRequest)
      const waitedMs = clock.now() - startTime
      if (observation.kind === "failed" && observation.retryable && active.index + 1 < loaded.spec.model_chain.length) {
        return serializeOutcome(await resolveAttemptChain({ jobID: request.jobID, spec: loaded.spec,
          index: active.index + 1, waitBudgetMs, signal: request.signal, startupGraceMs: request.startupGraceMs,
        }, startTime, blockFallback))
      }
      return serializeOutcome(observationToOutcome(observation, request.jobID, loaded.spec.role, active, waitedMs))
    }, request.signal).catch(async (error: unknown) => {
      if (error instanceof DOMException && error.name === "AbortError") {
        try {
          const recovered = await loadJob(sdk, binding)
          if (recovered.ok) {
            const loaded = recovered.value
            const active = findActiveAttempt(loaded)
            return serializeOutcome(active !== undefined
              ? makeEnvelope("pending", request.jobID, loaded.spec.role, active, active.sessionID, clock.now() - waitStartTime, "wait aborted")
              : makeEnvelope("unknown", request.jobID, loaded.spec.role, { index: loaded.reservations.at(-1)?.attempt_index ?? 0, model: null }, request.jobID, clock.now() - waitStartTime, "wait aborted; no active attempt"))
          }
        } catch (recoveryError: unknown) {
          return serializeOutcome({ kind: "failure", reason: `consultation dispatch wait aborted for job ${request.jobID}: ${errorText(recoveryError)}` })
        }
        return serializeOutcome({ kind: "failure", reason: `consultation dispatch wait aborted for job ${request.jobID}` })
      }
      return serializeOutcome({ kind: "failure", reason: "consultation dispatch unavailable" })
    })
  }
  return { launch: runLaunch, wait: runWait, continue: runContinue }
}
