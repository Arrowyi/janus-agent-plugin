import { describe, expect, test } from "bun:test"
import { getEventListeners } from "node:events"
import { abortAndReconcile, createDispatchCancel, createSessionStatusProbe, createSystemClock, findActiveAttempt } from "./dispatch-cancel.ts"
import { createKeyedMutex, parseOutcomeEnvelope, type DispatchSdk, type SdkAssistantMessage, type SdkMessageWithParts, type SdkResult } from "./dispatch-contract.ts"
import { appendRecord, createAttemptSession, createJob, loadJob } from "./dispatch-journal.ts"
import { createDispatchLifecycle } from "./dispatch-lifecycle.ts"
import { createFakeClock, createFakePendingAsksProbe, createFakeSdk, FAKE_DIRECTORY, FAKE_PARENT_ID, makeJobSpec, seedLivePermissionAsk, validRoleSpecs } from "./dispatch-test-fixtures.ts"
import { PermissionAskRegistry, resolvePermissionSdk } from "./permission-ask.ts"

function deferred<T>() {
  let resolve: (value: T) => void = () => { throw new Error("deferred not initialized") }
  const promise = new Promise<T>((done) => { resolve = done })
  return { promise, resolve }
}

async function fixture(spec = validRoleSpecs[1]!.record, withAttempt = true) {
  const host = createFakeSdk()
  const clock = createFakeClock()
  const mutex = createKeyedMutex()
  const aborts: string[] = []
  let abortEffect: (id: string) => Promise<SdkResult<boolean>> = async () => ({ data: true })
  const sdk: DispatchSdk = { session: { ...host.session, abort: async (input) => {
    expect(input.query?.directory).toBe(FAKE_DIRECTORY)
    aborts.push(input.path.id)
    return abortEffect(input.path.id)
  } } }
  const root = await createJob(sdk, { parentID: FAKE_PARENT_ID, directory: FAKE_DIRECTORY, role: spec.role as import("./dispatch-contract.ts").DispatchRole, agentName: spec.agent_name, modelChain: spec.model_chain, prompt: spec.prompt, clock })
  if (!root.ok) throw root.error
  const jobID = root.value.jobID
  const input = { jobID, parentID: FAKE_PARENT_ID, directory: FAKE_DIRECTORY }
  const cancel = createDispatchCancel({ sdk, clock, mutex })
  const lifecycle = createDispatchLifecycle({ sdk, clock, mutex })
  async function addAttempt(index = 0) {
    const child = await createAttemptSession(sdk, { jobID, directory: FAKE_DIRECTORY, role: spec.role })
    if (!child.ok) throw child.error
    const sessionID = child.value.sessionID
    const messageID = `msg-request-${index}`
    for (const record of [
      { v: 1, kind: "attempt-reservation", job_id: jobID, attempt_index: index, model: spec.model_chain[index] ?? null, message_id: messageID, reserved_at: clock.now() } as const,
      { v: 1, kind: "attempt-receipt", job_id: jobID, attempt_index: index, session_id: sessionID, message_id: messageID, received_at: clock.now() } as const,
    ]) {
      const result = await appendRecord(sdk, { jobID, directory: FAKE_DIRECTORY, record })
      if (!result.ok) throw result.error
    }
    function seed(error?: unknown, text = "original report", completed = true, parentID = messageID) {
      const info: SdkAssistantMessage = { id: `msg-answer-${index}-${clock.now()}`, role: "assistant", sessionID, parentID, modelID: "model", providerID: "provider", time: { created: clock.now(), ...(completed ? { completed: clock.now() } : {}) }, finish: "stop", ...(error === undefined ? {} : { error }) }
      host.seedMessages(sessionID, [{ info, parts: [{ type: "text", text }] }])
    }
    return { sessionID, messageID, seed }
  }
  const active = withAttempt ? await addAttempt() : { sessionID: "", messageID: "", seed: () => {} }
  return { host, sdk, clock, mutex, aborts, input, cancel, lifecycle, active, addAttempt,
    setAbort(effect: typeof abortEffect) { abortEffect = effect },
    async intents() {
      const loaded = await loadJob(sdk, { jobID, directory: FAKE_DIRECTORY, expectedParentID: FAKE_PARENT_ID })
      if (!loaded.ok) throw loaded.error
      return loaded.value.cancelIntents
    },
  }
}

function status(text: string) {
  const parsed = parseOutcomeEnvelope(text)
  if (!parsed.ok) throw parsed.error
  return parsed.value
}

const aborted = { name: "MessageAbortedError", data: { message: "aborted" } } as const
const retryable = { name: "APIError", data: { message: "unavailable", isRetryable: true } } as const
const writerChainSeam = makeJobSpec({ role: "author-writer", agent_name: "consultation-writer", model_chain: ["opencode/claude-sonnet-5-5", "opencode-go/glm-5.3"] })

test("fix-3 removes sleep abort listeners when the timer settles normally", async () => {
  // Given a reusable caller signal.
  const controller = new AbortController()
  const clock = createSystemClock()
  // When several real timer sleeps finish without aborting.
  for (let i = 0; i < 3; i++) await clock.sleep(0, controller.signal)
  // Then no callbacks accumulate on that signal.
  expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
})

for (const variant of validRoleSpecs) describe(variant.label, () => {
  test("confirms active cancellation only after matching durable evidence", async () => {
    // Given: abort produces a matching terminal assistant error.
    const f = await fixture(variant.record)
    f.setAbort(async () => { expect(await f.intents()).toHaveLength(1); f.active.seed(aborted); return { data: true } })
    // When
    const result = status(await f.cancel.cancel(f.input))
    // Then: only the active child is targeted, with a retained recovery handle.
    expect(result).toMatchObject({ status: "cancelled", role: variant.role, job_id: f.input.jobID, session_id: f.active.sessionID })
    expect(f.aborts).toEqual([f.active.sessionID])
  })

  test("is idempotent across coordinator recreation when cancellation is confirmed", async () => {
    // Given
    const f = await fixture(variant.record)
    f.setAbort(async () => { f.active.seed(aborted); return { data: true } })
    await f.cancel.cancel(f.input)
    const resumed = createDispatchCancel({ sdk: f.sdk, clock: f.clock, mutex: f.mutex })
    // When
    const result = status(await resumed.cancel(f.input))
    // Then
    expect(result.status).toBe("cancelled")
    expect(f.aborts).toEqual([f.active.sessionID])
    expect(await f.intents()).toHaveLength(1)
  })

  for (const transport of ["rejected", "error-response"] as const) test(`retains intent on ${transport} and retries explicit cancellation`, async () => {
    // Given
    const f = await fixture(variant.record)
    f.setAbort(async () => { if (transport === "rejected") throw new Error("network unavailable"); return { error: { message: "network unavailable" } } })
    const first = status(await f.cancel.cancel(f.input))
    expect(first.status).toBe("cancelling")
    expect(await f.intents()).toHaveLength(1)
    f.setAbort(async () => { f.active.seed(aborted); return { data: true } })
    // When
    const result = status(await f.cancel.cancel(f.input))
    // Then
    expect(result.status).toBe("cancelled")
    expect(f.aborts).toEqual([f.active.sessionID, f.active.sessionID])
  })

  test("returns already completed report without intent or abort", async () => {
    // Given
    const f = await fixture(variant.record)
    f.active.seed()
    // When
    const result = await f.cancel.cancel(f.input)
    // Then
    expect(result).toBe("original report")
    expect(f.aborts).toEqual([])
    expect(await f.intents()).toHaveLength(0)
  })

  test("preserves normal completion racing the abort request", async () => {
    // Given
    const f = await fixture(variant.record)
    f.setAbort(async () => { f.active.seed(); return { data: true } })
    // When
    const result = await f.cancel.cancel(f.input)
    // Then
    expect(result).toBe("original report")
    expect(await f.lifecycle.wait({ ...f.input, waitMs: 0 })).toBe("original report")
    expect(f.aborts).toEqual([f.active.sessionID])
  })

  test("serializes concurrent cancel/wait/repeat without double abort", async () => {
    // Given: hold the abort request to prove both other operations queue.
    const f = await fixture(variant.record)
    const entered = deferred<void>(), release = deferred<void>()
    const order: string[] = []
    f.setAbort(async () => { order.push("abort-start"); entered.resolve(); await release.promise; f.active.seed(aborted); order.push("abort-end"); return { data: true } })
    const cancellation = f.cancel.cancel(f.input)
    await entered.promise
    const waiting = f.lifecycle.wait({ ...f.input, waitMs: 0 }).then((text) => { order.push("wait-end"); return text })
    const repeated = f.cancel.cancel(f.input)
    expect(order).toEqual(["abort-start"])
    // When
    release.resolve()
    const results = await Promise.all([cancellation, waiting, repeated])
    // Then
    expect(results.map((text) => status(text).status)).toEqual(["cancelled", "cancelled", "cancelled"])
    expect(order).toEqual(["abort-start", "abort-end", "wait-end"])
    expect(f.aborts).toEqual([f.active.sessionID])
  })

  test("reconciles delayed submission on next wait without clearing intent", async () => {
    // Given: acknowledged abort has no matching message; launch evidence arrives later.
    const f = await fixture(variant.record)
    expect(status(await f.cancel.cancel(f.input)).status).toBe("cancelling")
    f.active.seed(undefined, "partial", false)
    f.setAbort(async () => { f.clock.advance(1); f.active.seed(aborted); return { data: true } })
    // When
    const result = status(await f.lifecycle.wait({ ...f.input, waitMs: 0 }))
    // Then
    expect(result.status).toBe("cancelled")
    expect(f.aborts).toEqual([f.active.sessionID, f.active.sessionID])
    expect(await f.intents()).toHaveLength(1)
  })

  test("never confirms from true plus idle or unrelated aborted messages", async () => {
    // Given
    const f = await fixture(variant.record)
    f.host.setStatusResult({ data: { [f.active.sessionID]: { type: "idle" } } })
    f.active.seed(aborted, "", true, "msg-unrelated")
    // When
    const result = status(await f.cancel.cancel(f.input))
    // Then
    expect(result).toMatchObject({ status: "cancelling", next: "janus_dispatch_wait" })
  })
})

test("rejects missing/cross-parent/cross-workspace/corrupt ownership uniformly with zero aborts", async () => {
  // Given
  const f = await fixture()
  // When
  const results = await Promise.all([
    f.cancel.cancel({ ...f.input, jobID: "ses-missing" }),
    f.cancel.cancel({ ...f.input, parentID: "ses-other" }),
    f.cancel.cancel({ ...f.input, directory: "/tmp/other" }),
  ])
  f.host.seedMessages(f.input.jobID, [{ info: { role: "user", id: "msg-corrupt", sessionID: f.input.jobID }, parts: [{ type: "text", text: '{"v":9,"kind":"job-spec"}', ignored: true, synthetic: true }] }])
  results.push(await f.cancel.cancel(f.input))
  // Then
  expect(new Set(results).size).toBe(1)
  expect(results[0]?.startsWith("Error:")).toBe(true)
  expect(f.aborts).toEqual([])
})

test("writer intent prevents concurrent fallback after terminal retryable failure", async () => {
  // Given
  const f = await fixture(writerChainSeam)
  f.active.seed(retryable)
  // When: cancel owns the lock before the wait attempts fallback.
  const [cancelled, waiting] = await Promise.all([f.cancel.cancel(f.input), f.lifecycle.wait({ ...f.input, waitMs: 0 })])
  // Then: completed failed child is not aborted; no next generating request exists.
  expect(status(cancelled).status).toBe("cancelling")
  expect(waiting.startsWith("Error:")).toBe(true)
  expect(f.aborts).toEqual([])
  const loaded = await loadJob(f.sdk, { jobID: f.input.jobID, directory: FAKE_DIRECTORY, expectedParentID: FAKE_PARENT_ID })
  expect(loaded.ok && loaded.value.receipts.length).toBe(1)
})

test("targets only highest active attempt, never completed sibling or root", async () => {
  // Given
  const f = await fixture(writerChainSeam)
  f.active.seed(retryable)
  const next = await f.addAttempt(1)
  f.setAbort(async () => { next.seed(aborted); return { data: true } })
  // When
  const result = status(await f.cancel.cancel(f.input))
  // Then
  expect(result.attempt.index).toBe(1)
  expect(f.aborts).toEqual([next.sessionID])
})

test("retains pre-receipt intent and reconciles a child discovered by a later wait", async () => {
  // Given
  const f = await fixture(validRoleSpecs[0]!.record, false)
  expect(status(await f.cancel.cancel(f.input)).status).toBe("cancelling")
  expect(f.aborts).toEqual([])
  const delayed = await f.addAttempt()
  f.setAbort(async () => { delayed.seed(aborted); return { data: true } })
  // When
  const result = status(await f.lifecycle.wait({ ...f.input, waitMs: 0 }))
  // Then
  expect(result.status).toBe("cancelled")
  expect(f.aborts).toEqual([delayed.sessionID])
  expect(await f.intents()).toHaveLength(1)
})

test("serializes cancel behind fallback submission already in progress", async () => {
  // Given
  const f = await fixture(writerChainSeam)
  f.active.seed(retryable)
  const submitted = deferred<string>(), release = deferred<void>()
  const sdk: DispatchSdk = { session: { ...f.sdk.session, promptAsync: async (input) => {
    submitted.resolve(input.path.id)
    await release.promise
    return f.sdk.session.promptAsync(input)
  } } }
  const lifecycle = createDispatchLifecycle({ sdk, clock: f.clock, mutex: f.mutex })
  const waiting = lifecycle.wait({ ...f.input, waitMs: 0 })
  const child = await submitted.promise
  const cancellation = f.cancel.cancel(f.input)
  f.setAbort(async (id) => {
    const loaded = await loadJob(f.sdk, { jobID: f.input.jobID, directory: FAKE_DIRECTORY, expectedParentID: FAKE_PARENT_ID })
    if (!loaded.ok) throw loaded.error
    const receipt = loaded.value.receipts.find((r) => r.session_id === id)
    if (!receipt) throw new Error("missing fallback receipt")
    const info: SdkAssistantMessage = { role: "assistant", id: "msg-fallback-aborted", sessionID: id, parentID: receipt.message_id, time: { created: 1, completed: 1 }, providerID: "provider", modelID: "model", error: aborted }
    f.host.seedMessages(id, [{ info, parts: [] }])
    return { data: true }
  })
  // When
  release.resolve()
  await waiting
  const result = status(await cancellation)
  // Then
  expect(result.status).toBe("cancelled")
  expect(f.aborts).toEqual([child])
  expect(status(await lifecycle.wait({ ...f.input, waitMs: 0 })).status).toBe("cancelled")
  expect(await f.intents()).toHaveLength(1)
})

function denyHostStoppedWrites(sdk: DispatchSdk): void {
  const base = sdk.session.prompt.bind(sdk.session)
  sdk.session.prompt = async (input) => {
    if (input.body.parts.some((part) => part.type === "text" && typeof part.text === "string" && part.text.includes('"reason":"host-stopped"'))) {
      throw new Error("journal write rejected")
    }
    return base(input)
  }
}

async function activeAttemptOf(f: Awaited<ReturnType<typeof fixture>>) {
  const loaded = await loadJob(f.sdk, { jobID: f.input.jobID, directory: FAKE_DIRECTORY, expectedParentID: FAKE_PARENT_ID })
  if (!loaded.ok) throw loaded.error
  const active = findActiveAttempt(loaded.value)
  if (active === undefined) throw new Error("missing active attempt")
  return { loaded: loaded.value, active }
}

test("createSessionStatusProbe throws on transport error, returns undefined on non-object data, maps a missing key to idle", async () => {
  const throwing = createFakeSdk()
  throwing.session.status = async () => { throw new Error("status down") }
  await expect(createSessionStatusProbe(throwing, FAKE_DIRECTORY, "ses_x")()).rejects.toThrow("status down")

  const nonObject = createFakeSdk()
  nonObject.session.status = async () => ({ data: undefined })
  expect(await createSessionStatusProbe(nonObject, FAKE_DIRECTORY, "ses_x")()).toBeUndefined()

  const fake = createFakeSdk()
  expect(await createSessionStatusProbe(fake, FAKE_DIRECTORY, "ses_x")()).toEqual({ status: "idle" })
  fake.setStatusResult({ data: { ses_x: { type: "busy" } } })
  expect(await createSessionStatusProbe(fake, FAKE_DIRECTORY, "ses_x")()).toEqual({ status: "busy" })
})

test("snapshot uses the decayed startup grace: 9999ms stays pending, 10000ms cancels", async () => {
  for (const [age, expected] of [[9_999, "pending"], [10_000, "cancelled"]] as const) {
    const f = await fixture()
    f.active.seed(undefined, "working", false)
    f.clock.advance(age)
    const result = status(await f.lifecycle.wait({ ...f.input, waitMs: 0 }))
    expect(result.status).toBe(expected)
  }
})

test("cancel pre-snapshot fails closed to unknown when the host-stopped intent cannot be persisted", async () => {
  const f = await fixture()
  f.active.seed(undefined, "working", false)
  f.clock.advance(20_000)
  denyHostStoppedWrites(f.sdk)
  const result = status(await f.cancel.cancel(f.input))
  expect(result.status).toBe("unknown")
  expect(f.aborts).toEqual([])
})

test("abortAndReconcile before-snapshot fails closed to unknown when the host-stopped intent cannot be persisted", async () => {
  const f = await fixture()
  f.active.seed(undefined, "working", false)
  f.clock.advance(20_000)
  denyHostStoppedWrites(f.sdk)
  const { loaded, active } = await activeAttemptOf(f)
  const outcome = await abortAndReconcile({ sdk: f.sdk, clock: f.clock, loaded, active })
  if (outcome.kind !== "nonterminal") throw new Error("expected nonterminal outcome")
  expect(outcome.envelope.status).toBe("unknown")
  expect(f.aborts).toEqual([])
})

test("abortAndReconcile after-snapshot fails closed to unknown when the host-stopped intent cannot be persisted", async () => {
  const f = await fixture()
  const baseMessages = f.sdk.session.messages.bind(f.sdk.session)
  let createdAt = 19_000
  f.sdk.session.messages = async (input) => {
    if (input.path.id !== f.active.sessionID) return baseMessages(input)
    const info: SdkAssistantMessage = { id: "msg-active", role: "assistant", sessionID: f.active.sessionID, parentID: f.active.messageID, modelID: "m", providerID: "p", time: { created: createdAt } }
    const message: SdkMessageWithParts = { info, parts: [{ type: "text", text: "working" }] }
    return { data: [message] }
  }
  f.clock.advance(20_000)
  f.setAbort(async () => { createdAt = 0; return { data: true } })
  denyHostStoppedWrites(f.sdk)
  const { loaded, active } = await activeAttemptOf(f)
  const outcome = await abortAndReconcile({ sdk: f.sdk, clock: f.clock, loaded, active })
  if (outcome.kind !== "nonterminal") throw new Error("expected nonterminal outcome")
  expect(outcome.envelope.status).toBe("unknown")
  expect(f.aborts).toEqual([f.active.sessionID])
})

test("cancel appends host-stopped beside a user intent and a resumed busy child stays cancelled with zero aborts", async () => {
  const f = await fixture()
  f.active.seed(undefined, "working", false)
  const userIntent = await appendRecord(f.sdk, {
    jobID: f.input.jobID, directory: FAKE_DIRECTORY,
    record: { v: 1, kind: "cancel-intent", job_id: f.input.jobID, intent_at: f.clock.now() },
  })
  if (!userIntent.ok) throw userIntent.error
  f.clock.advance(20_000)

  const first = status(await f.cancel.cancel(f.input))
  expect(first.status).toBe("cancelled")
  expect(f.aborts).toEqual([])
  expect((await f.intents()).filter((intent) => intent.reason === "host-stopped")).toHaveLength(1)

  f.host.setStatusResult({ data: { [f.active.sessionID]: { type: "busy" } } })
  const second = status(await f.cancel.cancel(f.input))
  expect(second.status).toBe("cancelled")
  expect(f.aborts).toEqual([])
  expect((await f.intents()).filter((intent) => intent.reason === "host-stopped")).toHaveLength(1)
})

test("cancel lets a racing terminal snapshot beat a persisted host-stopped intent", async () => {
  const completed = await fixture()
  completed.active.seed()
  const intent = await appendRecord(completed.sdk, {
    jobID: completed.input.jobID, directory: FAKE_DIRECTORY,
    record: { v: 1, kind: "cancel-intent", job_id: completed.input.jobID, intent_at: completed.clock.now(), reason: "host-stopped" },
  })
  if (!intent.ok) throw intent.error
  expect(await completed.cancel.cancel(completed.input)).toBe("original report")
  expect(completed.aborts).toEqual([])

  const failed = await fixture()
  failed.active.seed({ name: "APIError", data: { isRetryable: false, statusCode: 500 } })
  const failedIntent = await appendRecord(failed.sdk, {
    jobID: failed.input.jobID, directory: FAKE_DIRECTORY,
    record: { v: 1, kind: "cancel-intent", job_id: failed.input.jobID, intent_at: failed.clock.now(), reason: "host-stopped" },
  })
  if (!failedIntent.ok) throw failedIntent.error
  expect((await failed.cancel.cancel(failed.input)).startsWith("Error:")).toBe(true)
  expect(failed.aborts).toEqual([])
})

test("abortAndReconcile forwards after-snapshot health diagnostics on the cancelling envelope", async () => {
  const f = await fixture()
  const baseMessages = f.sdk.session.messages.bind(f.sdk.session)
  const info: SdkAssistantMessage = { id: "msg-active", role: "assistant", sessionID: f.active.sessionID, parentID: f.active.messageID, modelID: "m", providerID: "p", time: { created: 0 } }
  const message = {
    info,
    parts: [
      { type: "text", text: "working" },
      { id: "prt-1", messageID: "msg-active", sessionID: f.active.sessionID, type: "tool", tool: "grep", callID: "call-1", state: { status: "running", input: {}, time: { start: 0 } } },
    ],
  } as unknown as SdkMessageWithParts
  f.sdk.session.messages = async (input) => input.path.id === f.active.sessionID ? { data: [message] } : baseMessages(input)
  f.clock.advance(20_000)
  f.host.setStatusResult({ data: { [f.active.sessionID]: { type: "busy" } } })
  const { loaded, active } = await activeAttemptOf(f)
  const outcome = await abortAndReconcile({ sdk: f.sdk, clock: f.clock, loaded, active })
  if (outcome.kind !== "nonterminal") throw new Error("expected nonterminal outcome")
  expect(outcome.envelope.status).toBe("cancelling")
  expect(outcome.envelope.running_tool).toBe("grep")
  expect(outcome.envelope.running_tool_ms).toBe(20_000)
  expect(outcome.envelope.session_status).toBe("busy")
  expect(f.aborts).toEqual([f.active.sessionID])
})

// --- P5 M2 cancel-epoch T2 and the cancel path's T1-off snapshot ---

async function askCancelFixture(role: "coder" | "consultant" = "consultant") {
  const host = createFakeSdk({ seedPermission: true })
  const clock = createFakeClock(0)
  const mutex = createKeyedMutex()
  const registry = new PermissionAskRegistry()
  const probe = createFakePendingAsksProbe(host, registry, clock)
  const permissionSdk = resolvePermissionSdk(host)
  if (permissionSdk === undefined) throw new Error("expected a fake permission surface")
  const sdk = host as DispatchSdk
  host.seedSession({ id: FAKE_PARENT_ID, directory: FAKE_DIRECTORY, title: "human", time: { created: 0, updated: 0 } })
  const created = await createJob(sdk, { parentID: FAKE_PARENT_ID, directory: FAKE_DIRECTORY, role, agentName: role, modelChain: ["opencode-go/glm-5.3"], prompt: "work", clock })
  if (!created.ok) throw created.error
  const jobID = created.value.jobID
  const child = await createAttemptSession(sdk, { jobID, directory: FAKE_DIRECTORY, role })
  if (!child.ok) throw child.error
  const sessionID = child.value.sessionID
  const messageID = "msg-ask-cancel-request"
  const reservation = await appendRecord(sdk, { jobID, directory: FAKE_DIRECTORY, messageID, record: { v: 1, kind: "attempt-reservation", job_id: jobID, attempt_index: 0, model: "opencode-go/glm-5.3", message_id: messageID, reserved_at: clock.now() } })
  if (!reservation.ok) throw reservation.error
  const receipt = await appendRecord(sdk, { jobID, directory: FAKE_DIRECTORY, record: { v: 1, kind: "attempt-receipt", job_id: jobID, attempt_index: 0, session_id: sessionID, message_id: messageID, received_at: clock.now() } })
  if (!receipt.ok) throw receipt.error
  const cancel = createDispatchCancel({ sdk, clock, mutex, askRegistry: registry, pendingAsksProbe: probe, permissionSdk })
  const lifecycle = createDispatchLifecycle({ sdk, clock, mutex, askRegistry: registry, pendingAsksProbe: probe, permissionSdk })
  const input = { jobID, parentID: FAKE_PARENT_ID, directory: FAKE_DIRECTORY }
  return { host, sdk, clock, registry, probe, permissionSdk, cancel, lifecycle, input, jobID, sessionID, messageID }
}

test("Probe 3 + T2 — cancel rejects a live ask via a fresh pull and a continuation re-escalates a newer ask", async () => {
  const f = await askCancelFixture("consultant")
  seedLivePermissionAsk(f.host, f.registry, { id: "req-old", sessionID: f.sessionID, permission: "bash", patterns: ["rm -rf build"] }, f.clock.now())
  const result = status(await f.cancel.cancel(f.input))
  expect(result.status).toBe("cancelling")
  const replies = f.host.permission!.calls.filter((call) => call.method === "reply")
  expect(replies).toHaveLength(1)
  expect(replies[0]?.input).toMatchObject({ requestID: "req-old", reply: "reject", message: "dispatch job cancelled" })

  // A continuation of the cancelled session arrives and immediately hits a new ask.
  f.clock.advance(1_000)
  f.registry.onAsked({ requestID: "req-new", sessionID: f.sessionID, directory: FAKE_DIRECTORY, permission: "edit", patterns: ["x"] }, f.clock.now())
  f.host.permission!.seedAsks([{ id: "req-new", sessionID: f.sessionID, permission: "edit", patterns: ["x"] }])
  const continued = status(await f.lifecycle.continue({
    role: "consultant", prompt: "continue the work", agentName: "consultant",
    modelChain: ["opencode-go/glm-5.3"], parentID: FAKE_PARENT_ID, directory: FAKE_DIRECTORY,
    sessionID: f.sessionID, continuedFrom: f.jobID, waitMs: 0,
  }))
  expect(continued.status).toBe("pending")
  if (continued.status !== "pending") throw new Error("expected pending envelope")
  expect(continued.pending_asks?.map((ask) => ask.requestID)).toEqual(["req-new"])
})

test("decision — the cancel snapshot keeps T1 off: a completed coordinator with a pending descendant ask is returned, not intercepted", async () => {
  const f = await askCancelFixture("consultant")
  const completed: SdkMessageWithParts = {
    info: { id: "msg-coordinator-done", sessionID: f.sessionID, role: "assistant", parentID: f.messageID, time: { created: 0, completed: 0 }, finish: "stop", modelID: "m", providerID: "p" },
    parts: [{ type: "text", text: "coordinator report" }],
  }
  f.host.seedMessages(f.sessionID, [completed])
  seedLivePermissionAsk(f.host, f.registry, { id: "req-l2", sessionID: f.sessionID, permission: "bash", patterns: ["rm -rf build"] }, 0)
  const result = await f.cancel.cancel(f.input)
  // T1 would have rewritten this to a pending envelope; the cancel path returns
  // the completed report and never reaches the T1 intercept.
  expect(result).toBe("coordinator report")
  expect(f.host.calls.filter((call) => (call as { method: string }).method === "abort")).toHaveLength(0)
  expect(f.host.permission!.calls.filter((call) => call.method === "reply")).toHaveLength(0)
})
