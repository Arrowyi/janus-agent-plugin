import type { SdkAssistantMessage, SdkMessageWithParts, SdkPart } from "./dispatch-contract.ts"
import { errorText, isRetryableModelError } from "./dispatch-helpers.ts"
import type { ObservationDiagnostics, ObservationOutcome } from "./dispatch-observer.ts"

export type ClassifyResult =
  | { readonly kind: "terminal"; readonly outcome: ObservationOutcome }
  | {
      readonly kind: "continue"
      readonly state: "pending" | "unknown"
      readonly diagnostics?: ObservationDiagnostics
      readonly reason?: string
      /** Activity evidence for a matching in-flight assistant message. */
      readonly activity?: MatchingActivity
    }

/**
 * Activity extracted from the messages matching one dispatched request. The
 * observer uses it for host-stop detection (last quiet time) and stuck-tool
 * soft-yield (running tool + its start).
 */
export interface MatchingActivity {
  /** Newest matching assistant message, or undefined when none matched. */
  readonly newest?: SdkAssistantMessage
  /** Parts of {@link newest}. */
  readonly newestParts: ReadonlyArray<SdkPart>
  /** True when {@link newest} is the last message in the read list. */
  readonly isTailMessage: boolean
  /** Newest finite non-negative message/part/tool-state timestamp. */
  readonly lastActivityAt?: number
  /** Trimmed non-empty name of the currently running/pending tool, if any. */
  readonly runningTool?: string
  /** Finite non-negative start time of {@link runningTool}, if any. */
  readonly runningToolStartedAt?: number
}

export function extractUsableText(parts: ReadonlyArray<SdkPart> | undefined | null): string | undefined {
  if (!Array.isArray(parts)) return undefined
  const texts: string[] = []
  for (const part of parts) {
    if (part.type !== "text" || typeof part.text !== "string") continue
    if (part.ignored === true || part.synthetic === true) continue
    texts.push(part.text)
  }
  const joined = texts.join("\n").trim()
  return joined.length > 0 ? joined : undefined
}

function sortMatchingMessages(messages: ReadonlyArray<SdkMessageWithParts>, childSessionID: string, requestMessageID: string) {
  const matching: Array<{ readonly message: SdkAssistantMessage; readonly parts: ReadonlyArray<SdkPart> }> = []
  for (const message of messages) {
    const info = message.info
    if (info.role !== "assistant" || !("parentID" in info)) continue
    if (info.sessionID !== childSessionID || info.parentID !== requestMessageID) continue
    matching.push({ message: info, parts: message.parts })
  }
  matching.sort((a, b) => {
    const ta = a.message.time?.created ?? 0
    const tb = b.message.time?.created ?? 0
    return ta !== tb ? ta - tb : a.message.id.localeCompare(b.message.id)
  })
  return matching
}

function finiteNonNegative(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined
}

type ToolPart = Extract<SdkPart, { readonly type: "tool" }>

function toolStart(part: ToolPart): number | undefined {
  const time = (part.state as { readonly time?: { readonly start?: unknown } }).time
  return finiteNonNegative(time?.start)
}

function partTimestamps(part: SdkPart): number[] {
  const timestamps: number[] = []
  const time = (part as { readonly time?: { readonly start?: unknown; readonly end?: unknown; readonly created?: unknown } }).time
  if (time !== undefined && time !== null) {
    for (const value of [time.start, time.end, time.created]) {
      const ts = finiteNonNegative(value)
      if (ts !== undefined) timestamps.push(ts)
    }
  }
  if (part.type === "tool") {
    const stateTime = (part.state as { readonly time?: { readonly start?: unknown; readonly end?: unknown } }).time
    if (stateTime !== undefined && stateTime !== null) {
      for (const value of [stateTime.start, stateTime.end]) {
        const ts = finiteNonNegative(value)
        if (ts !== undefined) timestamps.push(ts)
      }
    }
  }
  return timestamps
}

function selectRunningTool(parts: ReadonlyArray<SdkPart>): { runningTool?: string; runningToolStartedAt?: number } {
  const candidates = parts.filter(
    (part): part is ToolPart => part.type === "tool" && (part.state.status === "running" || part.state.status === "pending"),
  )
  if (candidates.length === 0) return {}
  // Prefer the longest-running "running" tool part (smallest finite start);
  // fall back to the first running/pending part when none carries a start.
  const runningWithStart = candidates.filter((part) => part.state.status === "running" && toolStart(part) !== undefined)
  let chosen: ToolPart | undefined = runningWithStart.reduce<ToolPart | undefined>(
    (min, part) => (min === undefined || toolStart(part)! < toolStart(min)! ? part : min),
    undefined,
  )
  chosen ??= candidates[0]
  if (chosen === undefined) return {}
  const tool = typeof chosen.tool === "string" ? chosen.tool.trim() : ""
  return {
    runningTool: tool.length > 0 ? tool : undefined,
    runningToolStartedAt: toolStart(chosen),
  }
}

/**
 * Extracts activity evidence from the messages matching one request. The
 * newest matching assistant message drives host-stop detection; the running
 * tool is read from its parts for stuck-tool soft-yield.
 */
export function extractMatchingActivity(
  messages: ReadonlyArray<SdkMessageWithParts>,
  childSessionID: string,
  requestMessageID: string,
): MatchingActivity {
  const matching = sortMatchingMessages(messages, childSessionID, requestMessageID)
  const newest = matching.at(-1)
  const isTailMessage = newest !== undefined && messages.at(-1)?.info.id === newest.message.id
  let lastActivityAt: number | undefined
  for (const entry of matching) {
    for (const value of [entry.message.time?.created, entry.message.time?.completed]) {
      const ts = finiteNonNegative(value)
      if (ts !== undefined && (lastActivityAt === undefined || ts > lastActivityAt)) lastActivityAt = ts
    }
    for (const part of entry.parts) {
      for (const ts of partTimestamps(part)) {
        if (lastActivityAt === undefined || ts > lastActivityAt) lastActivityAt = ts
      }
    }
  }
  const running = newest === undefined ? {} : selectRunningTool(newest.parts)
  return {
    newest: newest?.message,
    newestParts: newest?.parts ?? [],
    isTailMessage,
    lastActivityAt,
    runningTool: running.runningTool,
    runningToolStartedAt: running.runningToolStartedAt,
  }
}

function classifyMatchingStep(newest: SdkAssistantMessage, parts: ReadonlyArray<SdkPart>): ClassifyResult {
  if (newest.time?.completed === undefined) return { kind: "continue", state: "pending", diagnostics: { status: "active" } }
  if (newest.error !== undefined) {
    const error = newest.error
    const name = typeof error === "object" && error !== null && "name" in error ? error.name : undefined
    if (name === "MessageAbortedError") return { kind: "terminal", outcome: { kind: "cancelled" } }
    const data = typeof error === "object" && error !== null && "data" in error ? error.data : undefined
    const flag = typeof data === "object" && data !== null && "isRetryable" in data ? data.isRetryable : undefined
    const retryable = flag === undefined ? isRetryableModelError(error) : name === "APIError" && flag === true
    return { kind: "terminal", outcome: { kind: "failed", error: errorText(error), retryable } }
  }
  if (newest.finish === "tool-calls") return { kind: "continue", state: "pending", diagnostics: { status: "tool-calls" } }
  if (newest.finish === "stop") {
    if (parts.some((part) => part.type === "tool" && (part.state.status === "running" || part.state.status === "pending"))) {
      return { kind: "continue", state: "pending", diagnostics: { status: "tool-calls" } }
    }
    const text = extractUsableText(parts)
    return text === undefined
      ? { kind: "terminal", outcome: { kind: "unknown", reason: "completed stop produced no usable text" } }
      : { kind: "terminal", outcome: { kind: "completed", text } }
  }
  if (newest.finish === "length") return { kind: "terminal", outcome: { kind: "unknown", reason: "finish length indicates partial output" } }
  return { kind: "terminal", outcome: { kind: "unknown", reason: `completed message has unsupported finish marker ${String(newest.finish)}` } }
}

export function classifyReadResult(readResult: { readonly kind: "messages"; readonly messages: ReadonlyArray<SdkMessageWithParts> } | { readonly kind: "error"; readonly reason: string }, childSessionID: string, requestMessageID: string): ClassifyResult {
  if (readResult.kind === "error") return { kind: "terminal", outcome: { kind: "unknown", reason: readResult.reason } }
  const newest = sortMatchingMessages(readResult.messages, childSessionID, requestMessageID).at(-1)
  if (newest === undefined) return { kind: "continue", state: "pending" }
  const classified = classifyMatchingStep(newest.message, newest.parts)
  if (classified.kind !== "continue") return classified
  return { ...classified, activity: extractMatchingActivity(readResult.messages, childSessionID, requestMessageID) }
}
