import type { Clock, DispatchSdk, DispatchSessionStatus, SdkMessageWithParts } from "./dispatch-contract.ts"
import { errorText } from "./dispatch-helpers.ts"
import { classifyReadResult, type ClassifyResult, type MatchingActivity } from "./dispatch-classifier.ts"
export { extractUsableText } from "./dispatch-classifier.ts"

/**
 * Observes a dispatched child session until a terminal result is found or the
 * wait budget expires. Polls every {@link POLL_INTERVAL_MS}. When the budget
 * runs out the final read is still given {@link MIN_READ_TRANSPORT_MS} to
 * complete; if it times out, the observer falls back to the last non-terminal
 * evidence (pending if durable progress was seen, otherwise startup-grace
 * logic). A read that exceeds its transport bound is never terminal unknown
 * when earlier polls saw active work. An aborted signal returns pending without
 * calling session.abort.
 *
 * A matching in-flight assistant message doomed by a host stop converges on
 * `cancelled` once the attempt is past its startup grace and the session has
 * been quiet for {@link IDLE_CONFIRM_MS}, re-reading messages after the status
 * probe confirms `idle` so a racing completion is never mistaken for a stop.
 * A tool part stuck `running` for {@link STALLED_SUSPECT_MS} yields a
 * `stalled_suspect` hint and an early soft-yield; a pure reasoning turn keeps
 * the full budget.
 */
export const POLL_INTERVAL_MS = 2_000
export const STARTUP_GRACE_MS = 10_000
export const IDLE_CONFIRM_MS = 10_000
export const STALLED_SUSPECT_MS = 300_000
export const MIN_READ_TRANSPORT_MS = 50
export const SNAPSHOT_READ_TRANSPORT_MS = 5_000

export interface ObservationRequest {
  readonly sdk: DispatchSdk
  readonly jobID: string
  readonly childSessionID: string
  readonly requestMessageID: string
  readonly directory: string
  readonly waitBudgetMs: number
  readonly clock: Clock
  readonly signal?: AbortSignal
  readonly sessionStatus?: () => Promise<{ readonly status: string } | undefined>
  /** Startup grace in milliseconds; defaults to {@link STARTUP_GRACE_MS}. */
  readonly startupGraceMs?: number
  /** Activity quiet window before a host stop is confirmed; defaults to {@link IDLE_CONFIRM_MS}. */
  readonly idleConfirmMs?: number
  /** Stuck-tool soft-yield threshold; defaults to {@link STALLED_SUSPECT_MS}. */
  readonly stalledSuspectMs?: number
}

export interface ObservationDiagnostics {
  readonly elapsed_ms?: number
  readonly status?: string
  readonly aborted?: boolean
  readonly reason?: string
  readonly last_activity_ms?: number
  readonly running_tool?: string
  readonly running_tool_ms?: number
  readonly session_status?: DispatchSessionStatus
  readonly stalled_suspect?: true
}

export type ObservationOutcome =
  | { readonly kind: "completed"; readonly text: string }
  | { readonly kind: "failed"; readonly error: string; readonly retryable: boolean }
  | { readonly kind: "cancelled"; readonly hostStopped?: true; readonly reason?: string }
  | { readonly kind: "pending"; readonly diagnostics?: ObservationDiagnostics }
  | { readonly kind: "unknown"; readonly reason: string; readonly diagnostics?: ObservationDiagnostics }

type ReadResult =
  | { readonly kind: "messages"; readonly messages: ReadonlyArray<SdkMessageWithParts> }
  | { readonly kind: "error"; readonly reason: string }
  | { readonly kind: "timeout"; readonly reason: string }

type TransportResult<T> =
  | { readonly kind: "value"; readonly value: T }
  | { readonly kind: "error"; readonly reason: string }
  | { readonly kind: "timeout"; readonly reason: string }

async function readTransport<T>(req: ObservationRequest, read: () => Promise<T>, budgetMs: number): Promise<TransportResult<T>> {
  const readAbort = new AbortController()
  const onAbort = () => readAbort.abort()
  req.signal?.addEventListener("abort", onAbort, { once: true })
  if (req.signal?.aborted) readAbort.abort()
  try {
    const resultPromise = read().then(
      (value): TransportResult<T> => ({ kind: "value", value }),
      (error: unknown): TransportResult<T> => ({ kind: "error", reason: errorText(error) }),
    )
    const timeoutPromise = req.clock.sleep(budgetMs <= 0 ? SNAPSHOT_READ_TRANSPORT_MS : budgetMs, readAbort.signal).then(
      (): TransportResult<T> => ({ kind: "timeout", reason: "SDK read exceeded remaining wait budget" }),
      (error: unknown): TransportResult<T> => req.signal?.aborted || (error instanceof DOMException && error.name === "AbortError")
        ? { kind: "timeout", reason: "observation interrupted" }
        : { kind: "error", reason: "observation clock failed" },
    )
    return await Promise.race([resultPromise, timeoutPromise])
  } catch (error: unknown) {
    return { kind: "error", reason: errorText(error) }
  } finally {
    req.signal?.removeEventListener("abort", onAbort)
    readAbort.abort()
  }
}

async function readMessages(req: ObservationRequest, budgetMs: number): Promise<ReadResult> {
  const result = await readTransport(req, () => req.sdk.session.messages({ path: { id: req.childSessionID }, query: { directory: req.directory } }), budgetMs)
  switch (result.kind) {
    case "error":
    case "timeout": return result
    case "value": return result.value.error !== undefined ? { kind: "error", reason: errorText(result.value.error) } : { kind: "messages", messages: result.value.data ?? [] }
    default: { const exhaustive: never = result; return exhaustive }
  }
}

function normalizeSessionStatus(raw: unknown): DispatchSessionStatus | undefined {
  if (typeof raw !== "string") return undefined
  const lowered = raw.toLowerCase()
  return lowered === "idle" || lowered === "busy" || lowered === "retry" ? lowered : undefined
}

type StatusProbe =
  | { readonly aborted: true }
  | { readonly live?: DispatchSessionStatus; readonly failed?: string }

const NO_STATUS_PROBE: StatusProbe = {}

function finiteNonNegativeAge(now: number, at: number | undefined): number | undefined {
  if (at === undefined) return undefined
  const age = now - at
  if (!Number.isFinite(age)) return undefined
  const floored = Math.floor(age)
  return floored >= 0 ? floored : undefined
}

/** Health fields for a non-terminal in-flight step, each emitted only when valid. */
function inFlightHealth(
  activity: MatchingActivity,
  now: number,
  liveStatus: DispatchSessionStatus | undefined,
  stalledSuspectMs: number,
): ObservationDiagnostics {
  const health: {
    last_activity_ms?: number
    running_tool?: string
    running_tool_ms?: number
    session_status?: DispatchSessionStatus
    stalled_suspect?: true
  } = {}
  const lastActivityMs = finiteNonNegativeAge(now, activity.lastActivityAt)
  if (lastActivityMs !== undefined) health.last_activity_ms = lastActivityMs
  if (activity.runningTool !== undefined) health.running_tool = activity.runningTool
  const runningToolMs = finiteNonNegativeAge(now, activity.runningToolStartedAt)
  if (runningToolMs !== undefined) health.running_tool_ms = runningToolMs
  if (liveStatus !== undefined) health.session_status = liveStatus
  const lastStalled = lastActivityMs !== undefined && lastActivityMs >= stalledSuspectMs
  const toolStalled = runningToolMs !== undefined && runningToolMs >= stalledSuspectMs
  if (liveStatus !== "idle" && (lastStalled || toolStalled)) health.stalled_suspect = true
  return health
}

export async function observeDispatch(req: ObservationRequest): Promise<ObservationOutcome> {
  const { clock, signal, waitBudgetMs } = req
  const startupGraceMs = req.startupGraceMs ?? STARTUP_GRACE_MS
  const idleConfirmMs = req.idleConfirmMs ?? IDLE_CONFIRM_MS
  const stalledSuspectMs = req.stalledSuspectMs ?? STALLED_SUSPECT_MS
  const startTime = clock.now()
  let lastNonTerminal: { readonly state: "pending" | "unknown"; readonly diagnostics?: ObservationDiagnostics; readonly reason?: string } | undefined
  let durableProgress = false

  function remainingMs(): number {
    return Math.max(0, waitBudgetMs - (clock.now() - startTime))
  }

  function classifyNoMessagesForReq(elapsedMs: number): ClassifyResult {
    if (elapsedMs < startupGraceMs) {
      return { kind: "continue", state: "pending", diagnostics: { elapsed_ms: elapsedMs } }
    }
    return { kind: "continue", state: "unknown", reason: "no durable progress after startup grace" }
  }

  async function probeStatus(budgetMs: number): Promise<StatusProbe> {
    if (req.sessionStatus === undefined) return {}
    const status = await readTransport(req, req.sessionStatus, budgetMs)
    if (signal?.aborted) return { aborted: true }
    switch (status.kind) {
      case "value": return { live: normalizeSessionStatus(status.value?.status) }
      case "error":
      case "timeout": return { failed: `status probe failed: ${status.reason}` }
      default: { const exhaustive: never = status; return exhaustive }
    }
  }

  while (true) {
    if (signal?.aborted) {
      return { kind: "pending", diagnostics: { aborted: true } }
    }
    const readBudget = waitBudgetMs === 0 ? 0 : Math.max(remainingMs(), MIN_READ_TRANSPORT_MS)
    const read = await readMessages(req, readBudget)
    if (signal?.aborted) {
      return { kind: "pending", diagnostics: { aborted: true } }
    }
    if (read.kind === "timeout") {
      if (durableProgress) {
        return { kind: "pending", diagnostics: lastNonTerminal?.diagnostics }
      }
      if (lastNonTerminal !== undefined) {
        return lastNonTerminal.state === "pending"
          ? { kind: "pending", diagnostics: lastNonTerminal.diagnostics }
          : { kind: "unknown", reason: lastNonTerminal.reason ?? "observation timed out without durable progress" }
      }
      const elapsedMs = clock.now() - startTime
      if (elapsedMs < startupGraceMs) {
        return { kind: "pending", diagnostics: { elapsed_ms: elapsedMs } }
      }
      return { kind: "unknown", reason: "no durable progress after startup grace" }
    }
    let result = classifyReadResult(read, req.childSessionID, req.requestMessageID)
    if (result.kind === "continue" && result.activity?.newest !== undefined) {
      // D1.1: a matching in-flight assistant message is durable progress and
      // never routes through the no-message startup-grace branch.
      const activity = result.activity
      const newest = result.activity.newest
      durableProgress = true
      const probed = req.sessionStatus === undefined
        ? NO_STATUS_PROBE
        : await probeStatus(waitBudgetMs === 0 ? 0 : Math.min(SNAPSHOT_READ_TRANSPORT_MS, Math.max(remainingMs(), MIN_READ_TRANSPORT_MS)))
      if ("aborted" in probed) return { kind: "pending", diagnostics: { aborted: true } }
      const now = clock.now()
      const condStartup = now - startTime >= startupGraceMs
      const condQuiet = activity.lastActivityAt !== undefined && now - activity.lastActivityAt >= idleConfirmMs
      if (req.sessionStatus !== undefined && probed.live === "idle" && condStartup && condQuiet) {
        // Cond.5 TOCTOU guard: re-read after the status probe confirms idle.
        const read2 = await readMessages(req, waitBudgetMs === 0 ? 0 : Math.max(remainingMs(), MIN_READ_TRANSPORT_MS))
        if (signal?.aborted) {
          return { kind: "pending", diagnostics: { aborted: true } }
        }
        if (read2.kind === "messages") {
          const result2 = classifyReadResult(read2, req.childSessionID, req.requestMessageID)
          if (result2.kind === "terminal") return result2.outcome
          if (result2.kind === "continue" && result2.activity?.lastActivityAt === activity.lastActivityAt) {
            const superseded = read2.messages.at(-1)?.info.id !== newest.id
            return {
              kind: "cancelled",
              hostStopped: true,
              reason: superseded
                ? "child session became idle after request message was superseded before completion"
                : "child session stopped by host before response completed",
            }
          }
        }
      }
      const health = inFlightHealth(activity, now, probed.live, stalledSuspectMs)
      result = { kind: "continue", state: "pending", diagnostics: { ...result.diagnostics, ...health } }
      // D2.2 early soft-yield: only with a running tool satisfying all four
      // conditions, and never on a waitBudgetMs === 0 snapshot.
      if (waitBudgetMs > 0 && activity.runningToolStartedAt !== undefined && health.stalled_suspect === true) {
        const condToolAge = health.running_tool_ms !== undefined && health.running_tool_ms >= stalledSuspectMs
        const condQuietAge = health.last_activity_ms !== undefined && health.last_activity_ms >= stalledSuspectMs
        const condToolWindow = now - Math.max(startTime, activity.runningToolStartedAt) >= stalledSuspectMs
        const condQuietWindow = now - Math.max(startTime, activity.lastActivityAt ?? startTime) >= stalledSuspectMs
        if (condToolAge && condQuietAge && condToolWindow && condQuietWindow) {
          lastNonTerminal = { state: "pending", diagnostics: result.diagnostics }
          break
        }
      }
    } else if (result.kind === "continue" && result.state === "pending" && result.diagnostics === undefined) {
      const probed = req.sessionStatus === undefined
        ? NO_STATUS_PROBE
        : await probeStatus(waitBudgetMs === 0 ? 0 : Math.max(remainingMs(), MIN_READ_TRANSPORT_MS))
      if ("aborted" in probed) return { kind: "pending", diagnostics: { aborted: true } }
      const probeFailure = probed.failed
      if (probed.live === "busy" || probed.live === "retry") {
        result = { kind: "continue", state: "pending", diagnostics: { status: probed.live } }
      } else {
        result = classifyNoMessagesForReq(clock.now() - startTime)
        if (probeFailure !== undefined) {
          result = result.kind === "continue" && result.state === "pending"
            ? { ...result, diagnostics: { ...result.diagnostics, reason: probeFailure } }
            : { kind: "continue", state: "unknown", reason: `no durable progress after startup grace; ${probeFailure}` }
        }
      }
    }
    if (result.kind === "terminal") {
      return result.outcome
    }
    lastNonTerminal = { state: result.state, diagnostics: result.diagnostics, reason: result.reason }
    const status = result.diagnostics?.status
    if (result.state === "pending" && (status === "active" || status === "tool-calls" || status === "busy" || status === "retry")) {
      durableProgress = true
    }
    const sleepMs = Math.min(POLL_INTERVAL_MS, remainingMs())
    if (sleepMs <= 0) break
    try {
      await clock.sleep(sleepMs, signal)
    } catch (error: unknown) {
      if (signal?.aborted || (error instanceof DOMException && error.name === "AbortError")) {
        return { kind: "pending", diagnostics: { aborted: true } }
      }
      return { kind: "unknown", reason: `observation clock failed: ${errorText(error)}` }
    }
  }

  if (lastNonTerminal?.state === "pending") {
    return { kind: "pending", diagnostics: lastNonTerminal.diagnostics }
  }
  return { kind: "unknown", reason: lastNonTerminal?.reason ?? "observation window expired without terminal evidence" }
}
