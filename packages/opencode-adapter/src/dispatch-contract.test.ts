import { describe, expect, it } from "bun:test"
import { getEventListeners } from "node:events"

import {
  DISPATCH_ROLES,
  DISPATCH_TIERS,
  DEFAULT_WAIT_MS,
  PRODUCTION_WAIT_BUDGET_MS,
  parseContinueArgs,
  parseDispatchRole,
  parseJournalRecord,
  parseWaitArgs,
  parseOutcomeEnvelope,
  serializeOutcome,
  createKeyedMutex,
} from "./dispatch-contract.ts"
import {
  FAKE_DIRECTORY,
  FAKE_JOB_ID,
  FAKE_MESSAGE_ID,
  FAKE_PARENT_ID,
  FAKE_SESSION_ID,
  adversarialRecords,
  createFakeClock,
  createFakeSdk,
  legacyRoleSpecs,
  makeAttemptReceipt,
  makeAttemptReservation,
  makeCancelledEnvelope,
  makeCancelIntent,
  makeCompletedEnvelope,
  makeEnvelope,
  makeJobSpec,
  validRoleSpecs,
} from "./dispatch-test-fixtures.ts"

import { CONFIG_TIERS } from "./plugin-config.ts"

function assertOk<T>(result: { ok: true; value: T } | { ok: false; error: Error }): T {
  if (!result.ok) throw new Error(`expected ok, got error: ${result.error.message}`)
  return result.value
}

function assertError(result: { ok: true; value: unknown } | { ok: false; error: Error }): Error {
  if (result.ok) throw new Error(`expected error, got value: ${JSON.stringify(result.value)}`)
  return result.error
}

describe("dispatch role constants", () => {
  it("exports roles, budget and default wait", () => {
    expect(DISPATCH_ROLES).toEqual([
      "consultant", "tech-lead", "author", "simple",
      "common-explorer", "consultant-analyst", "consultant-critic", "consultant-auditor", "solution-reviewer",
      "coder", "coder-reviewer", "author-writer", "author-reviewer",
    ])
    expect(PRODUCTION_WAIT_BUDGET_MS).toBe(1_800_000)
    expect(DEFAULT_WAIT_MS).toBe(PRODUCTION_WAIT_BUDGET_MS)
  })
})

describe("dispatch role parsing", () => {
  it("accepts every canonical role name", () => {
    for (const role of DISPATCH_ROLES) {
      expect(parseDispatchRole(role)).toEqual({ ok: true, value: role })
    }
  })

  it("rejects unknown and removed role names", () => {
    for (const role of ["explorer", "analyst", "critic", "arch-critic", "auditor", "writer", "ask-lite", "lite", "verifier", "build", "coder-lite"]) {
      const result = parseDispatchRole(role)
      expect(result.ok).toBe(false)
    }
  })
})

describe("journal record parsing", () => {
  it("parses all routing variants and retains agent name and model chain", () => {
    for (const { role, record } of validRoleSpecs) {
      const parsed = assertOk(parseJournalRecord(record))
      expect(parsed.kind).toBe("job-spec")
      if (parsed.kind !== "job-spec") continue
      expect(parsed.role).toBe(role)
      expect(parsed.agent_name).toBe(record.agent_name)
      expect(parsed.model_chain).toEqual(record.model_chain)
      expect(parsed.parent_id).toBe(FAKE_PARENT_ID)
      expect(parsed.directory).toBe(FAKE_DIRECTORY)
      expect(parsed.prompt).toBe("analyze this")
      expect(parsed.created_at).toBe(1_000_000)
      expect(parsed.v).toBe(1)
    }
  })

  it("represents an undefined delegate model as explicit null", () => {
    const delegateNull = validRoleSpecs.find((s) => s.label === "writer-delegate-null")
    const parsed = assertOk(parseJournalRecord(delegateNull!.record))
    expect(parsed.kind).toBe("job-spec")
    if (parsed.kind === "job-spec") expect(parsed.model_chain).toEqual([null])
  })

  it("parses attempt reservation, receipt and cancel intent", () => {
    const reservation = assertOk(parseJournalRecord(makeAttemptReservation()))
    expect(reservation.kind).toBe("attempt-reservation")
    if (reservation.kind === "attempt-reservation") {
      expect(reservation.job_id).toBe(FAKE_JOB_ID)
      expect(reservation.attempt_index).toBe(0)
      expect(reservation.model).toBe("opencode/claude-sonnet-5-5")
      expect(reservation.message_id).toBe(FAKE_MESSAGE_ID)
    }

    const receipt = assertOk(parseJournalRecord(makeAttemptReceipt()))
    expect(receipt.kind).toBe("attempt-receipt")
    if (receipt.kind === "attempt-receipt") {
      expect(receipt.session_id).toBe(FAKE_SESSION_ID)
      expect(receipt.message_id).toBe(FAKE_MESSAGE_ID)
    }

    const cancel = assertOk(parseJournalRecord(makeCancelIntent({ reason: "user request" })))
    expect(cancel.kind).toBe("cancel-intent")
    if (cancel.kind === "cancel-intent") expect(cancel.reason).toBe("user request")

    const cancelNoReason = assertOk(parseJournalRecord(makeCancelIntent()))
    expect(cancelNoReason.kind).toBe("cancel-intent")
    if (cancelNoReason.kind === "cancel-intent") expect(cancelNoReason.reason).toBeUndefined()
  })

  it("rejects corrupt records with typed errors", () => {
    const base = makeJobSpec()
    expect(assertError(parseJournalRecord({ ...base, v: 2 })).message).toContain("version")
    expect(assertError(parseJournalRecord({ ...base, kind: "job-spec-v2" })).message).toContain("kind")
    expect(assertError(parseJournalRecord({ ...base, parent_id: undefined })).message.length).toBeGreaterThan(0)
    expect(assertError(parseJournalRecord({ ...base, directory: "" })).message.length).toBeGreaterThan(0)
    expect(assertError(parseJournalRecord({ ...base, role: "oracle" })).message.length).toBeGreaterThan(0)
    expect(assertError(parseJournalRecord({ ...base, model_chain: "not-an-array" })).message.length).toBeGreaterThan(0)

    const receipt = makeAttemptReceipt()
    expect(assertError(parseJournalRecord({ ...receipt, session_id: undefined })).message).toContain("session_id")
    expect(assertError(parseJournalRecord({ ...receipt, message_id: undefined })).message).toContain("message_id")

    const reservation = makeAttemptReservation()
    expect(assertError(parseJournalRecord({ ...reservation, message_id: "not-msg-prefixed" })).message).toContain("message_id")
  })
})

describe("envelope parsing and serialization", () => {
  it("round-trips nonterminal and cancelled envelopes", () => {
    const pending = makeEnvelope("pending", { waited_ms: 1_000 })
    const parsedPending = assertOk(parseOutcomeEnvelope(serializeOutcome({ kind: "nonterminal", envelope: pending })))
    expect(parsedPending.status).toBe("pending")
    if (parsedPending.status === "pending" || parsedPending.status === "unknown" || parsedPending.status === "cancelling") {
      expect(parsedPending.next).toBe("janus_dispatch_wait")
    }
    expect(parsedPending.job_id).toBe(FAKE_JOB_ID)
    expect(parsedPending.role).toBe("consultant-analyst")
    expect(parsedPending.attempt).toEqual({ index: 0, model: "opencode/claude-sonnet-5-5" })
    expect(parsedPending.session_id).toBe(FAKE_SESSION_ID)
    expect(parsedPending.waited_ms).toBe(1_000)

    const cancelled = makeCancelledEnvelope()
    const parsedCancelled = assertOk(parseOutcomeEnvelope(serializeOutcome({ kind: "cancelled", envelope: cancelled })))
    expect(parsedCancelled.status).toBe("cancelled")
    expect(parsedCancelled.job_id).toBe(FAKE_JOB_ID)
  })

  it("round-trips a completed return_handle envelope with text and no next field", () => {
    const completed = makeCompletedEnvelope({ text: "the writer result", session_id: "ses_target", waited_ms: 42 })
    const json = JSON.stringify(completed)
    const parsed = assertOk(parseOutcomeEnvelope(json))
    expect(parsed.status).toBe("completed")
    if (parsed.status !== "completed") throw new Error("expected completed envelope")
    expect(parsed.job_id).toBe(FAKE_JOB_ID)
    expect(parsed.role).toBe("consultant-analyst")
    expect(parsed.attempt).toEqual({ index: 0, model: "opencode/claude-sonnet-5-5" })
    expect(parsed.session_id).toBe("ses_target")
    expect(parsed.waited_ms).toBe(42)
    expect(parsed.text).toBe("the writer result")
    expect("next" in parsed).toBe(false)
    expect("reason" in parsed).toBe(false)
  })

  it("rejects a completed envelope missing text or carrying reason/next fields", () => {
    const missingText = JSON.stringify({ ...makeCompletedEnvelope(), text: undefined })
    expect(assertError(parseOutcomeEnvelope(missingText)).message.length).toBeGreaterThan(0)
    const withNext = JSON.stringify({ ...makeCompletedEnvelope(), next: "janus_dispatch_wait" })
    expect(assertError(parseOutcomeEnvelope(withNext)).message).toContain("next")
    const withReason = JSON.stringify({ ...makeCompletedEnvelope(), reason: "done" })
    expect(assertError(parseOutcomeEnvelope(withReason)).message).toContain("reason")
  })

  it("does not treat plain success text as an envelope", () => {
    const text = serializeOutcome({ kind: "success", text: "the final report" })
    expect(text).toBe("the final report")
    const parsed = parseOutcomeEnvelope(text)
    expect(parsed.ok).toBe(false)
    if (!parsed.ok) expect(parsed.error.message).toContain("JSON")
  })

  it("rejects envelope with an unsupported status", () => {
    const bad = JSON.stringify({ ...makeEnvelope("pending"), status: "paused" })
    expect(assertError(parseOutcomeEnvelope(bad)).message).toContain("status")
  })
})

describe("continuation journal fields", () => {
  it("parses a job spec with session_id and continued_from", () => {
    const parsed = assertOk(parseJournalRecord(makeJobSpec({ session_id: "ses_target", continued_from: "ses_origin" })))
    expect(parsed.kind).toBe("job-spec")
    if (parsed.kind === "job-spec") {
      expect(parsed.session_id).toBe("ses_target")
      expect(parsed.continued_from).toBe("ses_origin")
    }
  })

  it("still parses legacy job specs without the continuation fields", () => {
    for (const { record } of validRoleSpecs) {
      const parsed = assertOk(parseJournalRecord(record))
      expect(parsed.kind).toBe("job-spec")
      if (parsed.kind === "job-spec") {
        expect(parsed.session_id).toBeUndefined()
        expect(parsed.continued_from).toBeUndefined()
      }
    }
  })

  it("rejects an empty session_id in a continuation spec", () => {
    expect(parseJournalRecord({ ...makeJobSpec(), session_id: "" }).ok).toBe(false)
    expect(parseJournalRecord({ ...makeJobSpec(), continued_from: "" }).ok).toBe(false)
  })
})

describe("legacy journal roles", () => {
  it("still parses historical journal records carrying a retired coder-lite role", () => {
    for (const { role, record } of legacyRoleSpecs) {
      const parsed = assertOk(parseJournalRecord(record))
      expect(parsed.kind).toBe("job-spec")
      if (parsed.kind !== "job-spec") continue
      expect(parsed.role).toBe(role)
      expect(parsed.agent_name).toBe(record.agent_name)
      expect(parsed.model_chain).toEqual(record.model_chain)
    }
  })

  it("still parses historical envelopes carrying a retired coder-lite role", () => {
    const legacy = makeEnvelope("pending", { role: "coder-lite" })
    const parsed = assertOk(parseOutcomeEnvelope(serializeOutcome({ kind: "nonterminal", envelope: legacy })))
    expect(parsed.status).toBe("pending")
    if (parsed.status !== "completed") expect(parsed.role).toBe("coder-lite")
  })

  it("rejects unknown legacy role spellings", () => {
    expect(parseJournalRecord({ ...makeJobSpec(), role: "coderlites" }).ok).toBe(false)
  })
})

describe("job spec protocol field", () => {
  it("round-trips an optional protocol on a job spec", () => {
    const parsed = assertOk(parseJournalRecord(makeJobSpec({ protocol: "design_premortem" })))
    expect(parsed.kind).toBe("job-spec")
    if (parsed.kind === "job-spec") expect(parsed.protocol).toBe("design_premortem")
  })

  it("still parses historical job specs without a protocol field", () => {
    for (const { record } of [...validRoleSpecs, ...legacyRoleSpecs]) {
      const parsed = assertOk(parseJournalRecord(record))
      expect(parsed.kind).toBe("job-spec")
      if (parsed.kind === "job-spec") expect(parsed.protocol).toBeUndefined()
    }
  })

  it("rejects an unknown protocol value", () => {
    expect(parseJournalRecord({ ...makeJobSpec(), protocol: "premortem" }).ok).toBe(false)
  })
})

describe("job spec stage field", () => {
  it("round-trips an optional stage on a job spec", () => {
    for (const stage of ["plan", "final"] as const) {
      const parsed = assertOk(parseJournalRecord(makeJobSpec({ protocol: "code_plan_review", stage })))
      expect(parsed.kind).toBe("job-spec")
      if (parsed.kind === "job-spec") expect(parsed.stage).toBe(stage)
    }
  })

  it("still parses historical job specs without a stage field", () => {
    for (const { record } of [...validRoleSpecs, ...legacyRoleSpecs]) {
      const parsed = assertOk(parseJournalRecord(record))
      expect(parsed.kind).toBe("job-spec")
      if (parsed.kind === "job-spec") expect(parsed.stage).toBeUndefined()
    }
  })

  it("rejects an unknown stage value", () => {
    expect(parseJournalRecord({ ...makeJobSpec(), stage: "draft" }).ok).toBe(false)
  })
})

describe("job spec tier field", () => {
  it("round-trips an optional tier on a job spec", () => {
    for (const tier of ["fast", "standard", "deep"] as const) {
      const parsed = assertOk(parseJournalRecord(makeJobSpec({ tier })))
      expect(parsed.kind).toBe("job-spec")
      if (parsed.kind === "job-spec") expect(parsed.tier).toBe(tier)
    }
  })

  it("still parses historical job specs without a tier field", () => {
    for (const { record } of [...validRoleSpecs, ...legacyRoleSpecs]) {
      const parsed = assertOk(parseJournalRecord(record))
      expect(parsed.kind).toBe("job-spec")
      if (parsed.kind === "job-spec") expect(parsed.tier).toBeUndefined()
    }
  })

  it("rejects an unknown tier value", () => {
    expect(parseJournalRecord({ ...makeJobSpec(), tier: "senior" }).ok).toBe(false)
  })

  it("keeps DISPATCH_TIERS in lockstep with the config tier enum", () => {
    expect([...DISPATCH_TIERS]).toEqual([...CONFIG_TIERS])
  })
})

describe("continue args validation", () => {
  it("accepts valid args with an optional role and rejects bad values", () => {
    expect(assertOk(parseContinueArgs({ session_id: FAKE_SESSION_ID, prompt: "apply the fix" })).role).toBeUndefined()
    expect(assertOk(parseContinueArgs({ session_id: FAKE_SESSION_ID, prompt: "apply the fix", role: "author-writer" })).role).toBe("author-writer")
    expect(assertError(parseContinueArgs({ session_id: "", prompt: "x" })).message).toContain("session_id")
    expect(assertError(parseContinueArgs({ session_id: FAKE_SESSION_ID, prompt: "x", role: "oracle" })).message).toContain("role")
    expect(assertError(parseContinueArgs({ session_id: FAKE_SESSION_ID })).message).toContain("prompt")
    expect(assertError(parseContinueArgs({ session_id: FAKE_SESSION_ID, prompt: "x", unexpected: true })).message.length).toBeGreaterThan(0)
  })

  it("accepts an optional reviews_job_ids argument list without validating its contents", () => {
    const args = assertOk(parseContinueArgs({ session_id: FAKE_SESSION_ID, prompt: "apply the fix", reviews_job_ids: ["ses_job_a", "ses_job_b"] }))
    expect(args.reviews_job_ids).toEqual(["ses_job_a", "ses_job_b"])
    expect(assertOk(parseContinueArgs({ session_id: FAKE_SESSION_ID, prompt: "apply the fix" })).reviews_job_ids).toBeUndefined()
  })

  it("rejects a stage argument: continuations inherit the persisted stage, never redeclare it", () => {
    expect(assertError(parseContinueArgs({ session_id: FAKE_SESSION_ID, prompt: "apply the fix", stage: "plan" })).message).toContain("stage")
  })
})

describe("wait args validation", () => {
  it("accepts valid budgets and defaults", () => {
    expect(assertOk(parseWaitArgs({ job_id: FAKE_JOB_ID, wait_ms: 0 })).wait_ms).toBe(0)
    expect(assertOk(parseWaitArgs({ job_id: FAKE_JOB_ID, wait_ms: PRODUCTION_WAIT_BUDGET_MS })).wait_ms).toBe(PRODUCTION_WAIT_BUDGET_MS)
    expect(assertOk(parseWaitArgs({ job_id: FAKE_JOB_ID })).wait_ms).toBe(DEFAULT_WAIT_MS)
  })

  it("rejects invalid wait values and job ids", () => {
    expect(assertError(parseWaitArgs({ job_id: FAKE_JOB_ID, wait_ms: -1 })).message).toContain("wait_ms")
    expect(assertError(parseWaitArgs({ job_id: FAKE_JOB_ID, wait_ms: PRODUCTION_WAIT_BUDGET_MS + 1 })).message).toContain("wait_ms")
    expect(assertError(parseWaitArgs({ job_id: FAKE_JOB_ID, wait_ms: 1.5 })).message).toContain("wait_ms")
    expect(assertError(parseWaitArgs({ job_id: FAKE_JOB_ID, wait_ms: "abc" })).message).toContain("wait_ms")
    expect(assertError(parseWaitArgs({ job_id: "" })).message).toContain("job_id")
    expect(assertError(parseWaitArgs({ job_id: 123 })).message).toContain("job_id")
  })
})

describe("fake SDK boundary", () => {
  it("records all session methods and exposes created sessions", async () => {
    const sdk = createFakeSdk()
    await sdk.session.create({ body: { parentID: FAKE_PARENT_ID, title: "test" }, query: { directory: FAKE_DIRECTORY } })
    await sdk.session.prompt({
      path: { id: FAKE_SESSION_ID },
      body: { agent: "consultation-analyst", parts: [{ type: "text", text: "go" }], noReply: true, messageID: FAKE_MESSAGE_ID },
      query: { directory: FAKE_DIRECTORY },
    })
    await sdk.session.abort({ path: { id: FAKE_SESSION_ID }, query: { directory: FAKE_DIRECTORY } })
    await sdk.session.get({ path: { id: FAKE_JOB_ID }, query: { directory: FAKE_DIRECTORY } })
    await sdk.session.children({ path: { id: FAKE_JOB_ID }, query: { directory: FAKE_DIRECTORY } })
    await sdk.session.messages({ path: { id: FAKE_JOB_ID }, query: { directory: FAKE_DIRECTORY } })

    const names = sdk.calls.map((c) => (c as { method: string }).method)
    expect(names).toEqual(["create", "prompt", "abort", "get", "children", "messages"])

    const created = await sdk.session.create({ body: { parentID: FAKE_PARENT_ID, title: "child" }, query: { directory: FAKE_DIRECTORY } })
    expect(created.data?.id).toMatch(/^ses_/)
    const got = await sdk.session.get({ path: { id: created.data!.id }, query: { directory: FAKE_DIRECTORY } })
    expect(got.data?.id).toBe(created.data!.id)
    const children = await sdk.session.children({ path: { id: FAKE_PARENT_ID }, query: { directory: FAKE_DIRECTORY } })
    expect(children.data?.map((s) => s.id)).toContain(created.data!.id)
  })
})

describe("clock and keyed mutex", () => {
  it("fix-3 removes the caller abort listener when queued acquisition settles normally", async () => {
    // Given a lock held until a second caller queues on a reusable signal.
    const mutex = createKeyedMutex()
    const controller = new AbortController()
    let release = () => {}
    const held = mutex.withLock("job", () => new Promise<void>((resolve) => { release = resolve }))
    await Promise.resolve()
    const queued = mutex.withLock("job", async () => {}, controller.signal)
    // When the queued acquisition finishes normally.
    release()
    await Promise.all([held, queued])
    // Then the signal retains no acquisition callbacks.
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0)
  })
  it("fake clock advances and sleeps are abortable", async () => {
    const clock = createFakeClock(1_000_000)
    expect(clock.now()).toBe(1_000_000)

    const sleepPromise = clock.sleep(10_000)
    clock.advance(5_000)
    clock.advance(5_000)
    await sleepPromise
    expect(clock.now()).toBe(1_010_000)

    const controller = new AbortController()
    const abortedSleep = clock.sleep(10_000, controller.signal)
    controller.abort()
    await expect(abortedSleep).rejects.toThrow()
  })

  it("keyed mutex serializes operations per job id", async () => {
    const mutex = createKeyedMutex()
    const order: string[] = []
    const a = mutex.withLock("job-a", async () => {
      order.push("a-start", "a-end")
      return "a"
    })
    const b = mutex.withLock("job-b", async () => {
      order.push("b-start", "b-end")
      return "b"
    })
    const c = mutex.withLock("job-a", async () => {
      order.push("c-start", "c-end")
      return "c"
    })

    const results = await Promise.all([a, b, c])
    expect(results).toEqual(["a", "b", "c"])
    expect(order.indexOf("a-end")).toBeLessThan(order.indexOf("c-start"))
  })
})

describe("adversarial malformed input", () => {
  it("does not crash or pollute Object.prototype on hostile keys, huge numbers and extra fields", () => {
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false)
    for (const record of adversarialRecords) {
      const result = parseJournalRecord(record)
      expect(result.ok).toBe(false)
      if (!result.ok) expect(result.error).toBeInstanceOf(Error)
    }
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, "polluted")).toBe(false)
  })
})

describe("context watermark envelope field", () => {
  it("accepts context_watermark on every envelope form the dispatch boundary decorates", () => {
    for (const status of ["pending", "unknown", "cancelling"] as const) {
      const json = JSON.stringify({ ...makeEnvelope(status), context_watermark: 260_000 })
      const parsed = assertOk(parseOutcomeEnvelope(json))
      if (parsed.status !== status) throw new Error(`expected ${status} envelope`)
      expect(parsed.context_watermark).toBe(260_000)
    }
    const completed = assertOk(parseOutcomeEnvelope(JSON.stringify({ ...makeCompletedEnvelope(), context_watermark: 300_000 })))
    if (completed.status !== "completed") throw new Error("expected completed envelope")
    expect(completed.context_watermark).toBe(300_000)
  })

  it("keeps the field through a serialize -> parse round trip", () => {
    const envelope = { ...makeEnvelope("pending"), context_watermark: 260_000 }
    const parsed = assertOk(parseOutcomeEnvelope(serializeOutcome({ kind: "nonterminal", envelope })))
    if (parsed.status !== "pending") throw new Error("expected pending envelope")
    expect(parsed.context_watermark).toBe(260_000)
  })

  it("keeps envelopes without the field valid and undecorated", () => {
    const parsed = assertOk(parseOutcomeEnvelope(JSON.stringify(makeEnvelope("pending"))))
    if (parsed.status !== "pending") throw new Error("expected pending envelope")
    expect(parsed.context_watermark).toBeUndefined()
    const completed = assertOk(parseOutcomeEnvelope(JSON.stringify(makeCompletedEnvelope())))
    if (completed.status !== "completed") throw new Error("expected completed envelope")
    expect(completed.context_watermark).toBeUndefined()
  })

  it("rejects invalid watermark values", () => {
    for (const value of [-1, 1.5, "260000", null]) {
      const result = parseOutcomeEnvelope(JSON.stringify({ ...makeEnvelope("pending"), context_watermark: value }))
      expect(result.ok).toBe(false)
    }
  })

  it("does not declare the field on cancelled envelopes", () => {
    // The cancelled form is not part of the decorated set: a watermark key on
    // it stays an unknown key and the strict schema rejects it.
    const result = parseOutcomeEnvelope(JSON.stringify({ ...makeCancelledEnvelope(), context_watermark: 260_000 }))
    expect(result.ok).toBe(false)
  })
})
