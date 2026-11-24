import { describe, expect, it } from "bun:test"
import { getEventListeners } from "node:events"
import { errorText } from "./dispatch-helpers.ts"
import type { SdkPart } from "./dispatch-contract.ts"
type ToolPart = Extract<SdkPart, { readonly type: "tool" }>
import {
  FAKE_DIRECTORY,
  FAKE_JOB_ID,
  createFakeClock,
  createFakePendingAsksProbe,
  createFakeSdk,
  seedLivePermissionAsk,
  seedPermissionAsk,
  type FakeSdk,
} from "./dispatch-test-fixtures.ts"
import type {
  Clock,
  DispatchSdk,
  PendingAsk,
  SdkAssistantMessage,
  SdkMessageWithParts,
  SdkSession,
  SdkTextPart,
} from "./dispatch-contract.ts"
import { DISPATCH_MARKER, PendingAskSchema } from "./dispatch-contract.ts"
import { observeDispatch, extractUsableText, POLL_INTERVAL_MS, SNAPSHOT_READ_TRANSPORT_MS, STALLED_SUSPECT_MS } from "./dispatch-observer.ts"
import { MAX_LINEAGE_DEPTH, PermissionAskRegistry, RE_YIELD_DAMPING_MS, sanitizePendingAsk } from "./permission-ask.ts"
import { observeAttempt } from "./dispatch-attempt.ts"
import { observationToOutcome } from "./dispatch-helpers.ts"
import { extractMatchingActivity } from "./dispatch-classifier.ts"
import { PRODUCTION_WAIT_BUDGET_MS } from "./dispatch-contract.ts"
import type { ObservationOutcome } from "./dispatch-observer.ts"

// Local helpers and fake — dispatch-test-fixtures.ts is shared with the
// parallel task 2 worker and must not be edited here.

const CHILD_SESSION_ID = "ses_child"
const REQUEST_MESSAGE_ID = "msg-request-1"

type LocalSdkResult<T> = { data?: T; error?: unknown }

function makeText(text: string, opts?: { readonly synthetic?: boolean; readonly ignored?: boolean }): SdkTextPart {
  return { type: "text", text, ...opts }
}

function makeAssistant(
  id: string,
  overrides: Partial<SdkAssistantMessage> = {},
): SdkAssistantMessage {
  return {
    id,
    sessionID: CHILD_SESSION_ID,
    role: "assistant",
    parentID: REQUEST_MESSAGE_ID,
    time: { created: 1000 },
    modelID: "model",
    providerID: "provider",
    ...overrides,
  }
}

function makeMessage(
  info: SdkAssistantMessage | { readonly role: string; readonly id: string; readonly sessionID: string },
  parts: ReadonlyArray<SdkTextPart> | null,
): SdkMessageWithParts {
  return { info, parts: parts ?? [] }
}

function makeUserMessage(id: string, sessionID: string): SdkMessageWithParts {
  return {
    info: { role: "user", id, sessionID },
    parts: [{ type: "text", text: "user" }],
  }
}

type SeededFakeSdk = DispatchSdk & {
  seedMessages(sessionID: string, messages: ReadonlyArray<SdkMessageWithParts>): void
  setMessagesFailure(error: unknown): void
  setMessagesLatency(ms: number): void
  readonly calls: ReadonlyArray<{ readonly method: string; readonly input: unknown }>
}

function createSeededFakeSdk(): SeededFakeSdk {
  const messageStore = new Map<string, SdkMessageWithParts[]>()
  const calls: Array<{ method: string; input: unknown }> = []
  let failure: unknown | undefined
  let latencyMs = 0

  function stubSessionMethod<TInput, TOutput>(
    method: string,
    fn: (input: TInput) => LocalSdkResult<TOutput>,
  ): (input: TInput) => Promise<LocalSdkResult<TOutput>> {
    return async (input: TInput) => {
      calls.push({ method, input })
      if (latencyMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, latencyMs))
      }
      if (failure !== undefined) {
        const err = failure
        failure = undefined
        throw err
      }
      return fn(input)
    }
  }

  return {
    seedMessages(sessionID, messages) {
      messageStore.set(sessionID, [...messages])
    },
    setMessagesFailure(error) {
      failure = error
    },
    setMessagesLatency(ms) {
      latencyMs = ms
    },
    get calls() {
      return calls
    },
    session: {
      create: stubSessionMethod("create", () => ({ data: { id: "ses_new" } as SdkSession })),
      prompt: stubSessionMethod("prompt", () => ({ data: undefined })),
      promptAsync: stubSessionMethod("promptAsync", () => ({ data: undefined })),
      abort: stubSessionMethod("abort", () => ({ data: true })),
      get: stubSessionMethod("get", () => ({ data: undefined })),
      children: stubSessionMethod("children", () => ({ data: [] as SdkSession[] })),
      messages: stubSessionMethod(
        "messages",
        (input: { path: { id: string }; query?: { directory?: string } }) => {
          const list = messageStore.get(input.path.id) ?? []
          return { data: list }
        },
      ),
      status: stubSessionMethod("status", () => ({ data: {} })),
    },
  }
}

function baseRequest(
  sdk: SeededFakeSdk,
  clock: Clock,
  overrides: Partial<{
    readonly waitBudgetMs: number
    readonly signal: AbortSignal
    readonly sessionStatus: () => Promise<{ readonly status: string } | undefined>
    readonly startupGraceMs: number
    readonly idleConfirmMs: number
    readonly stalledSuspectMs: number
  }> = {},
) {
  return {
    sdk,
    jobID: FAKE_JOB_ID,
    childSessionID: CHILD_SESSION_ID,
    requestMessageID: REQUEST_MESSAGE_ID,
    directory: FAKE_DIRECTORY,
    waitBudgetMs: 50,
    clock,
    startupGraceMs: 10,
    ...overrides,
  }
}

async function advanceClockTo(
  clock: Clock & { advance(ms: number): void },
  budgetMs: number,
): Promise<void> {
  // Advance one millisecond at a time, yielding each step so the observer has
  // a chance to register its next poll sleeper before we jump past it.
  const target = clock.now() + budgetMs
  while (clock.now() < target) {
    await Promise.resolve()
    clock.advance(1)
  }
}

async function runObservation(
  sdk: SeededFakeSdk,
  clock: Clock & { advance(ms: number): void },
  overrides: Parameters<typeof baseRequest>[2] = {},
): Promise<ObservationOutcome> {
  const req = baseRequest(sdk, clock, overrides)
  const promise = observeDispatch(req)
  await advanceClockTo(clock, req.waitBudgetMs)
  return await promise
}

function createCustomSdk(
  messages: (input: { path: { id: string }; query?: { directory?: string } }) => Promise<LocalSdkResult<ReadonlyArray<SdkMessageWithParts>>>,
): DispatchSdk {
  return {
    session: {
      create: async () => ({ data: { id: "ses_custom" } as SdkSession }),
      prompt: async () => ({ data: undefined }),
      promptAsync: async () => ({ data: undefined }),
      abort: async () => ({ data: true }),
      get: async () => ({ data: undefined }),
      children: async () => ({ data: [] as SdkSession[] }),
      messages,
      status: async () => ({ data: {} }),
    },
  } as DispatchSdk
}

function createRealisticClock(startMs = 0): Clock & { advance(ms: number): void } {
  let now = startMs
  const sleepers = new Set<{ deadline: number; resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> | null }>()
  return {
    now: () => now,
    sleep: (ms, signal) => {
      if (signal?.aborted) {
        return Promise.reject(new DOMException("aborted", "AbortError"))
      }
      if (ms <= 0) {
        return Promise.resolve()
      }
      return new Promise<void>((resolve, reject) => {
        const entry: { deadline: number; resolve: () => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> | null } = {
          deadline: now + ms,
          resolve,
          reject,
          timer: null,
        }
        sleepers.add(entry)
        entry.timer = setTimeout(() => {
          sleepers.delete(entry)
          now += ms
          resolve()
        }, ms)
        if (signal) {
          signal.addEventListener("abort", () => {
            if (entry.timer !== null) clearTimeout(entry.timer)
            sleepers.delete(entry)
            reject(new DOMException("aborted", "AbortError"))
          }, { once: true })
        }
      })
    },
    advance: (ms) => {
      now += ms
      for (const entry of [...sleepers]) {
        if (entry.deadline <= now && entry.timer !== null) {
          clearTimeout(entry.timer)
          sleepers.delete(entry)
          entry.resolve()
        }
      }
    },
  }
}

function createCountingClock(startMs = 0): Clock & { advance(ms: number): void; readonly pendingSleepCount: number } {
  let now = startMs
  const sleepers = new Set<{ deadline: number; resolve: () => void; reject: (err: Error) => void }>()
  return {
    now: () => now,
    sleep: (ms, signal) => {
      if (signal?.aborted) {
        return Promise.reject(new DOMException("aborted", "AbortError"))
      }
      return new Promise<void>((resolve, reject) => {
        const entry = { deadline: now + ms, resolve, reject }
        sleepers.add(entry)
        if (signal) {
          signal.addEventListener("abort", () => {
            sleepers.delete(entry)
            reject(new DOMException("aborted", "AbortError"))
          }, { once: true })
        }
      })
    },
    advance: (ms) => {
      now += ms
      for (const entry of [...sleepers]) {
        if (entry.deadline <= now) {
          sleepers.delete(entry)
          entry.resolve()
        }
      }
    },
    get pendingSleepCount() {
      return sleepers.size
    },
  }
}

describe("extractUsableText", () => {
  it("joins non-ignored, non-synthetic text parts and trims", () => {
    expect(extractUsableText([makeText("hello"), makeText("world")])).toBe("hello\nworld")
    expect(extractUsableText([makeText("  spaced  ")])).toBe("spaced")
  })

  it("drops ignored or synthetic parts", () => {
    expect(extractUsableText([makeText("keep"), makeText("drop", { ignored: true })])).toBe("keep")
    expect(extractUsableText([makeText("drop", { synthetic: true }), makeText("keep")])).toBe("keep")
  })

  it("returns undefined for empty, blank or missing parts", () => {
    expect(extractUsableText([])).toBeUndefined()
    expect(extractUsableText([makeText("   ")])).toBeUndefined()
    expect(extractUsableText(undefined as unknown as SdkTextPart[])).toBeUndefined()
    expect(extractUsableText(null as unknown as SdkTextPart[])).toBeUndefined()
  })
})

describe("observeDispatch", () => {
  for (const budget of [0, 20]) {
    it(`rollback-6 cancels local messages waiting without signalling SDK budget ${budget}`, async () => {
      // Given an in-flight SDK read controlled independently of local waiting.
      const sdk = createSeededFakeSdk()
      const controller = new AbortController()
      const entered = Promise.withResolvers<void>()
      const released = Promise.withResolvers<LocalSdkResult<ReadonlyArray<SdkMessageWithParts>>>()
      let transportSignal: AbortSignal | undefined
      sdk.session.messages = async (input) => {
        const candidate = "signal" in input ? input.signal : undefined
        if (candidate instanceof AbortSignal) {
          transportSignal = candidate
          candidate.addEventListener("abort", () => released.reject(new DOMException("aborted", "AbortError")), { once: true })
        }
        entered.resolve()
        return released.promise
      }
      // When the caller aborts an active SDK read.
      const result = observeDispatch(baseRequest(sdk, createFakeClock(), { waitBudgetMs: budget, signal: controller.signal }))
      await entered.promise
      controller.abort()
      try {
        // Then cancellation stays local and never reaches SDK transport.
        expect(transportSignal).toBeUndefined()
        expect(await result).toMatchObject({ kind: "pending", diagnostics: { aborted: true } })
      } finally { released.resolve({ data: [] }) }
      expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
    })
  }
  for (const error of [{ name: "APIError", message: "SECRET_TOKEN_abc123", statusCode: 429 }, { name: "APIError", data: { message: "SECRET_TOKEN_nested", statusCode: 429 } }, new Error("SECRET_TOKEN_xyz"), "SECRET_TOKEN_qrs", { name: "SECRET_TOKEN_name", message: "SECRET_TOKEN_message" }]) {
    for (const route of ["helper", "read", "assistant"] as const) {
      it(`round2-5 redacts ${typeof error} on ${route} path ${errorText(error)}`, async () => {
        // Given credentials embedded inside normally forwarded fields.
        const sdk = createSeededFakeSdk()
        if (route === "read") sdk.setMessagesFailure(error)
        if (route === "assistant") sdk.seedMessages(CHILD_SESSION_ID, [makeMessage(makeAssistant("msg-error", { time: { created: 0, completed: 1 }, error }), [])])
        // When converting the error at the public diagnostic boundary.
        const result = route === "helper" ? errorText(error) : await observeDispatch(baseRequest(sdk, createFakeClock(), { waitBudgetMs: 0 }))
        const text = typeof result === "string" ? result : result.kind === "failed" ? result.error : result.kind === "unknown" ? result.reason : ""
        // Then only recognized tags and numeric status can survive.
        expect(text).not.toContain("SECRET_TOKEN")
        if (typeof error === "object" && "name" in error && error.name === "APIError") {
          expect(text).toContain("APIError")
          expect(text).toContain("429")
        } else expect(text).toBe("unrecognized provider error")
      })
    }
  }
  it("fix-3 removes caller relay listeners when successful reads settle normally", async () => {
    // Given a final result and the same caller signal reused across observations.
    const sdk = createSeededFakeSdk()
    const clock = createFakeClock()
    const controller = new AbortController()
    sdk.seedMessages(CHILD_SESSION_ID, [makeMessage(makeAssistant("msg-final", { finish: "stop", time: { created: 0, completed: 1 } }), [makeText("done")])])
    // When several successful bounded reads settle without caller abort.
    for (let i = 0; i < 3; i++) await observeDispatch(baseRequest(sdk, clock, { signal: controller.signal }))
    // Then no read relays remain registered on the caller signal.
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
  })

  it("fix-4 distinguishes a rejected status probe from successful missing status", async () => {
    // Given identical empty sessions within startup grace.
    const sdk = createSeededFakeSdk()
    const clock = createFakeClock()
    const missing = await observeDispatch(baseRequest(sdk, clock, { waitBudgetMs: 0, sessionStatus: async () => undefined }))
    // When the status query rejects instead of returning no data.
    const failed = await observeDispatch(baseRequest(sdk, clock, { waitBudgetMs: 0, sessionStatus: async () => { throw new Error("status transport failed") } }))
    // Then the nonterminal outcome is unchanged but diagnostics distinguish failure.
    expect(failed.kind).toBe("pending")
    expect(failed).not.toEqual(missing)
  })

  for (const route of ["read", "assistant", "helper"] as const) {
    it(`fix-6 redacts arbitrary structured payload fields on the ${route} error path`, async () => {
      // Given a verbose SDK payload with allowlisted diagnostics and private metadata.
      const error = { name: "APIError", message: "provider unavailable", statusCode: 503, headers: "PRIVATE_HEADERS", body: "PRIVATE_BODY", url: "PRIVATE_URL", prompt: "PRIVATE_PROMPT", source: "PRIVATE_SOURCE", metadata: "PRIVATE_META", request: "PRIVATE_REQUEST", response: "PRIVATE_RESPONSE", token: "PRIVATE_TOKEN" }
      const sdk = createSeededFakeSdk()
      if (route === "read") sdk.setMessagesFailure(error)
      if (route === "assistant") sdk.seedMessages(CHILD_SESSION_ID, [makeMessage(makeAssistant("msg-error", { time: { created: 0, completed: 1 }, error }), [])])
      // When converting the error into diagnostic text.
      const result = route === "helper" ? errorText(error) : await observeDispatch(baseRequest(sdk, createFakeClock(), { waitBudgetMs: 0 }))
      const text = typeof result === "string" ? result : result.kind === "failed" ? result.error : result.kind === "unknown" ? result.reason : ""
      // Then only allowlisted fields reach the caller.
      expect(text).toContain("APIError")
      expect(text).toContain("503")
      expect(text).not.toContain("PRIVATE_")
    })
  }

  for (const error of ["429 rate limited", { message: "429 rate limited" }]) {
    it(`fix-8 retries compatible ${typeof error} errors when structured retryability is absent`, async () => {
      // Given a completed error with explicit compatible text but no structured flag.
      const sdk = createSeededFakeSdk()
      sdk.seedMessages(CHILD_SESSION_ID, [makeMessage(makeAssistant("msg-error", { time: { created: 0, completed: 1 }, error }), [])])
      // When classifying the error.
      const result = await observeDispatch(baseRequest(sdk, createFakeClock(), { waitBudgetMs: 0 }))
      // Then compatibility retryability is reachable.
      expect(result).toMatchObject({ kind: "failed", retryable: true })
    })
  }

  it("fix-8 preserves explicit false retryability despite compatible error text", async () => {
    // Given an authoritative host flag contradicting the text compatibility fallback.
    const sdk = createSeededFakeSdk()
    sdk.seedMessages(CHILD_SESSION_ID, [makeMessage(makeAssistant("msg-error", { time: { created: 0, completed: 1 }, error: { name: "APIError", data: { message: "429 rate limited", isRetryable: false } } }), [])])
    // When classifying.
    const result = await observeDispatch(baseRequest(sdk, createFakeClock(), { waitBudgetMs: 0 }))
    // Then explicit false remains authoritative.
    expect(result).toMatchObject({ kind: "failed", retryable: false })
  })

  for (const status of ["running", "pending"] as const) {
    it(`fix-9 does not complete a stop message when a real SDK tool part is ${status}`, async () => {
      // Given a ToolPart from the real SDK union; finish/completed impose no type restriction.
      const tool: ToolPart = { id: "prt-tool", messageID: "msg-final", sessionID: CHILD_SESSION_ID, type: "tool", tool: "read", callID: "call-1", state: status === "running" ? { status, input: {}, time: { start: 0 } } : { status, input: {}, raw: "" } }
      const sdk = createSeededFakeSdk()
      const info = makeAssistant("msg-final", { finish: "stop", time: { created: 0, completed: 1 } })
      const messages = [{ info, parts: [makeText("report"), tool] }]
      sdk.session.messages = async () => ({ data: messages })
      // When observing the final step.
      const result = await observeDispatch(baseRequest(sdk, createFakeClock(), { waitBudgetMs: 0 }))
      // Then unfinished tool work blocks report credit.
      expect(result.kind).toBe("pending")
    })
  }
  it("returns completed with the newest final stop text, ignoring tool steps and unrelated messages", async () => {
    const sdk = createSeededFakeSdk()
    const clock = createFakeClock(0)

    sdk.seedMessages(CHILD_SESSION_ID, [
      makeUserMessage("msg-other-user", CHILD_SESSION_ID),
      makeMessage(makeAssistant("msg-tool", { time: { created: 1000, completed: 1500 }, finish: "tool-calls" }), [
        makeText("intermediate tool result"),
      ]),
      makeMessage(makeAssistant("msg-active", { time: { created: 2000 } }), [makeText("thinking...")]),
      makeMessage(
        makeAssistant("msg-final", { time: { created: 3000, completed: 3500 }, finish: "stop" }),
        [makeText("final report")],
      ),
      // Unrelated session/parentID
      makeMessage(
        makeAssistant("msg-wrong-parent", { parentID: "msg-other", time: { created: 4000, completed: 4500 }, finish: "stop" }),
        [makeText("wrong")],
      ),
      makeMessage(
        { ...makeAssistant("msg-wrong-session", { time: { created: 5000, completed: 5500 }, finish: "stop" }), sessionID: "ses_other" },
        [makeText("wrong session")],
      ),
      // Synthetic/ignored journal text in matching step must not poison text
      makeMessage(makeAssistant("msg-final", { time: { created: 3000, completed: 3500 }, finish: "stop" }), [
        makeText("final report"),
        makeText("journal", { synthetic: true, ignored: true }),
      ]),
    ])

    const result = await runObservation(sdk, clock)

    expect(result).toEqual({ kind: "completed", text: "final report" })
    expect(sdk.calls.filter((c) => c.method === "messages").length).toBe(1)
    expect(sdk.calls.some((c) => c.method === "abort")).toBe(false)
    for (const call of sdk.calls) {
      if (typeof call.input === "object" && call.input !== null && "query" in call.input) {
        expect((call.input as { query: { directory?: string } }).query.directory).toBe(FAKE_DIRECTORY)
      }
    }
  })

  it("yields pending when the newest matching step is an active tool-calls step", async () => {
    const sdk = createSeededFakeSdk()
    const clock = createFakeClock(0)

    sdk.seedMessages(CHILD_SESSION_ID, [
      makeMessage(makeAssistant("msg-tool", { time: { created: 1000, completed: 1500 }, finish: "tool-calls" }), [
        makeText("intermediate"),
      ]),
      makeMessage(makeAssistant("msg-active", { time: { created: 2000 } }), [makeText("still working")]),
    ])

    const result = await runObservation(sdk, clock)

    expect(result.kind).toBe("pending")
    expect(sdk.calls.filter((c) => c.method === "messages").length).toBeGreaterThanOrEqual(2)
  })

  it("yields pending when a completed tool-calls step is followed by a newer active step at expiry", async () => {
    const sdk = createSeededFakeSdk()
    const clock = createFakeClock(0)

    sdk.seedMessages(CHILD_SESSION_ID, [
      makeMessage(makeAssistant("msg-tool", { time: { created: 1000, completed: 1500 }, finish: "tool-calls" }), [
        makeText("intermediate text"),
      ]),
      makeMessage(makeAssistant("msg-active", { time: { created: 2000 } }), [makeText("still active")]),
    ])

    const result = await runObservation(sdk, clock, { waitBudgetMs: 10 })

    expect(result.kind).toBe("pending")
  })

  it("does not credit intermediate text with a completed time as success", async () => {
    const sdk = createSeededFakeSdk()
    const clock = createFakeClock(0)

    sdk.seedMessages(CHILD_SESSION_ID, [
      makeMessage(makeAssistant("msg-intermediate", { time: { created: 1000, completed: 1500 }, finish: "tool-calls" }), [
        makeText("looks final but is not"),
      ]),
    ])

    const result = await runObservation(sdk, clock, { waitBudgetMs: 10 })

    expect(result.kind).not.toBe("completed")
  })

  it("returns unknown for a final length finish", async () => {
    const sdk = createSeededFakeSdk()
    const clock = createFakeClock(0)

    sdk.seedMessages(CHILD_SESSION_ID, [
      makeMessage(makeAssistant("msg-length", { time: { created: 1000, completed: 1500 }, finish: "length" }), [
        makeText("partial"),
      ]),
    ])

    const result = await runObservation(sdk, clock)

    expect(result.kind).toBe("unknown")
  })

  it("returns unknown when finish is absent on a completed message", async () => {
    const sdk = createSeededFakeSdk()
    const clock = createFakeClock(0)

    sdk.seedMessages(CHILD_SESSION_ID, [
      makeMessage(makeAssistant("msg-no-finish", { time: { created: 1000, completed: 1500 } }), [makeText("text")]),
    ])

    const result = await runObservation(sdk, clock)

    expect(result.kind).toBe("unknown")
  })

  it("classifies MessageAbortedError with completed time as cancelled even with partial text", async () => {
    const sdk = createSeededFakeSdk()
    const clock = createFakeClock(0)

    sdk.seedMessages(CHILD_SESSION_ID, [
      makeMessage(
        makeAssistant("msg-abort", {
          time: { created: 1000, completed: 1500 },
          finish: "stop",
          error: { name: "MessageAbortedError", data: { message: "aborted" } },
        }),
        [makeText("partial text")],
      ),
    ])

    const result = await runObservation(sdk, clock)

    expect(result).toEqual({ kind: "cancelled" })
  })

  it("classifies ApiError as failed and exposes retryability", async () => {
    const sdk = createSeededFakeSdk()
    const clock = createFakeClock(0)

    sdk.seedMessages(CHILD_SESSION_ID, [
      makeMessage(
        makeAssistant("msg-error", {
          time: { created: 1000, completed: 1500 },
          error: { name: "APIError", data: { message: "payment required", statusCode: 402, isRetryable: true } },
        }),
        [makeText("partial")],
      ),
    ])

    const result = await runObservation(sdk, clock)

    expect(result.kind).toBe("failed")
    if (result.kind === "failed") {
      expect(result.retryable).toBe(true)
    }
  })

  it("returns pending for busy/retry session status without final evidence", async () => {
    const sdk = createSeededFakeSdk()
    const clock = createFakeClock(0)

    sdk.seedMessages(CHILD_SESSION_ID, [])

    const result = await runObservation(
      sdk,
      clock,
      {
        waitBudgetMs: 20,
        sessionStatus: async () => ({ status: "busy" }),
      },
    )

    expect(result.kind).toBe("pending")
    if (result.kind === "pending") {
      expect(result.diagnostics?.status).toBe("busy")
    }
  })

  it("returns pending within startup grace when no assistant message exists", async () => {
    const sdk = createSeededFakeSdk()
    const clock = createFakeClock(0)

    sdk.seedMessages(CHILD_SESSION_ID, [])

    const result = await runObservation(sdk, clock, { waitBudgetMs: 9 })

    expect(result.kind).toBe("pending")
  })

  it("returns unknown after startup grace with no liveness signal", async () => {
    const sdk = createSeededFakeSdk()
    const clock = createFakeClock(0)

    sdk.seedMessages(CHILD_SESSION_ID, [])

    const result = await runObservation(sdk, clock, { waitBudgetMs: 11 })

    expect(result.kind).toBe("unknown")
  })

  it("returns unknown when the session status is idle after startup grace", async () => {
    const sdk = createSeededFakeSdk()
    const clock = createFakeClock(0)

    sdk.seedMessages(CHILD_SESSION_ID, [])

    const result = await runObservation(
      sdk,
      clock,
      {
        waitBudgetMs: 11,
        sessionStatus: async () => ({ status: "idle" }),
      },
    )

    expect(result.kind).toBe("unknown")
  })

  it("returns unknown when get returns nothing (missing session) and grace expired", async () => {
    const sdk = createSeededFakeSdk()
    const clock = createFakeClock(0)

    sdk.seedMessages(CHILD_SESSION_ID, [])

    const result = await runObservation(sdk, clock, { waitBudgetMs: 11 })

    expect(result.kind).toBe("unknown")
    expect(result.kind === "failed" || (result.kind === "unknown" && result.reason.length > 0)).toBe(true)
  })

  it("returns unknown with reason on messages transport rejection and ends cleanly", async () => {
    const sdk = createSeededFakeSdk()
    const clock = createFakeClock(0)

    sdk.setMessagesFailure(new Error("network down"))

    const result = await runObservation(sdk, clock)

    expect(result.kind).toBe("unknown")
    if (result.kind === "unknown") {
      expect(result.reason).toBe("unrecognized provider error")
    }
    expect(sdk.calls.filter((c) => c.method === "messages").length).toBe(1)
  })

  it("reads immediately, polls at 2000ms, and does a final read at expiry", async () => {
    const sdk = createSeededFakeSdk()
    const clock = createFakeClock(0)

    sdk.seedMessages(CHILD_SESSION_ID, [])

    const promise = observeDispatch(baseRequest(sdk, clock, { waitBudgetMs: POLL_INTERVAL_MS + 10 }))
    await advanceClockTo(clock, POLL_INTERVAL_MS + 10)
    await promise

    const messagesCalls = sdk.calls.filter((c) => c.method === "messages")
    expect(messagesCalls.length).toBe(3) // t=0, t=POLL_INTERVAL, t=expiry
  })

  it("short-circuits before window expiry on completed result and makes no extra polls", async () => {
    const sdk = createSeededFakeSdk()
    const clock = createFakeClock(0)

    sdk.seedMessages(CHILD_SESSION_ID, [
      makeMessage(makeAssistant("msg-final", { time: { created: 1000, completed: 1500 }, finish: "stop" }), [
        makeText("done"),
      ]),
    ])

    const result = await runObservation(sdk, clock, { waitBudgetMs: 100 })

    expect(result).toEqual({ kind: "completed", text: "done" })
    expect(sdk.calls.filter((c) => c.method === "messages").length).toBe(1)
  })

  it("disposes timers so advancing clock after expiry resolves no pending sleepers", async () => {
    const sdk = createSeededFakeSdk()
    const clock = createFakeClock(0)

    sdk.seedMessages(CHILD_SESSION_ID, [])

    const promise = observeDispatch(baseRequest(sdk, clock, { waitBudgetMs: 10 }))
    await Promise.resolve()
    clock.advance(10)
    await promise

    let woke = false
    const sleeper = clock.sleep(1_000)
    sleeper.then(() => {
      woke = true
    })
    clock.advance(1_000)
    await sleeper
    expect(woke).toBe(true) // sanity: clock still works

    // After the observer returned, there should be no leftover sleeper that
    // fires on a subsequent advance. We verify by ensuring no stray calls.
    const before = sdk.calls.length
    clock.advance(10_000)
    expect(sdk.calls.length).toBe(before)
  })

  it("returns pending with aborted diagnostic when req.signal aborts mid-observation", async () => {
    const sdk = createSeededFakeSdk()
    const clock = createFakeClock(0)
    const controller = new AbortController()

    sdk.seedMessages(CHILD_SESSION_ID, [])

    const promise = observeDispatch(baseRequest(sdk, clock, { waitBudgetMs: 100, signal: controller.signal }))
    await Promise.resolve()
    clock.advance(POLL_INTERVAL_MS / 2)
    controller.abort()
    await Promise.resolve()
    clock.advance(POLL_INTERVAL_MS)

    const result = await promise

    expect(result).toEqual({ kind: "pending", diagnostics: { aborted: true } })
    expect(sdk.calls.some((c) => c.method === "abort")).toBe(false)
  })

  it("aborts immediately under the production 1800000 ms wait budget", async () => {
    const sdk = createSeededFakeSdk()
    const clock = createFakeClock(0)
    const controller = new AbortController()

    sdk.seedMessages(CHILD_SESSION_ID, [])

    const promise = observeDispatch(baseRequest(sdk, clock, { waitBudgetMs: PRODUCTION_WAIT_BUDGET_MS, signal: controller.signal }))
    await Promise.resolve()
    clock.advance(POLL_INTERVAL_MS / 2)
    controller.abort()
    await Promise.resolve()
    clock.advance(POLL_INTERVAL_MS)

    const result = await promise

    expect(result).toEqual({ kind: "pending", diagnostics: { aborted: true } })
    expect(sdk.calls.some((c) => c.method === "abort")).toBe(false)
  })

  it("classifies hostile message shapes without crashing", async () => {
    const sdk = createSeededFakeSdk()
    const clock = createFakeClock(0)

    sdk.seedMessages(CHILD_SESSION_ID, [
      makeMessage(makeAssistant("msg-null-parts", { time: { created: 1000, completed: 1500 }, finish: "stop" }), null as unknown as SdkTextPart[]),
      makeMessage(makeAssistant("msg-missing-time", {} as SdkAssistantMessage), [makeText("x")]),
      makeMessage(makeAssistant("msg-unknown-finish", { time: { created: 2000, completed: 2500 }, finish: "weird" }), [makeText("x")]),
      makeMessage(
        makeAssistant("msg-plain-error", {
          time: { created: 3000, completed: 3500 },
          error: "plain string error",
        }),
        [makeText("x")],
      ),
    ])

    const result = await runObservation(sdk, clock)

    // Newest is the plain-error message; plain string errors classify as failed.
    expect(result.kind).toBe("failed")
  })

  it("D1: cancels the in-flight timeout sleeper when the read wins", async () => {
    const sdk = createSeededFakeSdk()
    const clock = createCountingClock(0)

    sdk.seedMessages(CHILD_SESSION_ID, [
      makeMessage(makeAssistant("msg-final", { time: { created: 1000, completed: 2000 }, finish: "stop" }), [makeText("done")]),
    ])

    const outcome = await observeDispatch(baseRequest(sdk, clock, { waitBudgetMs: 50 }))

    expect(outcome).toEqual({ kind: "completed", text: "done" })
    expect(clock.pendingSleepCount).toBe(0)
  })

  it("D1: does not leak an unhandled rejection when the SDK read rejects after the timeout wins", async () => {
    let rejectMessages: (err: Error) => void = () => {}
    const sdk = createCustomSdk(() => new Promise((_, reject) => {
      rejectMessages = reject
    }))
    const clock = createRealisticClock(0)

    const promise = observeDispatch({
      ...baseRequest(sdk as unknown as SeededFakeSdk, clock, { waitBudgetMs: 50, startupGraceMs: 10 }),
    })
    clock.advance(50)
    const outcome = await promise

    expect(outcome.kind).toBe("unknown")

    rejectMessages(new Error("late transport failure"))
    await new Promise((resolve) => setTimeout(resolve, 0))
  })

  it("D1: does not leak an unhandled rejection when the read wins and the signal aborts the sleep", async () => {
    const sdk = createSeededFakeSdk()
    const clock = createFakeClock(0)
    const controller = new AbortController()

    sdk.seedMessages(CHILD_SESSION_ID, [
      makeMessage(makeAssistant("msg-active", { time: { created: 1000 } }), [makeText("working")]),
    ])

    const promise = observeDispatch(baseRequest(sdk, clock, { waitBudgetMs: 100, signal: controller.signal }))
    await Promise.resolve()
    controller.abort()

    const outcome = await promise
    expect(outcome).toEqual({ kind: "pending", diagnostics: { aborted: true } })
  })

  it("D2: returns pending when the final read times out after observing durable progress", async () => {
    let calls = 0
    const sdk = createCustomSdk(async () => {
      calls++
      if (calls === 1) {
        return {
          data: [makeMessage(makeAssistant("msg-active", { time: { created: 1000 } }), [makeText("still working")])],
        }
      }
      return new Promise(() => {})
    })
    const clock = createRealisticClock(0)

    const outcome = await observeDispatch({
      ...baseRequest(sdk as unknown as SeededFakeSdk, clock, { waitBudgetMs: 50, startupGraceMs: 10 }),
    })

    expect(outcome.kind).toBe("pending")
  })

  it("D2: waitBudgetMs=0 performs one snapshot read and classifies its result", async () => {
    const sdk = createCustomSdk(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
      return {
        data: [makeMessage(makeAssistant("msg-final", { time: { created: 1000, completed: 2000 }, finish: "stop" }), [makeText("snapshot result")])],
      }
    })
    const clock = createRealisticClock(0)

    const outcome = await observeDispatch({
      ...baseRequest(sdk as unknown as SeededFakeSdk, clock, { waitBudgetMs: 0, startupGraceMs: 10 }),
    })

    expect(outcome).toEqual({ kind: "completed", text: "snapshot result" })
  })

  it("D2: returns pending when the final read times out after a tool-calls step", async () => {
    let calls = 0
    const sdk = createCustomSdk(async () => {
      calls++
      if (calls === 1) {
        return {
          data: [makeMessage(makeAssistant("msg-tool", { time: { created: 1000, completed: 1500 }, finish: "tool-calls" }), [makeText("tool output")])],
        }
      }
      return new Promise(() => {})
    })
    const clock = createRealisticClock(0)

    const outcome = await observeDispatch({
      ...baseRequest(sdk as unknown as SeededFakeSdk, clock, { waitBudgetMs: 50, startupGraceMs: 10 }),
    })

    expect(outcome.kind).toBe("pending")
  })

  it("round3-H reports a non-abort clock failure as unknown, never aborted", async () => {
    const sdk = createSeededFakeSdk()
    let sleepCalls = 0
    const clock: Clock = {
      now: () => 0,
      sleep: () => {
        sleepCalls++
        if (sleepCalls >= 2) return Promise.reject(new Error("clock hardware failure"))
        return new Promise(() => {})
      },
    }
    sdk.seedMessages(CHILD_SESSION_ID, [])
    const outcome = await observeDispatch({ ...baseRequest(sdk, clock, { waitBudgetMs: 20, startupGraceMs: 10 }) })
    expect(outcome.kind).toBe("unknown")
    if (outcome.kind === "unknown") expect(outcome.reason).toContain("clock failed")
  })
})

function toolPart(tool: string, state: ToolPart["state"], id = "prt-tool"): ToolPart {
  return { id, messageID: "msg-active", sessionID: CHILD_SESSION_ID, type: "tool", tool, callID: `call-${id}`, state }
}

async function advanceUntilSettled(
  clock: Clock & { advance(ms: number): void },
  observed: Promise<unknown>,
  stepMs = 10_000,
  capMs = 2_000_000,
): Promise<void> {
  let settled = false
  void observed.then(() => { settled = true }, () => { settled = true })
  let advanced = 0
  while (!settled && advanced < capMs) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    clock.advance(stepMs)
    advanced += stepMs
  }
}

function inFlightToolMessage(parts: ReadonlyArray<SdkPart>, created = 0): SdkMessageWithParts {
  return makeMessage(makeAssistant("msg-active", { time: { created } }), parts as unknown as SdkTextPart[])
}

describe("D1 host-stop terminal convergence (O3)", () => {
  it("keeps pending at 9999ms quiet and cancels at the 10000ms IDLE_CONFIRM boundary", async () => {
    for (const [age, expected] of [[9_999, "pending"], [10_000, "cancelled"]] as const) {
      const sdk = createSeededFakeSdk()
      const clock = createFakeClock(age)
      sdk.seedMessages(CHILD_SESSION_ID, [inFlightToolMessage([makeText("working")])])
      const result = await observeDispatch(baseRequest(sdk, clock, {
        waitBudgetMs: 0, startupGraceMs: 0, sessionStatus: async () => ({ status: "idle" }),
      }))
      expect(result.kind).toBe(expected)
    }
  })

  it("cancels with the superseded reason when the request message is superseded by a newer message and the child session went idle", async () => {
    const sdk = createSeededFakeSdk()
    const clock = createFakeClock(20_000)
    const stale = inFlightToolMessage([makeText("working")])
    let calls = 0
    sdk.session.messages = async () => {
      calls++
      return { data: calls === 1 ? [stale] : [stale, makeUserMessage("msg-newer", CHILD_SESSION_ID)] }
    }
    const result = await observeDispatch(baseRequest(sdk, clock, {
      waitBudgetMs: 0, startupGraceMs: 0, sessionStatus: async () => ({ status: "idle" }),
    }))
    expect(result).toEqual({
      kind: "cancelled",
      hostStopped: true,
      reason: "child session became idle after request message was superseded before completion",
    })
  })

  it("returns the racing terminal from the post-idle read2 instead of cancelling", async () => {
    const sdk = createSeededFakeSdk()
    const clock = createFakeClock(20_000)
    const stale = inFlightToolMessage([makeText("working")])
    const done = makeMessage(makeAssistant("msg-done", { time: { created: 10_500, completed: 10_500 }, finish: "stop" }), [makeText("done")])
    let calls = 0
    sdk.session.messages = async () => {
      calls++
      return { data: calls === 1 ? [stale] : [stale, done] }
    }
    const result = await observeDispatch(baseRequest(sdk, clock, {
      waitBudgetMs: 0, startupGraceMs: 0, sessionStatus: async () => ({ status: "idle" }),
    }))
    expect(result).toEqual({ kind: "completed", text: "done" })
  })

  it("stays pending when read2 is not a messages result", async () => {
    const sdk = createSeededFakeSdk()
    const clock = createFakeClock(20_000)
    const stale = inFlightToolMessage([makeText("working")])
    let calls = 0
    sdk.session.messages = async () => {
      calls++
      return calls === 1 ? { data: [stale] } : { error: new Error("read2 transport failure") }
    }
    const result = await observeDispatch(baseRequest(sdk, clock, {
      waitBudgetMs: 0, startupGraceMs: 0, sessionStatus: async () => ({ status: "idle" }),
    }))
    expect(result.kind).toBe("pending")
  })

  it("stays pending when read2 shows newer activity (TOCTOU branch)", async () => {
    const sdk = createSeededFakeSdk()
    const clock = createFakeClock(20_000)
    const stale = inFlightToolMessage([makeText("working")])
    const newer = makeMessage(makeAssistant("msg-active", { time: { created: 19_000 } }), [makeText("still working")])
    let calls = 0
    sdk.session.messages = async () => {
      calls++
      return { data: calls === 1 ? [stale] : [stale, newer] }
    }
    const result = await observeDispatch(baseRequest(sdk, clock, {
      waitBudgetMs: 0, startupGraceMs: 0, sessionStatus: async () => ({ status: "idle" }),
    }))
    expect(result.kind).toBe("pending")
  })

  it("stays pending, never cancelled, when the status probe fails", async () => {
    const sdk = createSeededFakeSdk()
    const clock = createFakeClock(20_000)
    sdk.seedMessages(CHILD_SESSION_ID, [inFlightToolMessage([makeText("working")])])
    const result = await observeDispatch(baseRequest(sdk, clock, {
      waitBudgetMs: 0, startupGraceMs: 0, sessionStatus: async () => { throw new Error("status transport failed") },
    }))
    expect(result.kind).toBe("pending")
  })
})

describe("D2 stuck-tool soft-yield (O2)", () => {
  it("soft-yields a stuck running tool at the 300000ms threshold with health fields", async () => {
    const sdk = createSeededFakeSdk()
    const clock = createFakeClock(0)
    sdk.seedMessages(CHILD_SESSION_ID, [inFlightToolMessage([
      toolPart("grep", { status: "running", input: {}, time: { start: 0 } }),
    ])])
    const observed = observeDispatch(baseRequest(sdk, clock, {
      waitBudgetMs: 1_800_000, startupGraceMs: 0, stalledSuspectMs: STALLED_SUSPECT_MS,
      sessionStatus: async () => ({ status: "busy" }),
    }))
    await advanceUntilSettled(clock, observed)
    const result = await observed
    expect(clock.now()).toBeLessThan(1_800_000)
    expect(result.kind).toBe("pending")
    if (result.kind !== "pending") throw new Error("expected pending")
    expect(result.diagnostics?.stalled_suspect).toBe(true)
    expect(result.diagnostics?.running_tool).toBe("grep")
    expect(result.diagnostics?.running_tool_ms).toBeGreaterThanOrEqual(STALLED_SUSPECT_MS)
    expect(result.diagnostics?.last_activity_ms).toBeGreaterThanOrEqual(STALLED_SUSPECT_MS)
    expect(result.diagnostics?.session_status).toBe("busy")
  })

  it("keeps the full wait budget on a pure reasoning turn with no running tool", async () => {
    const sdk = createSeededFakeSdk()
    const clock = createFakeClock(0)
    sdk.seedMessages(CHILD_SESSION_ID, [inFlightToolMessage([makeText("thinking...")])])
    const observed = observeDispatch(baseRequest(sdk, clock, {
      waitBudgetMs: 1_800_000, startupGraceMs: 0,
      sessionStatus: async () => ({ status: "busy" }),
    }))
    await advanceUntilSettled(clock, observed)
    const result = await observed
    expect(clock.now()).toBeGreaterThanOrEqual(1_800_000)
    expect(result.kind).toBe("pending")
  })

  it("does not early-yield when recent activity keeps the quiet window short", async () => {
    const sdk = createSeededFakeSdk()
    const clock = createFakeClock(0)
    const recentText = { type: "text", text: "recent", time: { created: 290_000 } } as unknown as SdkTextPart
    sdk.seedMessages(CHILD_SESSION_ID, [inFlightToolMessage([
      toolPart("grep", { status: "running", input: {}, time: { start: 0 } }),
      recentText,
    ])])
    const observed = observeDispatch(baseRequest(sdk, clock, {
      waitBudgetMs: 400_000, startupGraceMs: 0,
      sessionStatus: async () => ({ status: "busy" }),
    }))
    await advanceUntilSettled(clock, observed)
    await observed
    expect(clock.now()).toBeGreaterThanOrEqual(400_000)
  })

  it("does not early-yield on a pending tool with no finite start", async () => {
    const sdk = createSeededFakeSdk()
    const clock = createFakeClock(0)
    sdk.seedMessages(CHILD_SESSION_ID, [inFlightToolMessage([
      toolPart("grep", { status: "pending", input: {}, raw: "" }),
    ])])
    const observed = observeDispatch(baseRequest(sdk, clock, {
      waitBudgetMs: 400_000, startupGraceMs: 0,
      sessionStatus: async () => ({ status: "busy" }),
    }))
    await advanceUntilSettled(clock, observed)
    await observed
    expect(clock.now()).toBeGreaterThanOrEqual(400_000)
  })

  it("does not early-yield when the observation window is shorter than the threshold", async () => {
    const sdk = createSeededFakeSdk()
    const clock = createFakeClock(1_000_000)
    sdk.seedMessages(CHILD_SESSION_ID, [inFlightToolMessage([
      toolPart("grep", { status: "running", input: {}, time: { start: 0 } }),
    ])])
    const observed = observeDispatch(baseRequest(sdk, clock, {
      waitBudgetMs: 200_000, startupGraceMs: 0,
      sessionStatus: async () => ({ status: "busy" }),
    }))
    await advanceUntilSettled(clock, observed)
    await observed
    expect(clock.now()).toBeGreaterThanOrEqual(1_200_000)
  })

  it("never early-yields on a waitBudgetMs=0 snapshot", async () => {
    const sdk = createSeededFakeSdk()
    const clock = createFakeClock(300_000)
    sdk.seedMessages(CHILD_SESSION_ID, [inFlightToolMessage([
      toolPart("grep", { status: "running", input: {}, time: { start: 0 } }),
    ])])
    const result = await observeDispatch(baseRequest(sdk, clock, {
      waitBudgetMs: 0, startupGraceMs: 0,
      sessionStatus: async () => ({ status: "busy" }),
    }))
    expect(clock.now()).toBe(300_000)
    expect(result.kind).toBe("pending")
    if (result.kind === "pending") expect(result.diagnostics?.stalled_suspect).toBe(true)
  })
})

describe("classifier activity extraction", () => {
  it("selects the smallest-start running tool part", () => {
    const activity = extractMatchingActivity([
      makeMessage(makeAssistant("msg-active", { time: { created: 0 } }), [
        toolPart("slow", { status: "running", input: {}, time: { start: 100 } }, "prt-slow"),
        toolPart("long", { status: "running", input: {}, time: { start: 50 } }, "prt-long"),
      ] as unknown as SdkTextPart[]),
    ], CHILD_SESSION_ID, REQUEST_MESSAGE_ID)
    expect(activity.runningTool).toBe("long")
    expect(activity.runningToolStartedAt).toBe(50)
  })

  it("falls back to the first running/pending part when no running part has a finite start", () => {
    const activity = extractMatchingActivity([
      makeMessage(makeAssistant("msg-active", { time: { created: 0 } }), [
        toolPart("pendingTool", { status: "pending", input: {}, raw: "" }, "prt-pending"),
        toolPart("inf", { status: "running", input: {}, time: { start: Number.POSITIVE_INFINITY } }, "prt-inf"),
      ] as unknown as SdkTextPart[]),
    ], CHILD_SESSION_ID, REQUEST_MESSAGE_ID)
    expect(activity.runningTool).toBe("pendingTool")
    expect(activity.runningToolStartedAt).toBeUndefined()
  })

  it("drops a blank tool name but keeps its start", () => {
    const activity = extractMatchingActivity([
      makeMessage(makeAssistant("msg-active", { time: { created: 0 } }), [
        toolPart("   ", { status: "running", input: {}, time: { start: 0 } }),
      ] as unknown as SdkTextPart[]),
    ], CHILD_SESSION_ID, REQUEST_MESSAGE_ID)
    expect(activity.runningTool).toBeUndefined()
    expect(activity.runningToolStartedAt).toBe(0)
  })

  it("drops non-finite message and part timestamps", () => {
    const activity = extractMatchingActivity([
      makeMessage(makeAssistant("msg-active", { time: { created: Number.POSITIVE_INFINITY, completed: Number.NaN } }), [
        { type: "text", text: "x", time: { created: Number.NEGATIVE_INFINITY } } as unknown as SdkTextPart,
      ]),
    ], CHILD_SESSION_ID, REQUEST_MESSAGE_ID)
    expect(activity.lastActivityAt).toBeUndefined()
  })

  it("drops an unknown host session_status string from the envelope diagnostics", async () => {
    const sdk = createSeededFakeSdk()
    const clock = createFakeClock(20_000)
    sdk.seedMessages(CHILD_SESSION_ID, [inFlightToolMessage([makeText("working")])])
    const result = await observeDispatch(baseRequest(sdk, clock, {
      waitBudgetMs: 0, startupGraceMs: 0, sessionStatus: async () => ({ status: "paused" }),
    }))
    expect(result.kind).toBe("pending")
    if (result.kind === "pending") expect(result.diagnostics?.session_status).toBeUndefined()
  })
})

// --- P5 M2 permission-ask escalation acceptance harness ---

const ASK_JOB_ID = "ses_ask_job"
const ASK_CHILD_ID = "ses_ask_child"
const ASK_REQUEST_ID = "msg-ask-request"
const ASK_TOP_ID = "ses_ask_top"

function askSession(id: string, parentID: string | undefined, title: string): SdkSession {
  return {
    id,
    ...(parentID !== undefined ? { parentID } : {}),
    directory: FAKE_DIRECTORY,
    title,
    time: { created: 0, updated: 0 },
  }
}

function inFlightAskMessage(sessionID: string, requestMessageID: string): SdkMessageWithParts {
  return {
    info: { id: "msg-inflight", sessionID, role: "assistant", parentID: requestMessageID, time: { created: 0 }, modelID: "m", providerID: "p" },
    parts: [{ type: "text", text: "working" }],
  }
}

function inFlightAskToolMessage(sessionID: string, requestMessageID: string): SdkMessageWithParts {
  const tool: ToolPart = {
    id: "prt-ask-tool", messageID: "msg-inflight", sessionID, type: "tool", tool: "grep", callID: "call-ask-1",
    state: { status: "running", input: {}, time: { start: 0 } },
  }
  return {
    info: makeAssistant("msg-inflight", { sessionID, parentID: requestMessageID, time: { created: 0 } }),
    parts: [makeText("working"), tool] as unknown as SdkTextPart[],
  }
}

function completedAskMessage(sessionID: string, requestMessageID: string, text: string): SdkMessageWithParts {
  return {
    info: { id: "msg-completed", sessionID, role: "assistant", parentID: requestMessageID, time: { created: 1, completed: 1 }, finish: "stop", modelID: "m", providerID: "p" },
    parts: [{ type: "text", text }],
  }
}

function askFixture(overrides: { readonly requestID?: string; readonly sessionID?: string; readonly permission?: string; readonly patterns?: ReadonlyArray<string> } = {}): PendingAsk {
  const sessionID = overrides.sessionID ?? ASK_CHILD_ID
  return sanitizePendingAsk({
    requestID: overrides.requestID ?? "req-1",
    sessionID,
    permission: overrides.permission ?? "bash",
    patterns: overrides.patterns ?? ["rm -rf build"],
    firstSeenAt: 0,
    job_chain: [{ job_id: ASK_JOB_ID, role: "coder", session_id: sessionID }],
  }, 0)
}

function sdkCallCount(fake: FakeSdk, method: string): number {
  return fake.calls.filter((call) => (call as { method: string }).method === method).length
}

async function advanceUntilSettledAt(
  clock: Clock & { advance(ms: number): void },
  observed: Promise<unknown>,
  stepMs = 250,
  capMs = 60_000,
): Promise<number> {
  let settled = false
  void observed.then(() => { settled = true }, () => { settled = true })
  while (!settled && clock.now() < capMs) {
    await new Promise<void>((resolve) => setTimeout(resolve, 0))
    if (settled) break
    clock.advance(stepMs)
  }
  return clock.now()
}

describe("P5 M2 permission-ask escalation", () => {
  it("Probe 2 — a push during the poll sleep wakes at 0 ms clock advance and soft-yields pending_asks", async () => {
    const fake = createFakeSdk({
      seedPermission: true,
      sessions: [
        askSession(ASK_TOP_ID, undefined, "human"),
        askSession(ASK_JOB_ID, ASK_TOP_ID, `${DISPATCH_MARKER}coder`),
        askSession(ASK_CHILD_ID, ASK_JOB_ID, "attempt"),
      ],
    })
    fake.seedMessages(ASK_CHILD_ID, [inFlightAskMessage(ASK_CHILD_ID, ASK_REQUEST_ID)])
    const registry = new PermissionAskRegistry()
    const clock = createFakeClock(0)
    const probe = createFakePendingAsksProbe(fake, registry, clock)
    const sleeping = Promise.withResolvers<void>()
    const observed = observeDispatch({
      sdk: fake, jobID: ASK_JOB_ID, childSessionID: ASK_CHILD_ID, requestMessageID: ASK_REQUEST_ID,
      directory: FAKE_DIRECTORY, waitBudgetMs: 120_000, clock, startupGraceMs: 0, parentID: ASK_TOP_ID,
      pendingAsks: () => probe({ jobID: ASK_JOB_ID, childSessionID: ASK_CHILD_ID, parentID: ASK_TOP_ID, role: "coder" }),
      getAskVersion: () => registry.getVersion(FAKE_DIRECTORY),
      waitForAskWake: (seen, signal) => { sleeping.resolve(); return registry.waitForAskWake(FAKE_DIRECTORY, seen, signal) },
    })
    await sleeping.promise
    seedLivePermissionAsk(fake, registry, { id: "req-1", sessionID: ASK_CHILD_ID, permission: "bash", patterns: ["rm -rf build"] }, clock.now())
    const result = await observed
    expect(clock.now()).toBe(0)
    expect(result.kind).toBe("pending")
    if (result.kind !== "pending") throw new Error("expected pending")
    expect(result.diagnostics?.pending_asks?.map((ask) => ask.requestID)).toEqual(["req-1"])
    expect(sdkCallCount(fake, "abort")).toBe(0)
  })

  it("Probe 2 — a push after the version snapshot but before the sleep is observed by the same poll at 0 ms", async () => {
    const fake = createFakeSdk({
      seedPermission: true,
      sessions: [
        askSession(ASK_TOP_ID, undefined, "human"),
        askSession(ASK_JOB_ID, ASK_TOP_ID, `${DISPATCH_MARKER}coder`),
        askSession(ASK_CHILD_ID, ASK_JOB_ID, "attempt"),
      ],
    })
    fake.seedMessages(ASK_CHILD_ID, [inFlightAskMessage(ASK_CHILD_ID, ASK_REQUEST_ID)])
    const registry = new PermissionAskRegistry()
    const clock = createFakeClock(0)
    const probe = createFakePendingAsksProbe(fake, registry, clock)
    let seeded = false
    const originalMessages = fake.session.messages.bind(fake.session)
    fake.session.messages = async (input) => {
      const read = await originalMessages(input)
      if (!seeded) {
        seeded = true
        seedLivePermissionAsk(fake, registry, { id: "req-1", sessionID: ASK_CHILD_ID, permission: "bash", patterns: ["rm -rf build"] }, clock.now())
      }
      return read
    }
    const result = await observeDispatch({
      sdk: fake, jobID: ASK_JOB_ID, childSessionID: ASK_CHILD_ID, requestMessageID: ASK_REQUEST_ID,
      directory: FAKE_DIRECTORY, waitBudgetMs: 120_000, clock, startupGraceMs: 0, parentID: ASK_TOP_ID,
      pendingAsks: () => probe({ jobID: ASK_JOB_ID, childSessionID: ASK_CHILD_ID, parentID: ASK_TOP_ID, role: "coder" }),
      getAskVersion: () => registry.getVersion(FAKE_DIRECTORY),
      waitForAskWake: (seen, signal) => registry.waitForAskWake(FAKE_DIRECTORY, seen, signal),
    })
    expect(clock.now()).toBe(0)
    expect(result.kind).toBe("pending")
    if (result.kind !== "pending") throw new Error("expected pending")
    expect(result.diagnostics?.pending_asks?.map((ask) => ask.requestID)).toEqual(["req-1"])
    expect(sdkCallCount(fake, "abort")).toBe(0)
  })

  it("QS1 — L0 soft-yields a descendant L2 ask within one poll cycle and bounds a hanging probe", async () => {
    const fake = createFakeSdk({
      seedPermission: true,
      sessions: [
        askSession(ASK_TOP_ID, undefined, "human"),
        askSession(ASK_JOB_ID, ASK_TOP_ID, `${DISPATCH_MARKER}tech-lead`),
        askSession("ses_l2_job", ASK_JOB_ID, `${DISPATCH_MARKER}coder`),
      ],
    })
    fake.seedMessages(ASK_JOB_ID, [inFlightAskMessage(ASK_JOB_ID, ASK_REQUEST_ID)])
    const registry = new PermissionAskRegistry()
    const clock = createFakeClock(0)
    const probe = createFakePendingAsksProbe(fake, registry, clock)
    seedLivePermissionAsk(fake, registry, { id: "req-l2", sessionID: "ses_l2_job", permission: "bash", patterns: ["rm -rf build"] }, 0)
    const result = await observeDispatch({
      sdk: fake, jobID: ASK_JOB_ID, childSessionID: ASK_JOB_ID, requestMessageID: ASK_REQUEST_ID,
      directory: FAKE_DIRECTORY, waitBudgetMs: 120_000, clock, startupGraceMs: 0, parentID: ASK_TOP_ID,
      checkSubtreeAsksOnCompletion: true,
      pendingAsks: () => probe({ jobID: ASK_JOB_ID, childSessionID: ASK_JOB_ID, parentID: ASK_TOP_ID, role: "tech-lead" }),
      getAskVersion: () => registry.getVersion(FAKE_DIRECTORY),
      waitForAskWake: (seen, signal) => registry.waitForAskWake(FAKE_DIRECTORY, seen, signal),
    })
    expect(clock.now()).toBe(0)
    expect(result.kind).toBe("pending")
    if (result.kind !== "pending") throw new Error("expected pending")
    const asks = result.diagnostics?.pending_asks ?? []
    expect(asks.map((ask) => ask.requestID)).toEqual(["req-l2"])
    // buildJobChain hop 0 is the observed job; outer retry-nested coordinator
    // hops are appended upward (see the L1 hold test below for the 2-hop case).
    expect(asks[0]?.job_chain[0]).toEqual({ job_id: ASK_JOB_ID, role: "tech-lead", session_id: ASK_JOB_ID })
    expect(sdkCallCount(fake, "abort")).toBe(0)

    // A hanging probe must be transport-bounded by the shared 5 000 ms budget.
    expect(SNAPSHOT_READ_TRANSPORT_MS).toBe(5_000)
    const hungClock = createFakeClock(0)
    const hungFake = createFakeSdk({
      seedPermission: true,
      sessions: [
        askSession(ASK_TOP_ID, undefined, "human"),
        askSession(ASK_JOB_ID, ASK_TOP_ID, `${DISPATCH_MARKER}tech-lead`),
      ],
    })
    hungFake.seedMessages(ASK_JOB_ID, [inFlightAskMessage(ASK_JOB_ID, ASK_REQUEST_ID)])
    const hungRegistry = new PermissionAskRegistry()
    const hungObserved = observeDispatch({
      sdk: hungFake, jobID: ASK_JOB_ID, childSessionID: ASK_JOB_ID, requestMessageID: ASK_REQUEST_ID,
      directory: FAKE_DIRECTORY, waitBudgetMs: 8_000, clock: hungClock, startupGraceMs: 0, parentID: ASK_TOP_ID,
      pendingAsks: () => new Promise(() => {}),
      getAskVersion: () => hungRegistry.getVersion(FAKE_DIRECTORY),
      waitForAskWake: (seen, signal) => hungRegistry.waitForAskWake(FAKE_DIRECTORY, seen, signal),
    })
    await advanceUntilSettled(hungClock, hungObserved, 1_000)
    const hungResult = await hungObserved
    expect(hungResult.kind).toBe("pending")
    expect(hungClock.now()).toBeGreaterThanOrEqual(8_000)
  })

  it("QS1 — a dispatched L1 holds past 300000 ms without an early stalled_suspect yield and keeps a 2-hop job_chain", async () => {
    const OUTER_ROOT = "ses_outer_root"
    const OUTER_ATTEMPT = "ses_outer_attempt"
    const fake = createFakeSdk({
      seedPermission: true,
      sessions: [
        askSession(ASK_TOP_ID, undefined, "human"),
        askSession(OUTER_ROOT, ASK_TOP_ID, `${DISPATCH_MARKER}tech-lead`),
        askSession(OUTER_ATTEMPT, OUTER_ROOT, `${DISPATCH_MARKER}attempt tech-lead`),
        askSession(ASK_JOB_ID, OUTER_ATTEMPT, `${DISPATCH_MARKER}coder`),
        askSession(ASK_CHILD_ID, ASK_JOB_ID, "attempt"),
      ],
    })
    fake.seedMessages(ASK_CHILD_ID, [inFlightAskToolMessage(ASK_CHILD_ID, ASK_REQUEST_ID)])
    const registry = new PermissionAskRegistry()
    registry.dispatchedSessionIDs.add(OUTER_ATTEMPT)
    const clock = createFakeClock(0)
    const probe = createFakePendingAsksProbe(fake, registry, clock)
    seedLivePermissionAsk(fake, registry, { id: "req-1", sessionID: ASK_CHILD_ID, permission: "bash", patterns: ["rm -rf build"] }, 0)
    const observed = observeDispatch({
      sdk: fake, jobID: ASK_JOB_ID, childSessionID: ASK_CHILD_ID, requestMessageID: ASK_REQUEST_ID,
      directory: FAKE_DIRECTORY, waitBudgetMs: 400_000, clock, startupGraceMs: 0, parentID: OUTER_ATTEMPT,
      sessionStatus: async () => ({ status: "busy" }),
      pendingAsks: () => probe({ jobID: ASK_JOB_ID, childSessionID: ASK_CHILD_ID, parentID: OUTER_ATTEMPT, role: "coder" }),
      getAskVersion: () => registry.getVersion(FAKE_DIRECTORY),
      waitForAskWake: (seen, signal) => registry.waitForAskWake(FAKE_DIRECTORY, seen, signal),
    })
    await advanceUntilSettled(clock, observed, 10_000)
    const result = await observed
    expect(result.kind).toBe("pending")
    if (result.kind !== "pending") throw new Error("expected pending")
    expect(clock.now()).toBeGreaterThan(STALLED_SUSPECT_MS)
    expect(result.diagnostics?.is_dispatched_subsession_caller).toBe(true)
    expect(result.diagnostics?.pending_asks?.[0]?.job_chain).toHaveLength(2)
    expect(result.diagnostics?.pending_asks?.[0]?.job_chain.map((hop) => hop.job_id)).toEqual([ASK_JOB_ID, OUTER_ROOT])
    expect(sdkCallCount(fake, "abort")).toBe(0)
  })

  it("QS1 — the L1 hold ends and completes on the first poll after L0 answers the ask", async () => {
    const L1_CALLER = "ses_l1_caller"
    const fake = createFakeSdk({
      seedPermission: true,
      sessions: [
        askSession(ASK_TOP_ID, undefined, "human"),
        askSession(ASK_JOB_ID, ASK_TOP_ID, `${DISPATCH_MARKER}tech-lead`),
        askSession(ASK_CHILD_ID, ASK_JOB_ID, "attempt"),
      ],
    })
    fake.seedMessages(ASK_CHILD_ID, [inFlightAskMessage(ASK_CHILD_ID, ASK_REQUEST_ID)])
    const registry = new PermissionAskRegistry()
    registry.dispatchedSessionIDs.add(L1_CALLER)
    const clock = createFakeClock(0)
    const probe = createFakePendingAsksProbe(fake, registry, clock)
    seedLivePermissionAsk(fake, registry, { id: "req-1", sessionID: ASK_CHILD_ID, permission: "bash", patterns: ["rm -rf build"] }, 0)
    const sleeping = Promise.withResolvers<void>()
    const observed = observeDispatch({
      sdk: fake, jobID: ASK_JOB_ID, childSessionID: ASK_CHILD_ID, requestMessageID: ASK_REQUEST_ID,
      directory: FAKE_DIRECTORY, waitBudgetMs: 1_800_000, clock, startupGraceMs: 0, parentID: L1_CALLER,
      checkSubtreeAsksOnCompletion: true,
      pendingAsks: () => probe({ jobID: ASK_JOB_ID, childSessionID: ASK_CHILD_ID, parentID: L1_CALLER, role: "tech-lead" }),
      getAskVersion: () => registry.getVersion(FAKE_DIRECTORY),
      waitForAskWake: (seen, signal) => { sleeping.resolve(); return registry.waitForAskWake(FAKE_DIRECTORY, seen, signal) },
    })
    await sleeping.promise
    // L0 answered via janus_permission_reply: the host broadcasts permission.replied.
    registry.onReplied("req-1", clock.now())
    fake.permission?.seedAsks([])
    fake.seedMessages(ASK_CHILD_ID, [completedAskMessage(ASK_CHILD_ID, ASK_REQUEST_ID, "coordinator done")])
    clock.advance(POLL_INTERVAL_MS)
    const result = await observed
    expect(result).toEqual({ kind: "completed", text: "coordinator done" })
    expect(clock.now()).toBeLessThanOrEqual(POLL_INTERVAL_MS)
  })

  it("T1 — a coordinator completed turn with a pending descendant ask is intercepted to pending", async () => {
    const fake = createFakeSdk({
      seedPermission: true,
      sessions: [
        askSession(ASK_TOP_ID, undefined, "human"),
        askSession(ASK_JOB_ID, ASK_TOP_ID, `${DISPATCH_MARKER}consultant`),
        askSession("ses_l2_job", ASK_JOB_ID, `${DISPATCH_MARKER}coder`),
      ],
    })
    fake.seedMessages(ASK_JOB_ID, [completedAskMessage(ASK_JOB_ID, ASK_REQUEST_ID, "premature report")])
    const registry = new PermissionAskRegistry()
    const clock = createFakeClock(0)
    const probe = createFakePendingAsksProbe(fake, registry, clock)
    seedLivePermissionAsk(fake, registry, { id: "req-l2", sessionID: "ses_l2_job", permission: "bash", patterns: ["rm -rf build"] }, 0)
    const result = await observeDispatch({
      sdk: fake, jobID: ASK_JOB_ID, childSessionID: ASK_JOB_ID, requestMessageID: ASK_REQUEST_ID,
      directory: FAKE_DIRECTORY, waitBudgetMs: 0, clock, startupGraceMs: 0, parentID: ASK_TOP_ID,
      checkSubtreeAsksOnCompletion: true,
      pendingAsks: () => probe({ jobID: ASK_JOB_ID, childSessionID: ASK_JOB_ID, parentID: ASK_TOP_ID, role: "consultant" }),
      getAskVersion: () => registry.getVersion(FAKE_DIRECTORY),
      waitForAskWake: (seen, signal) => registry.waitForAskWake(FAKE_DIRECTORY, seen, signal),
    })
    expect(result.kind).toBe("pending")
    if (result.kind !== "pending") throw new Error("expected pending")
    expect(result.diagnostics?.pending_asks?.[0]?.requestID).toBe("req-l2")
    expect(result.diagnostics?.coordinator_turn_ended).toEqual({ coordinatorSessionID: ASK_JOB_ID, descendantJobIDs: ["ses_l2_job"] })
    const outcome = observationToOutcome(result, ASK_JOB_ID, "consultant", { index: 0, model: "m", sessionID: ASK_JOB_ID }, 0)
    if (outcome.kind !== "nonterminal") throw new Error("expected nonterminal")
    expect(outcome.envelope.reason).toContain("(1) janus_permission_reply")
    expect(outcome.envelope.reason).toContain(`(2) janus_dispatch_wait(${ASK_JOB_ID})`)
    expect(outcome.envelope.reason).toContain(`(3) janus_dispatch_continue(${ASK_JOB_ID})`)
    expect(outcome.envelope.reason).toContain("ses_l2_job")
  })

  it("T1 — the empty descendant variant omits the id list in step 3", async () => {
    const fake = createFakeSdk({
      seedPermission: true,
      sessions: [
        askSession(ASK_TOP_ID, undefined, "human"),
        askSession(ASK_JOB_ID, ASK_TOP_ID, `${DISPATCH_MARKER}consultant`),
      ],
    })
    fake.seedMessages(ASK_JOB_ID, [completedAskMessage(ASK_JOB_ID, ASK_REQUEST_ID, "premature report")])
    const registry = new PermissionAskRegistry()
    const clock = createFakeClock(0)
    const probe = createFakePendingAsksProbe(fake, registry, clock)
    seedLivePermissionAsk(fake, registry, { id: "req-l1", sessionID: ASK_JOB_ID, permission: "bash", patterns: ["rm -rf build"] }, 0)
    const result = await observeDispatch({
      sdk: fake, jobID: ASK_JOB_ID, childSessionID: ASK_JOB_ID, requestMessageID: ASK_REQUEST_ID,
      directory: FAKE_DIRECTORY, waitBudgetMs: 0, clock, startupGraceMs: 0, parentID: ASK_TOP_ID,
      checkSubtreeAsksOnCompletion: true,
      pendingAsks: () => probe({ jobID: ASK_JOB_ID, childSessionID: ASK_JOB_ID, parentID: ASK_TOP_ID, role: "consultant" }),
      getAskVersion: () => registry.getVersion(FAKE_DIRECTORY),
      waitForAskWake: (seen, signal) => registry.waitForAskWake(FAKE_DIRECTORY, seen, signal),
    })
    if (result.kind !== "pending") throw new Error("expected pending")
    expect(result.diagnostics?.coordinator_turn_ended).toEqual({ coordinatorSessionID: ASK_JOB_ID, descendantJobIDs: [] })
    const outcome = observationToOutcome(result, ASK_JOB_ID, "consultant", { index: 0, model: "m", sessionID: ASK_JOB_ID }, 0)
    if (outcome.kind !== "nonterminal") throw new Error("expected nonterminal")
    expect(outcome.envelope.reason).toContain("collect the descendant child session's result")
    expect(outcome.envelope.reason).not.toContain("job ids:")
  })

  it("damps a same-turn re-yield by RE_YIELD_DAMPING_MS and prefixes STOP WAITING:", async () => {
    const fake = createFakeSdk({ sessions: [askSession(ASK_TOP_ID, undefined, "human"), askSession(ASK_JOB_ID, ASK_TOP_ID, "job"), askSession(ASK_CHILD_ID, ASK_JOB_ID, "attempt")] })
    // Sections the newest matching message as in-flight so the observer keeps polling.
    fake.session.messages = async () => ({ data: [inFlightAskMessage(ASK_CHILD_ID, ASK_REQUEST_ID)] })
    const registry = new PermissionAskRegistry()
    const clock = createFakeClock(0)
    const observed = observeDispatch({
      sdk: fake, jobID: ASK_JOB_ID, childSessionID: ASK_CHILD_ID, requestMessageID: ASK_REQUEST_ID,
      directory: FAKE_DIRECTORY, waitBudgetMs: 30_000, clock, startupGraceMs: 0, parentID: ASK_TOP_ID,
      pendingAsks: async () => ({ asks: [askFixture()], isDispatchedSubsessionCaller: false, allAlreadySurfacedInCurrentTurn: true }),
      getAskVersion: () => registry.getVersion(FAKE_DIRECTORY),
      waitForAskWake: (seen, signal) => registry.waitForAskWake(FAKE_DIRECTORY, seen, signal),
    })
    const settledAt = await advanceUntilSettledAt(clock, observed)
    const result = await observed
    expect(settledAt).toBeGreaterThanOrEqual(RE_YIELD_DAMPING_MS)
    expect(settledAt).toBeLessThan(RE_YIELD_DAMPING_MS + 1_000)
    if (result.kind !== "pending") throw new Error("expected pending")
    expect(result.diagnostics?.same_turn_re_yield).toBe(true)
    const outcome = observationToOutcome(result, ASK_JOB_ID, "coder", { index: 0, model: null, sessionID: ASK_CHILD_ID }, 0)
    if (outcome.kind !== "nonterminal") throw new Error("expected nonterminal")
    expect(outcome.envelope.reason.startsWith("STOP WAITING:")).toBe(true)
  })

  it("caps the same-turn damping window at the remaining waitBudgetMs", async () => {
    const fake = createFakeSdk({ sessions: [askSession(ASK_TOP_ID, undefined, "human"), askSession(ASK_JOB_ID, ASK_TOP_ID, "job"), askSession(ASK_CHILD_ID, ASK_JOB_ID, "attempt")] })
    fake.session.messages = async () => ({ data: [inFlightAskMessage(ASK_CHILD_ID, ASK_REQUEST_ID)] })
    const registry = new PermissionAskRegistry()
    const clock = createFakeClock(0)
    const observed = observeDispatch({
      sdk: fake, jobID: ASK_JOB_ID, childSessionID: ASK_CHILD_ID, requestMessageID: ASK_REQUEST_ID,
      directory: FAKE_DIRECTORY, waitBudgetMs: 5_000, clock, startupGraceMs: 0, parentID: ASK_TOP_ID,
      pendingAsks: async () => ({ asks: [askFixture()], isDispatchedSubsessionCaller: false, allAlreadySurfacedInCurrentTurn: true }),
      getAskVersion: () => registry.getVersion(FAKE_DIRECTORY),
      waitForAskWake: (seen, signal) => registry.waitForAskWake(FAKE_DIRECTORY, seen, signal),
    })
    const settledAt = await advanceUntilSettledAt(clock, observed)
    const result = await observed
    expect(settledAt).toBeGreaterThanOrEqual(5_000)
    expect(settledAt).toBeLessThan(5_000 + 1_000)
    if (result.kind !== "pending") throw new Error("expected pending")
    expect(result.diagnostics?.same_turn_re_yield).toBe(true)
  })

  it("attaches pending_asks on a waitBudgetMs: 0 snapshot", async () => {
    const fake = createFakeSdk({
      seedPermission: true,
      sessions: [askSession(ASK_TOP_ID, undefined, "human"), askSession(ASK_JOB_ID, ASK_TOP_ID, `${DISPATCH_MARKER}coder`), askSession(ASK_CHILD_ID, ASK_JOB_ID, "attempt")],
    })
    fake.seedMessages(ASK_CHILD_ID, [inFlightAskMessage(ASK_CHILD_ID, ASK_REQUEST_ID)])
    const registry = new PermissionAskRegistry()
    const clock = createFakeClock(0)
    const probe = createFakePendingAsksProbe(fake, registry, clock)
    seedLivePermissionAsk(fake, registry, { id: "req-1", sessionID: ASK_CHILD_ID, permission: "bash", patterns: ["rm -rf build"] }, 0)
    const result = await observeDispatch({
      sdk: fake, jobID: ASK_JOB_ID, childSessionID: ASK_CHILD_ID, requestMessageID: ASK_REQUEST_ID,
      directory: FAKE_DIRECTORY, waitBudgetMs: 0, clock, startupGraceMs: 0, parentID: ASK_TOP_ID,
      pendingAsks: () => probe({ jobID: ASK_JOB_ID, childSessionID: ASK_CHILD_ID, parentID: ASK_TOP_ID, role: "coder" }),
      getAskVersion: () => registry.getVersion(FAKE_DIRECTORY),
      waitForAskWake: (seen, signal) => registry.waitForAskWake(FAKE_DIRECTORY, seen, signal),
    })
    if (result.kind !== "pending") throw new Error("expected pending")
    expect(result.diagnostics?.pending_asks?.map((ask) => ask.requestID)).toEqual(["req-1"])
    expect(clock.now()).toBe(0)
  })

  it("never cross-attributes asks between two parallel jobs under one caller", async () => {
    const fake = createFakeSdk({
      seedPermission: true,
      sessions: [
        askSession(ASK_TOP_ID, undefined, "human"),
        askSession("ses_job_a", ASK_TOP_ID, `${DISPATCH_MARKER}coder`),
        askSession("ses_child_a", "ses_job_a", "attempt"),
        askSession("ses_job_b", ASK_TOP_ID, `${DISPATCH_MARKER}coder`),
        askSession("ses_child_b", "ses_job_b", "attempt"),
      ],
    })
    const registry = new PermissionAskRegistry()
    const clock = createFakeClock(0)
    seedPermissionAsk(registry, { requestID: "req-a", sessionID: "ses_child_a", permission: "bash", patterns: ["a"] }, 0)
    seedPermissionAsk(registry, { requestID: "req-b", sessionID: "ses_child_b", permission: "bash", patterns: ["b"] }, 0)
    fake.permission!.seedAsks([
      { id: "req-a", sessionID: "ses_child_a", permission: "bash", patterns: ["a"] },
      { id: "req-b", sessionID: "ses_child_b", permission: "bash", patterns: ["b"] },
    ])
    const probe = createFakePendingAsksProbe(fake, registry, clock)
    const [jobA, jobB] = await Promise.all([
      probe({ jobID: "ses_job_a", childSessionID: "ses_child_a", parentID: ASK_TOP_ID, role: "coder" }),
      probe({ jobID: "ses_job_b", childSessionID: "ses_child_b", parentID: ASK_TOP_ID, role: "coder" }),
    ])
    expect(jobA.asks.map((ask) => ask.requestID)).toEqual(["req-a"])
    expect(jobB.asks.map((ask) => ask.requestID)).toEqual(["req-b"])
  })

  it("QS3 — a completed leaf job makes zero pendingAsks and zero sessionStatus calls", async () => {
    const fake = createFakeSdk({
      seedPermission: true,
      sessions: [askSession(ASK_TOP_ID, undefined, "human"), askSession(ASK_JOB_ID, ASK_TOP_ID, `${DISPATCH_MARKER}coder`), askSession(ASK_CHILD_ID, ASK_JOB_ID, "attempt")],
    })
    fake.seedMessages(ASK_CHILD_ID, [completedAskMessage(ASK_CHILD_ID, ASK_REQUEST_ID, "done")])
    const registry = new PermissionAskRegistry()
    const clock = createFakeClock(0)
    const base = createFakePendingAsksProbe(fake, registry, clock)
    let probeCalls = 0
    const observation = await observeAttempt(
      { sdk: fake, clock, askRegistry: registry, pendingAsksProbe: (context) => { probeCalls++; return base(context) } },
      {
        jobID: ASK_JOB_ID, directory: FAKE_DIRECTORY, waitBudgetMs: 0, parentID: ASK_TOP_ID, role: "coder",
        active: { index: 0, model: "m", sessionID: ASK_CHILD_ID, requestMessageID: ASK_REQUEST_ID },
      },
    )
    expect(observation).toEqual({ kind: "completed", text: "done" })
    expect(probeCalls).toBe(0)
    expect(sdkCallCount(fake, "status")).toBe(0)
  })

  it("QS3 — ask-free polls skip the probe and never read sessions or children outside lineage walks", async () => {
    const fake = createFakeSdk({
      seedPermission: true,
      sessions: [askSession(ASK_TOP_ID, undefined, "human"), askSession(ASK_JOB_ID, ASK_TOP_ID, `${DISPATCH_MARKER}coder`), askSession(ASK_CHILD_ID, ASK_JOB_ID, "attempt")],
    })
    fake.seedMessages(ASK_CHILD_ID, [inFlightAskMessage(ASK_CHILD_ID, ASK_REQUEST_ID)])
    const registry = new PermissionAskRegistry()
    const clock = createFakeClock(0)
    const base = createFakePendingAsksProbe(fake, registry, clock)
    let probeCalls = 0
    const observed = observeAttempt(
      { sdk: fake, clock, askRegistry: registry, pendingAsksProbe: (context) => { probeCalls++; return base(context) } },
      {
        jobID: ASK_JOB_ID, directory: FAKE_DIRECTORY, waitBudgetMs: 4_500, parentID: ASK_TOP_ID, role: "coder",
        active: { index: 0, model: "m", sessionID: ASK_CHILD_ID, requestMessageID: ASK_REQUEST_ID },
      },
    )
    await advanceUntilSettled(clock, observed, 100)
    const result = await observed
    expect(result.kind).toBe("pending")
    expect(probeCalls).toBe(0)
    const pollCount = sdkCallCount(fake, "messages")
    expect(sdkCallCount(fake, "list")).toBeLessThanOrEqual(pollCount)
    expect(sdkCallCount(fake, "get")).toBe(0)
    expect(sdkCallCount(fake, "children")).toBe(0)
  })

  it("D3 attach-path — the envelope carries the probe's already-sanitized ask", async () => {
    const fake = createFakeSdk({
      seedPermission: true,
      sessions: [askSession(ASK_TOP_ID, undefined, "human"), askSession(ASK_JOB_ID, ASK_TOP_ID, `${DISPATCH_MARKER}coder`), askSession(ASK_CHILD_ID, ASK_JOB_ID, "attempt")],
    })
    fake.seedMessages(ASK_CHILD_ID, [inFlightAskMessage(ASK_CHILD_ID, ASK_REQUEST_ID)])
    const registry = new PermissionAskRegistry()
    const clock = createFakeClock(0)
    const probe = createFakePendingAsksProbe(fake, registry, clock)
    seedLivePermissionAsk(fake, registry, {
      id: "req\u0001-1",
      sessionID: ASK_CHILD_ID,
      permission: "bash\u0000\u0007",
      patterns: Array.from({ length: 20 }, () => "p".repeat(600)),
    }, 0)
    const result = await observeDispatch({
      sdk: fake, jobID: ASK_JOB_ID, childSessionID: ASK_CHILD_ID, requestMessageID: ASK_REQUEST_ID,
      directory: FAKE_DIRECTORY, waitBudgetMs: 0, clock, startupGraceMs: 0, parentID: ASK_TOP_ID,
      pendingAsks: () => probe({ jobID: ASK_JOB_ID, childSessionID: ASK_CHILD_ID, parentID: ASK_TOP_ID, role: "coder" }),
      getAskVersion: () => registry.getVersion(FAKE_DIRECTORY),
      waitForAskWake: (seen, signal) => registry.waitForAskWake(FAKE_DIRECTORY, seen, signal),
    })
    if (result.kind !== "pending") throw new Error("expected pending")
    const outcome = observationToOutcome(result, ASK_JOB_ID, "coder", { index: 0, model: null, sessionID: ASK_CHILD_ID }, 0)
    if (outcome.kind !== "nonterminal") throw new Error("expected nonterminal")
    const ask = outcome.envelope.pending_asks?.[0]
    if (ask === undefined) throw new Error("expected pending ask")
    expect(PendingAskSchema.safeParse(ask).success).toBe(true)
    expect(ask.requestID).toBe("req-1")
    expect(ask.permission).toBe("bash")
    expect(ask.patterns).toHaveLength(16)
    expect(ask.patterns.every((pattern) => pattern.length <= 512)).toBe(true)
    expect(ask.age_ms).toBeGreaterThanOrEqual(0)
  })

  it("D2.3 — a persisted cancel-intent at or after firstSeenAt excludes the ask; an earlier one does not", async () => {
    const intentMessage = (intentAt: number): SdkMessageWithParts => ({
      info: { role: "assistant", id: `msg-intent-${intentAt}`, sessionID: ASK_JOB_ID },
      parts: [{ type: "text", text: JSON.stringify({ kind: "cancel-intent", intent_at: intentAt, job_id: ASK_JOB_ID }), synthetic: true, ignored: true }],
    })
    async function observeWithIntent(intentAt: number) {
      const fake = createFakeSdk({
        seedPermission: true,
        sessions: [askSession(ASK_TOP_ID, undefined, "human"), askSession(ASK_JOB_ID, ASK_TOP_ID, `${DISPATCH_MARKER}coder`), askSession(ASK_CHILD_ID, ASK_JOB_ID, "attempt")],
        messages: { [ASK_JOB_ID]: [intentMessage(intentAt)], [ASK_CHILD_ID]: [inFlightAskMessage(ASK_CHILD_ID, ASK_REQUEST_ID)] },
      })
      const registry = new PermissionAskRegistry()
      const clock = createFakeClock(0)
      const probe = createFakePendingAsksProbe(fake, registry, clock)
      seedLivePermissionAsk(fake, registry, { id: "req-1", sessionID: ASK_CHILD_ID, permission: "bash", patterns: ["rm -rf build"] }, 0)
      return observeDispatch({
        sdk: fake, jobID: ASK_JOB_ID, childSessionID: ASK_CHILD_ID, requestMessageID: ASK_REQUEST_ID,
        directory: FAKE_DIRECTORY, waitBudgetMs: 0, clock, startupGraceMs: 0, parentID: ASK_TOP_ID,
        pendingAsks: () => probe({ jobID: ASK_JOB_ID, childSessionID: ASK_CHILD_ID, parentID: ASK_TOP_ID, role: "coder" }),
        getAskVersion: () => registry.getVersion(FAKE_DIRECTORY),
        waitForAskWake: (seen, signal) => registry.waitForAskWake(FAKE_DIRECTORY, seen, signal),
      })
    }
    const excluded = await observeWithIntent(0)
    if (excluded.kind !== "pending") throw new Error("expected pending")
    expect(excluded.diagnostics?.pending_asks).toBeUndefined()
    const included = await observeWithIntent(-1)
    if (included.kind !== "pending") throw new Error("expected pending")
    expect(included.diagnostics?.pending_asks).toHaveLength(1)
  })

  it("observer-side lineage — past the depth cap and over an unreadable hop it never attributes and never throws", async () => {
    // Depth > MAX_LINEAGE_DEPTH between the ask session and the job root.
    const deepSessions: SdkSession[] = [
      askSession(ASK_TOP_ID, undefined, "human"),
      askSession("ses_job_root", ASK_TOP_ID, `${DISPATCH_MARKER}coder`),
    ]
    let parent = "ses_job_root"
    for (let i = MAX_LINEAGE_DEPTH + 2; i >= 0; i--) {
      const id = `ses_deep_${i}`
      deepSessions.push(askSession(id, parent, "deep"))
      parent = id
    }
    const deepFake = createFakeSdk({ seedPermission: true, sessions: deepSessions })
    const deepRegistry = new PermissionAskRegistry()
    const deepClock = createFakeClock(0)
    seedPermissionAsk(deepRegistry, { requestID: "req-deep", sessionID: "ses_deep_0", permission: "bash", patterns: ["x"] }, 0)
    deepFake.permission!.seedAsks([{ id: "req-deep", sessionID: "ses_deep_0", permission: "bash", patterns: ["x"] }])
    const deepProbe = createFakePendingAsksProbe(deepFake, deepRegistry, deepClock)
    const deep = await deepProbe({ jobID: "ses_job_root", childSessionID: "ses_child_other", parentID: ASK_TOP_ID, role: "coder" })
    expect(deep.asks).toEqual([])

    // One unreadable hop midway fails closed to non-attribution.
    const brokenFake = createFakeSdk({
      seedPermission: true,
      sessions: [
        askSession(ASK_TOP_ID, undefined, "human"),
        askSession("ses_job_root", ASK_TOP_ID, `${DISPATCH_MARKER}coder`),
        askSession("ses_broken_0", "ses_broken_1", "deep"),
        askSession("ses_broken_1", "ses_job_root", "deep"),
      ],
    })
    const originalGet = brokenFake.session.get.bind(brokenFake.session)
    brokenFake.session.get = async (input) => input.path.id === "ses_broken_1" ? { data: undefined } : originalGet(input)
    const brokenRegistry = new PermissionAskRegistry()
    const brokenClock = createFakeClock(0)
    seedPermissionAsk(brokenRegistry, { requestID: "req-broken", sessionID: "ses_broken_0", permission: "bash", patterns: ["x"] }, 0)
    brokenFake.permission!.seedAsks([{ id: "req-broken", sessionID: "ses_broken_0", permission: "bash", patterns: ["x"] }])
    const brokenProbe = createFakePendingAsksProbe(brokenFake, brokenRegistry, brokenClock)
    const broken = await brokenProbe({ jobID: "ses_job_root", childSessionID: "ses_child_other", parentID: ASK_TOP_ID, role: "coder" })
    expect(broken.asks).toEqual([])
  })

  it("decision — an unknown caller status holds with is_dispatched_subsession_caller: true and never early-yields", async () => {
    const missingCaller = "ses_missing_caller"
    const fake = createFakeSdk({
      seedPermission: true,
      sessions: [askSession(ASK_JOB_ID, undefined, `${DISPATCH_MARKER}coder`), askSession(ASK_CHILD_ID, ASK_JOB_ID, "attempt")],
    })
    fake.seedMessages(ASK_CHILD_ID, [inFlightAskToolMessage(ASK_CHILD_ID, ASK_REQUEST_ID)])
    const registry = new PermissionAskRegistry()
    const clock = createFakeClock(0)
    const probe = createFakePendingAsksProbe(fake, registry, clock)
    seedLivePermissionAsk(fake, registry, { id: "req-1", sessionID: ASK_CHILD_ID, permission: "bash", patterns: ["rm -rf build"] }, 0)
    const observed = observeDispatch({
      sdk: fake, jobID: ASK_JOB_ID, childSessionID: ASK_CHILD_ID, requestMessageID: ASK_REQUEST_ID,
      directory: FAKE_DIRECTORY, waitBudgetMs: 400_000, clock, startupGraceMs: 0, parentID: missingCaller,
      pendingAsks: () => probe({ jobID: ASK_JOB_ID, childSessionID: ASK_CHILD_ID, parentID: missingCaller, role: "coder" }),
      getAskVersion: () => registry.getVersion(FAKE_DIRECTORY),
      waitForAskWake: (seen, signal) => registry.waitForAskWake(FAKE_DIRECTORY, seen, signal),
    })
    await advanceUntilSettled(clock, observed, 10_000)
    const result = await observed
    if (result.kind !== "pending") throw new Error("expected pending")
    expect(result.diagnostics?.is_dispatched_subsession_caller).toBe(true)
    expect(result.diagnostics?.pending_asks).toHaveLength(1)
    expect(clock.now()).toBeGreaterThan(STALLED_SUSPECT_MS)
    const outcome = observationToOutcome(result, ASK_JOB_ID, "coder", { index: 0, model: null, sessionID: ASK_CHILD_ID }, 0)
    if (outcome.kind !== "nonterminal") throw new Error("expected nonterminal")
    expect(outcome.envelope.reason).toContain("never finish its turn")
  })

  it("T1 regression — a terminal idle-confirmation re-read is intercepted on a snapshot, never returned as completed", async () => {
    const fake = createFakeSdk()
    let reads = 0
    const inFlight = inFlightAskMessage(ASK_CHILD_ID, ASK_REQUEST_ID)
    const completed = completedAskMessage(ASK_CHILD_ID, ASK_REQUEST_ID, "done")
    fake.session.messages = async () => ({ data: ++reads === 1 ? [inFlight] : [completed] })
    const result = await observeDispatch({
      sdk: fake, jobID: ASK_JOB_ID, childSessionID: ASK_CHILD_ID, requestMessageID: ASK_REQUEST_ID,
      directory: FAKE_DIRECTORY, waitBudgetMs: 0, clock: createFakeClock(20_000), startupGraceMs: 0, parentID: ASK_TOP_ID,
      checkSubtreeAsksOnCompletion: true,
      sessionStatus: async () => ({ status: "idle" }),
      pendingAsks: async () => ({ asks: [askFixture()], isDispatchedSubsessionCaller: false, allAlreadySurfacedInCurrentTurn: false }),
    })
    expect(reads).toBe(2)
    expect(result.kind).toBe("pending")
    if (result.kind !== "pending") throw new Error("expected pending")
    expect(result.diagnostics?.pending_asks?.map((ask) => ask.requestID)).toEqual(["req-1"])
    expect(result.diagnostics?.coordinator_turn_ended).toEqual({ coordinatorSessionID: ASK_CHILD_ID, descendantJobIDs: [] })
  })

  it("T1 regression — the terminal idle-confirmation re-read is intercepted during an L1 hold too", async () => {
    const fake = createFakeSdk()
    let reads = 0
    const inFlight = inFlightAskMessage(ASK_CHILD_ID, ASK_REQUEST_ID)
    const completed = completedAskMessage(ASK_CHILD_ID, ASK_REQUEST_ID, "done")
    fake.session.messages = async () => ({ data: ++reads === 1 ? [inFlight] : [completed] })
    const result = await observeDispatch({
      sdk: fake, jobID: ASK_JOB_ID, childSessionID: ASK_CHILD_ID, requestMessageID: ASK_REQUEST_ID,
      directory: FAKE_DIRECTORY, waitBudgetMs: 1_800_000, clock: createFakeClock(20_000), startupGraceMs: 0, parentID: ASK_TOP_ID,
      checkSubtreeAsksOnCompletion: true,
      sessionStatus: async () => ({ status: "idle" }),
      pendingAsks: async () => ({ asks: [askFixture()], isDispatchedSubsessionCaller: true, allAlreadySurfacedInCurrentTurn: false }),
    })
    expect(reads).toBe(2)
    expect(result.kind).toBe("pending")
    if (result.kind !== "pending") throw new Error("expected pending")
    expect(result.diagnostics?.pending_asks).toHaveLength(1)
    expect(result.diagnostics?.coordinator_turn_ended?.coordinatorSessionID).toBe(ASK_CHILD_ID)
  })
})
