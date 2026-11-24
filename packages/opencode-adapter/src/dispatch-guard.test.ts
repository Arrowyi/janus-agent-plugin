import { describe, expect, it } from "bun:test"

import { JanusPluginConfigSchema, MODEL_DEFAULTS, resolveRoleModelChain, type ModelRole } from "./plugin-config.ts"
import { resolveModelFamily, readCallerContextTokens, enforceDispatchReviewGuard, enforceContinueReviewGuard, enforcePermissionReplyGuard, CONTEXT_WATERMARK_TOKENS, CODER_HARD_CEILING_TOKENS, CALLER_CONTEXT_MESSAGES_LIMIT, type PermissionReplyGuardInput } from "./dispatch-guard.ts"
import { FAKE_DIRECTORY, createFakeSdk, makeJobSpec, type FakeSdk } from "./dispatch-test-fixtures.ts"
import { PermissionAskRegistry, resolvePermissionSdk } from "./permission-ask.ts"
import { LEAF_DISPATCH_DENY } from "./agent-registration.ts"
import {
  DISPATCH_MARKER,
  type DispatchPermissionSdk,
  type DispatchSdk,
  type DispatchTier,
  type SdkAssistantMessage,
  type SdkMessageWithParts,
  type SdkPart,
  type SdkSession,
} from "./dispatch-contract.ts"

describe("resolveModelFamily", () => {
  it("maps normalized model keys to their vendor families", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["opencode-go/glm-5.3", "glm"],
      ["glm/glm-5.3-flash", "glm"],
      ["opencode-go/gemini-4-argon", "gemini"],
      ["google/gemini-3.8-flash", "gemini"],
      ["opencode-go/kimi-k3.1-pro", "kimi"],
      ["moonshot/kimi-k2", "kimi"],
      ["opencode/claude-sonnet-5-5", "anthropic"],
      ["opencode-go/claude-haiku-5-5", "anthropic"],
      ["anthropic/claude-opus-5-5", "anthropic"],
      ["openai/gpt-6", "openai"],
      ["openai/o1", "openai"],
      ["openai/o3-mini", "openai"],
      ["openai/o4", "openai"],
      ["deepseek/deepseek-v4-pro", "deepseek"],
      ["opencode-go/grok-4.7", "xai"],
      ["opencode-go/qwen3.8-max", "qwen"],
      ["minimax/minimax-m2", "minimax"],
      ["mimo/mimo-7", "mimo"],
      ["vendor/hy-3", "hunyuan"],
      ["stepfun/step-3", "stepfun"],
    ]
    for (const [model, family] of cases) {
      expect(resolveModelFamily(model)).toBe(family)
    }
  })

  it("returns the normalized key itself for unmatched models so two different unknowns never merge", () => {
    expect(resolveModelFamily("meta/llama-3.3-70b")).toBe("llama3370b")
    expect(resolveModelFamily("mistral/mistral-large")).toBe("mistrallarge")
    expect(resolveModelFamily("meta/llama-3.3-70b")).not.toBe(resolveModelFamily("mistral/mistral-large"))
    // Near-neighbor prefixes stay distinct families rather than collapsing.
    expect(resolveModelFamily("minimax/minimax-m2")).toBe("minimax")
    expect(resolveModelFamily("mimo/mimo-7")).toBe("mimo")
    expect(resolveModelFamily("openai/gpt-6")).toBe("openai")
    expect(resolveModelFamily("opencode-go/grok-4.7")).toBe("xai")
  })
})

describe("single-model chain invariant", () => {
  it("locks the invariant the review guards depend on: every role resolves a one-model chain", () => {
    // The guards compare only model_chain[0] of the reviewed jobs. If
    // resolveRoleModelChain ever grows a second entry, the guards must be
    // extended to validate every chain entry before that ships.
    const config = JanusPluginConfigSchema.parse({})
    const roles = Object.keys(MODEL_DEFAULTS) as ModelRole[]
    expect(roles.length).toBeGreaterThan(0)
    for (const role of roles) {
      expect(resolveRoleModelChain(config, role)).toHaveLength(1)
      expect(resolveRoleModelChain(config, role, { tier: "fast" })).toHaveLength(1)
      expect(resolveRoleModelChain(config, role, { tier: "deep" })).toHaveLength(1)
    }
    // An explicit per-tier override still resolves a single-model chain.
    const routed = JanusPluginConfigSchema.parse({ tier_models: { fast: { coder: "opencode-go/glm-5.3-flash" } } })
    expect(resolveRoleModelChain(routed, "coder", { tier: "fast" })).toHaveLength(1)
  })
})

const CALLER_SESSION = "ses_caller"
const CALLER_DIRECTORY = "/tmp/project"

function assistantWithTokens(tokens: unknown, overrides: Partial<SdkAssistantMessage> = {}): SdkMessageWithParts {
  return {
    info: {
      id: "msg-assistant",
      sessionID: CALLER_SESSION,
      role: "assistant",
      time: { created: 1, completed: 2 },
      parentID: "msg-user",
      modelID: "m",
      providerID: "p",
      finish: "stop",
      ...overrides,
      ...(tokens === undefined ? {} : { tokens }),
    } as SdkAssistantMessage,
    parts: [],
  }
}

function userMessage(): SdkMessageWithParts {
  return {
    info: { role: "user", id: "msg-user", sessionID: CALLER_SESSION },
    parts: [{ type: "text", text: "dispatch please" }],
  }
}

function messagesCall(fake: FakeSdk): { input: { path: { id: string }; query: { directory?: string; limit?: number } } } {
  const call = fake.calls.find((c) => (c as { method: string }).method === "messages")
  if (call === undefined) throw new Error("expected a messages call")
  return call as { input: { path: { id: string }; query: { directory?: string; limit?: number } } }
}

describe("caller context watermark thresholds", () => {
  it("exports the named constants instead of magic numbers", () => {
    expect(CONTEXT_WATERMARK_TOKENS).toBe(250_000)
    expect(CODER_HARD_CEILING_TOKENS).toBe(350_000)
    expect(CALLER_CONTEXT_MESSAGES_LIMIT).toBeGreaterThan(0)
  })
})

describe("readCallerContextTokens", () => {
  it("returns the newest completed non-zero assistant usage, scanning backward", async () => {
    const fake = createFakeSdk()
    fake.seedMessages(CALLER_SESSION, [
      assistantWithTokens({ total: 100 }),
      userMessage(),
      assistantWithTokens({ total: 200 }),
    ])

    const tokens = await readCallerContextTokens(fake as unknown as DispatchSdk, CALLER_SESSION, CALLER_DIRECTORY)

    expect(tokens).toBe(200)
  })

  it("skips uncompleted messages and falls back to the previous completed one", async () => {
    const fake = createFakeSdk()
    fake.seedMessages(CALLER_SESSION, [
      assistantWithTokens({ total: 100 }),
      assistantWithTokens({ total: 999 }, { time: { created: 1 } }),
    ])

    const tokens = await readCallerContextTokens(fake as unknown as DispatchSdk, CALLER_SESSION, CALLER_DIRECTORY)

    expect(tokens).toBe(100)
  })

  it("sums input, output, reasoning and cache when total is missing", async () => {
    const fake = createFakeSdk()
    fake.seedMessages(CALLER_SESSION, [
      assistantWithTokens({ input: 100, output: 20, reasoning: 5, cache: { read: 10, write: 2 } }),
    ])

    const tokens = await readCallerContextTokens(fake as unknown as DispatchSdk, CALLER_SESSION, CALLER_DIRECTORY)

    expect(tokens).toBe(137)
  })

  it("prefers total over the component sum", async () => {
    const fake = createFakeSdk()
    fake.seedMessages(CALLER_SESSION, [
      assistantWithTokens({ total: 42, input: 1_000, output: 5 }),
    ])

    const tokens = await readCallerContextTokens(fake as unknown as DispatchSdk, CALLER_SESSION, CALLER_DIRECTORY)

    expect(tokens).toBe(42)
  })

  it("treats a message with no usage fields as tokenless and keeps searching", async () => {
    const fake = createFakeSdk()
    fake.seedMessages(CALLER_SESSION, [
      assistantWithTokens({ total: 50 }),
      assistantWithTokens(undefined),
      userMessage(),
      assistantWithTokens({}),
    ])

    const tokens = await readCallerContextTokens(fake as unknown as DispatchSdk, CALLER_SESSION, CALLER_DIRECTORY)

    expect(tokens).toBe(50)
  })

  it("treats a zero-usage message as tokenless and keeps searching", async () => {
    const fake = createFakeSdk()
    fake.seedMessages(CALLER_SESSION, [
      assistantWithTokens({ total: 100 }),
      assistantWithTokens({ total: 0 }),
    ])

    const tokens = await readCallerContextTokens(fake as unknown as DispatchSdk, CALLER_SESSION, CALLER_DIRECTORY)

    expect(tokens).toBe(100)
  })

  it("returns undefined when no completed assistant message carries usage", async () => {
    const fake = createFakeSdk()
    fake.seedMessages(CALLER_SESSION, [
      userMessage(),
      assistantWithTokens(undefined),
      assistantWithTokens({ total: 5 }, { time: { created: 1 } }),
    ])

    const tokens = await readCallerContextTokens(fake as unknown as DispatchSdk, CALLER_SESSION, CALLER_DIRECTORY)

    expect(tokens).toBeUndefined()
  })

  it("reads the session tail with the caller directory and the limit parameter", async () => {
    const fake = createFakeSdk()
    fake.seedMessages(CALLER_SESSION, [assistantWithTokens({ total: 100 })])

    await readCallerContextTokens(fake as unknown as DispatchSdk, CALLER_SESSION, CALLER_DIRECTORY)

    const call = messagesCall(fake)
    expect(call.input.path.id).toBe(CALLER_SESSION)
    expect(call.input.query.directory).toBe(CALLER_DIRECTORY)
    expect(call.input.query.limit).toBe(CALLER_CONTEXT_MESSAGES_LIMIT)
  })

  it("returns undefined silently when the messages read errors", async () => {
    const fake = createFakeSdk()
    fake.session.messages = async () => ({ error: { name: "APIError", data: { statusCode: 500 } } })

    const tokens = await readCallerContextTokens(fake as unknown as DispatchSdk, CALLER_SESSION, CALLER_DIRECTORY)

    expect(tokens).toBeUndefined()
  })

  it("returns undefined silently when the messages data is missing", async () => {
    const fake = createFakeSdk()
    fake.session.messages = async () => ({ data: undefined })

    const tokens = await readCallerContextTokens(fake as unknown as DispatchSdk, CALLER_SESSION, CALLER_DIRECTORY)

    expect(tokens).toBeUndefined()
  })

  it("returns undefined silently when the SDK call throws", async () => {
    const fake = createFakeSdk()
    fake.session.messages = async () => {
      throw new Error("transport exploded")
    }

    const tokens = await readCallerContextTokens(fake as unknown as DispatchSdk, CALLER_SESSION, CALLER_DIRECTORY)

    expect(tokens).toBeUndefined()
  })
})

describe("review-seat tier floor", () => {
  const guardConfig = JanusPluginConfigSchema.parse({})
  const reviewerModel = "opencode-go/kimi-k3.1-pro"

  function guardSdk(fake: FakeSdk): DispatchSdk {
    return fake as unknown as DispatchSdk
  }

  async function seedCoderJob(fake: FakeSdk, tier?: DispatchTier): Promise<string> {
    const spec = makeJobSpec({ role: "coder", agent_name: "coder", model_chain: ["opencode-go/glm-5.3"], tier })
    const root = await fake.session.create({
      body: { parentID: spec.parent_id, title: `[consultation-dispatch:v1] ${spec.role}` },
      query: { directory: spec.directory },
    })
    if (root.data === undefined) throw new Error("missing seeded root")
    await fake.session.prompt({
      path: { id: root.data.id },
      body: {
        noReply: true,
        messageID: `msg-spec-${root.data.id}`,
        parts: [{ type: "text", text: JSON.stringify(spec), synthetic: true, ignored: true }],
      },
      query: { directory: spec.directory },
    })
    return root.data.id
  }

  async function dispatchGuard(
    fake: FakeSdk,
    overrides: Partial<Parameters<typeof enforceDispatchReviewGuard>[1]>,
  ) {
    return enforceDispatchReviewGuard(guardSdk(fake), {
      role: "coder-reviewer",
      protocol: undefined,
      stage: undefined,
      reviewsJobIDs: undefined,
      reviewerModel,
      config: guardConfig,
      directory: FAKE_DIRECTORY,
      ...overrides,
    })
  }

  async function continueGuard(
    fake: FakeSdk,
    overrides: Partial<Parameters<typeof enforceContinueReviewGuard>[1]>,
  ) {
    return enforceContinueReviewGuard(guardSdk(fake), {
      targetRole: "coder-reviewer",
      targetProtocol: undefined,
      targetModel: reviewerModel,
      reviewsJobIDs: undefined,
      config: guardConfig,
      directory: FAKE_DIRECTORY,
      ...overrides,
    })
  }

  it("rejects a fast reviewer against a standard coder job with re-dispatch guidance", async () => {
    const fake = createFakeSdk()
    const jobID = await seedCoderJob(fake, "standard")

    const outcome = await dispatchGuard(fake, { reviewsJobIDs: [jobID], reviewerTier: "fast" })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.message).toContain("tier floor")
      expect(outcome.message).toContain(jobID)
      expect(outcome.message).toContain('tier: "standard"')
    }
  })

  it("rejects a fast reviewer against a deep coder job", async () => {
    const fake = createFakeSdk()
    const jobID = await seedCoderJob(fake, "deep")

    const outcome = await dispatchGuard(fake, { reviewsJobIDs: [jobID], reviewerTier: "fast" })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain('"deep"')
  })

  it("passes a fast reviewer against a fast coder job", async () => {
    const fake = createFakeSdk()
    const jobID = await seedCoderJob(fake, "fast")

    const outcome = await dispatchGuard(fake, { reviewsJobIDs: [jobID], reviewerTier: "fast" })

    expect(outcome).toEqual({ ok: true })
  })

  it("passes a standard reviewer against a standard coder job", async () => {
    const fake = createFakeSdk()
    const jobID = await seedCoderJob(fake, "standard")

    const outcome = await dispatchGuard(fake, { reviewsJobIDs: [jobID], reviewerTier: "standard" })

    expect(outcome).toEqual({ ok: true })
  })

  it("passes an unspecified reviewer tier against a standard coder job (default senior seat)", async () => {
    const fake = createFakeSdk()
    const jobID = await seedCoderJob(fake, "standard")

    const outcome = await dispatchGuard(fake, { reviewsJobIDs: [jobID] })

    expect(outcome).toEqual({ ok: true })
  })

  it("passes a fast reviewer against a default-seat job with no recorded tier", async () => {
    const fake = createFakeSdk()
    const jobID = await seedCoderJob(fake)

    const outcome = await dispatchGuard(fake, { reviewsJobIDs: [jobID], reviewerTier: "fast" })

    expect(outcome).toEqual({ ok: true })
  })

  it("rejects mixed-tier ids when any listed job is stronger than the fast reviewer, regardless of order", async () => {
    for (const order of ["fast-first", "standard-first"] as const) {
      const fake = createFakeSdk()
      const fastJob = await seedCoderJob(fake, "fast")
      const standardJob = await seedCoderJob(fake, "standard")
      const ids = order === "fast-first" ? [fastJob, standardJob] : [standardJob, fastJob]

      const outcome = await dispatchGuard(fake, { reviewsJobIDs: ids, reviewerTier: "fast" })

      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.message).toContain("tier floor")
    }

    const allFast = createFakeSdk()
    const first = await seedCoderJob(allFast, "fast")
    const second = await seedCoderJob(allFast, "fast")
    expect(await dispatchGuard(allFast, { reviewsJobIDs: [first, second], reviewerTier: "fast" })).toEqual({ ok: true })
  })

  it("applies the same floor to a solution-reviewer stage final dispatch", async () => {
    const fake = createFakeSdk()
    const jobID = await seedCoderJob(fake, "standard")

    const outcome = await dispatchGuard(fake, {
      role: "solution-reviewer",
      protocol: "code_plan_review",
      stage: "final",
      reviewsJobIDs: [jobID],
      reviewerModel: "opencode/claude-sonnet-5-5",
      reviewerTier: "fast",
    })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain("tier floor")
  })

  it("leaves stage plan and design_premortem solution-reviewer dispatches ungated by the floor", async () => {
    const planFake = createFakeSdk()
    const plan = await dispatchGuard(planFake, {
      role: "solution-reviewer",
      protocol: "code_plan_review",
      stage: "plan",
      reviewerModel: "opencode/claude-sonnet-5-5",
      reviewerTier: "fast",
    })
    expect(plan).toEqual({ ok: true })

    const premortemFake = createFakeSdk()
    const premortem = await dispatchGuard(premortemFake, {
      role: "solution-reviewer",
      protocol: "design_premortem",
      reviewerModel: "opencode/claude-sonnet-5-5",
      reviewerTier: "fast",
    })
    expect(premortem).toEqual({ ok: true })
  })

  it("rejects a fast continuation against a standard coder job and points at a fresh dispatch", async () => {
    const fake = createFakeSdk()
    const jobID = await seedCoderJob(fake, "standard")

    const outcome = await continueGuard(fake, { reviewsJobIDs: [jobID], targetTier: "fast" })

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.message).toContain("tier floor")
      expect(outcome.message).toContain("start a fresh review dispatch")
    }
  })

  it("passes a standard continuation against a standard coder job", async () => {
    const fake = createFakeSdk()
    const jobID = await seedCoderJob(fake, "standard")

    const outcome = await continueGuard(fake, { reviewsJobIDs: [jobID], targetTier: "standard" })

    expect(outcome).toEqual({ ok: true })
  })

  it("passes a continuation with no pinned tier against a standard coder job", async () => {
    const fake = createFakeSdk()
    const jobID = await seedCoderJob(fake, "standard")

    const outcome = await continueGuard(fake, { reviewsJobIDs: [jobID] })

    expect(outcome).toEqual({ ok: true })
  })
})

describe("author-reviewer guard", () => {
  const guardConfig = JanusPluginConfigSchema.parse({})
  const reviewerModel = "opencode-go/kimi-k3.1-pro"

  async function seedJob(fake: FakeSdk, role: "author-writer" | "coder", model: string, tier?: DispatchTier): Promise<string> {
    const spec = makeJobSpec({ role, agent_name: role, model_chain: [model], tier })
    const root = await fake.session.create({
      body: { parentID: spec.parent_id, title: `[consultation-dispatch:v1] ${spec.role}` },
      query: { directory: spec.directory },
    })
    if (root.data === undefined) throw new Error("missing seeded root")
    await fake.session.prompt({
      path: { id: root.data.id },
      body: {
        noReply: true,
        messageID: `msg-spec-${root.data.id}`,
        parts: [{ type: "text", text: JSON.stringify(spec), synthetic: true, ignored: true }],
      },
      query: { directory: spec.directory },
    })
    return root.data.id
  }

  function writerJob(fake: FakeSdk, tier?: DispatchTier): Promise<string> {
    return seedJob(fake, "author-writer", "opencode/claude-sonnet-5-5", tier)
  }

  function dispatchGuard(fake: FakeSdk, overrides: Partial<Parameters<typeof enforceDispatchReviewGuard>[1]>) {
    return enforceDispatchReviewGuard(fake as unknown as DispatchSdk, {
      role: "author-reviewer",
      protocol: undefined,
      stage: "final",
      reviewsJobIDs: undefined,
      reviewerModel,
      config: guardConfig,
      directory: FAKE_DIRECTORY,
      ...overrides,
    })
  }

  function continueGuard(fake: FakeSdk, overrides: Partial<Parameters<typeof enforceContinueReviewGuard>[1]>) {
    return enforceContinueReviewGuard(fake as unknown as DispatchSdk, {
      targetRole: "author-reviewer",
      targetProtocol: undefined,
      targetModel: reviewerModel,
      targetStage: "final",
      reviewsJobIDs: undefined,
      config: guardConfig,
      directory: FAKE_DIRECTORY,
      ...overrides,
    })
  }

  it("requires one of the four documentation stages", async () => {
    const fake = createFakeSdk()
    const jobID = await writerJob(fake)
    for (const stage of [undefined, "plan"] as const) {
      const outcome = await dispatchGuard(fake, { stage, reviewsJobIDs: [jobID] })
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.message).toContain("author-reviewer requires stage")
    }
    for (const stage of ["outline", "unit", "reader", "final"] as const) {
      expect(await dispatchGuard(fake, { stage, reviewsJobIDs: [jobID] })).toEqual({ ok: true })
    }
  })

  it("requires reviews_job_ids that name author-writer root jobs", async () => {
    const fake = createFakeSdk()
    const missing = await dispatchGuard(fake, {})
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.message).toContain("author-reviewer requires reviews_job_ids")

    const coderJob = await seedJob(fake, "coder", "opencode-go/glm-5.3")
    const wrongRole = await dispatchGuard(fake, { reviewsJobIDs: [coderJob] })
    expect(wrongRole.ok).toBe(false)
    if (!wrongRole.ok) expect(wrongRole.message).toContain("author-writer unit jobs")
  })

  it("rejects a reviewer in the same model family as the writer and cites config keys", async () => {
    const fake = createFakeSdk()
    const jobID = await writerJob(fake)
    const outcome = await dispatchGuard(fake, { reviewsJobIDs: [jobID], reviewerModel: "opencode-go/claude-haiku-5-5" })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.message).toContain("model conflict")
      expect(outcome.message).toContain("author_reviewer_model or tier_models")
      expect(outcome.message).toContain("author_writer_model or tier_models")
    }
  })

  it("rejects a fast reviewer against a standard writer job except at the reader stage", async () => {
    const fake = createFakeSdk()
    const jobID = await writerJob(fake, "standard")
    for (const stage of ["outline", "unit", "final"] as const) {
      const outcome = await dispatchGuard(fake, { stage, reviewsJobIDs: [jobID], reviewerTier: "fast" })
      expect(outcome.ok).toBe(false)
      if (!outcome.ok) expect(outcome.message).toContain("tier floor")
    }
    expect(await dispatchGuard(fake, { stage: "reader", reviewsJobIDs: [jobID], reviewerTier: "fast" })).toEqual({ ok: true })
    const fastWriter = await writerJob(fake, "fast")
    expect(await dispatchGuard(fake, { reviewsJobIDs: [fastWriter], reviewerTier: "fast" })).toEqual({ ok: true })
  })

  it("rejects a protocol on an author-reviewer dispatch", async () => {
    const fake = createFakeSdk()
    const jobID = await writerJob(fake)
    const outcome = await dispatchGuard(fake, { protocol: "counter_evidence", reviewsJobIDs: [jobID] })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain("takes no protocol")
  })

  it("rejects a documentation stage on a solution-reviewer dispatch", async () => {
    const fake = createFakeSdk()
    const outcome = await dispatchGuard(fake, { role: "solution-reviewer", protocol: "code_plan_review", stage: "unit" })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain("solution-reviewer stage must be one of: plan, final")
  })

  it("re-checks a continuation against the listed writer jobs with the pinned stage and tier", async () => {
    const fake = createFakeSdk()
    const jobID = await writerJob(fake, "standard")
    const missing = await continueGuard(fake, {})
    expect(missing.ok).toBe(false)
    expect(await continueGuard(fake, { reviewsJobIDs: [jobID] })).toEqual({ ok: true })
    const undercut = await continueGuard(fake, { reviewsJobIDs: [jobID], targetTier: "fast" })
    expect(undercut.ok).toBe(false)
    if (!undercut.ok) expect(undercut.message).toContain("cannot raise the session's pinned tier")
    expect(await continueGuard(fake, { reviewsJobIDs: [jobID], targetTier: "fast", targetStage: "reader" })).toEqual({ ok: true })
    const noStage = await continueGuard(fake, { reviewsJobIDs: [jobID], targetStage: undefined })
    expect(noStage.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// janus_permission_reply guard (Gates 1–4)
// ---------------------------------------------------------------------------

const TARGET_SESSION = "ses_target"

function makeSession(id: string, parentID: string | undefined, title: string, directory = CALLER_DIRECTORY): SdkSession {
  return { id, ...(parentID !== undefined ? { parentID } : {}), directory, title, time: { created: 0, updated: 0 } }
}

function humanMessage(id: string, sessionID = CALLER_SESSION, text = "please allow"): SdkMessageWithParts {
  return { info: { role: "user", id, sessionID }, parts: [{ type: "text", text }] }
}

interface GuardOpts {
  readonly caller?: string
  readonly target?: string
  readonly requestID?: string
  readonly now?: number
  readonly reply?: "once" | "always" | "reject"
}

function guardInput(fake: FakeSdk, registry: PermissionAskRegistry, opts: GuardOpts = {}): PermissionReplyGuardInput {
  return {
    sessionID: opts.caller ?? CALLER_SESSION,
    directory: FAKE_DIRECTORY,
    args: { sessionID: opts.target ?? TARGET_SESSION, requestID: opts.requestID ?? "req-1", reply: opts.reply ?? "once" },
    askRegistry: registry,
    permissionSdk: resolvePermissionSdk(fake),
    now: opts.now ?? 0,
  }
}

function replyCalls(fake: FakeSdk): number {
  return (fake.permission?.calls ?? []).filter((call) => call.method === "reply").length
}

function totalPermissionCalls(fake: FakeSdk): number {
  // The fake shares one call array across session and permission surfaces;
  // count only the permission surface methods.
  return (fake.permission?.calls ?? []).filter(
    (call) => call.method === "list" || call.method === "listForSession" || call.method === "reply",
  ).length
}

function happyFake(callerMessages: ReadonlyArray<SdkMessageWithParts> = []): FakeSdk {
  return createFakeSdk({
    seedPermission: true,
    sessions: [makeSession(CALLER_SESSION, undefined, "human"), makeSession(TARGET_SESSION, CALLER_SESSION, "job")],
    messages: { [CALLER_SESSION]: [...callerMessages] },
  })
}

function seedSurfaced(
  fake: FakeSdk,
  registry: PermissionAskRegistry,
  watermark: string | undefined,
  now = 0,
  surfacedTo = CALLER_SESSION,
): void {
  const ask = { id: "req-1", sessionID: TARGET_SESSION, permission: "bash", patterns: ["ls"] }
  fake.permission!.seedAsks([ask])
  fake.v2!.session.permission.seedAsks([ask])
  registry.onAsked(
    { requestID: "req-1", sessionID: TARGET_SESSION, directory: FAKE_DIRECTORY, permission: "bash", patterns: ["ls"] },
    now,
  )
  registry.markSurfaced("req-1", { callerSessionID: surfacedTo, surfacedAtUserMessageID: watermark, surfacedAt: now })
}

describe("janus_permission_reply three-way resolution", () => {
  it("rejects a valid descendant args whose requestID belongs to a foreign session", async () => {
    const fake = createFakeSdk({
      seedPermission: true,
      sessions: [makeSession(CALLER_SESSION, undefined, "human"), makeSession(TARGET_SESSION, CALLER_SESSION, "job")],
    })
    fake.permission!.seedAsks([{ id: "req-1", sessionID: "ses_foreign", permission: "bash", patterns: ["ls"] }])
    const registry = new PermissionAskRegistry()

    const outcome = await enforcePermissionReplyGuard(fake as unknown as DispatchSdk, guardInput(fake, registry))

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) {
      expect(outcome.message).toBe("Error: permission request req-1 belongs to session ses_foreign, not ses_target")
    }
  })

  it("returns already-resolved with zero reply calls only on a successful pull", async () => {
    const fake = happyFake()
    fake.permission!.seedAsks([])
    fake.v2!.session.permission.seedAsks([])
    const registry = new PermissionAskRegistry()
    registry.onAsked(
      { requestID: "req-1", sessionID: TARGET_SESSION, directory: FAKE_DIRECTORY, permission: "bash", patterns: ["ls"] },
      1000,
    )

    const outcome = await enforcePermissionReplyGuard(fake as unknown as DispatchSdk, guardInput(fake, registry, { now: 2000 }))

    expect(outcome).toEqual({
      ok: true,
      action: "already-resolved",
      message: "Permission request req-1 on session ses_target was already resolved (no longer pending).",
    })
    expect(replyCalls(fake)).toBe(0)
  })

  it("fails closed on a dual pull outage and never claims already-resolved, pinning the grace boundary on both sides", async () => {
    const fake = happyFake([humanMessage("msg-h1")])
    fake.permission!.setListResult({ error: "down" })
    fake.v2!.session.permission.setListResult({ error: "down" })
    const registry = new PermissionAskRegistry()
    seedSurfaced(fake, registry, undefined, 1000)

    // now - lastSeenAt === 60_000 → proceed on the registry record (all later gates pass)
    const within = await enforcePermissionReplyGuard(fake as unknown as DispatchSdk, guardInput(fake, registry, { now: 61_000 }))
    expect(within).toEqual({ ok: true, action: "reply" })

    // now - lastSeenAt === 60_001 → fail closed, never "already resolved"
    const beyond = await enforcePermissionReplyGuard(fake as unknown as DispatchSdk, guardInput(fake, registry, { now: 61_001 }))
    expect(beyond.ok).toBe(false)
    if (!beyond.ok) {
      expect(beyond.message).toContain("could not verify permission request")
      expect(beyond.message).not.toContain("already resolved")
    }
    expect(replyCalls(fake)).toBe(0)
  })

  it("fails closed on an outage when the registry record was already replied", async () => {
    const fake = happyFake([humanMessage("msg-h1")])
    fake.permission!.setListResult({ error: "down" })
    fake.v2!.session.permission.setListResult({ error: "down" })
    const registry = new PermissionAskRegistry()
    seedSurfaced(fake, registry, undefined, 1000)
    registry.onReplied("req-1", 1050)

    const outcome = await enforcePermissionReplyGuard(fake as unknown as DispatchSdk, guardInput(fake, registry, { now: 61_000 }))

    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain("could not verify permission request")
  })
})

describe("janus_permission_reply watermark gate", () => {
  it("permits the reply only after a newer real human message", async () => {
    const fake = happyFake([humanMessage("msg-h1")])
    const registry = new PermissionAskRegistry()
    seedSurfaced(fake, registry, "msg-h1")

    const blocked = await enforcePermissionReplyGuard(fake as unknown as DispatchSdk, guardInput(fake, registry))
    expect(blocked.ok).toBe(false)
    if (!blocked.ok) expect(blocked.message).toContain("no new human message")

    fake.seedMessages(CALLER_SESSION, [humanMessage("msg-h2")])
    expect(await enforcePermissionReplyGuard(fake as unknown as DispatchSdk, guardInput(fake, registry))).toEqual({
      ok: true,
      action: "reply",
    })
  })

  it("does not advance past synthetic, compaction, subtask, or plugin-injected messages", async () => {
    const fake = happyFake([humanMessage("msg-h1")])
    const registry = new PermissionAskRegistry()
    seedSurfaced(fake, registry, "msg-h1")
    registry.pluginInjectedMessageIDs.add("msg-injected")
    fake.seedMessages(CALLER_SESSION, [
      { info: { role: "user", id: "msg-injected", sessionID: CALLER_SESSION }, parts: [{ type: "text", text: "x" }] },
      { info: { role: "user", id: "msg-synth", sessionID: CALLER_SESSION }, parts: [{ type: "text", text: "x", synthetic: true }] },
      { info: { role: "user", id: "msg-comp", sessionID: CALLER_SESSION }, parts: [{ type: "compaction" } as unknown as SdkPart] },
      { info: { role: "user", id: "msg-sub", sessionID: CALLER_SESSION }, parts: [{ type: "subtask" } as unknown as SdkPart] },
    ])

    const outcome = await enforcePermissionReplyGuard(fake as unknown as DispatchSdk, guardInput(fake, registry))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain("no new human message")
  })

  it("advances on a human message with a synthetic @file part plus real text", async () => {
    const fake = happyFake([humanMessage("msg-h1")])
    const registry = new PermissionAskRegistry()
    seedSurfaced(fake, registry, "msg-h1")
    fake.seedMessages(CALLER_SESSION, [
      {
        info: { role: "user", id: "msg-h2", sessionID: CALLER_SESSION },
        parts: [{ type: "text", text: "@file src/x.ts", synthetic: true }, { type: "text", text: "allow it" }],
      },
    ])

    expect(await enforcePermissionReplyGuard(fake as unknown as DispatchSdk, guardInput(fake, registry))).toEqual({
      ok: true,
      action: "reply",
    })
  })

  it("fails closed when the request was never surfaced to this caller", async () => {
    const fake = happyFake([humanMessage("msg-h1")])
    const registry = new PermissionAskRegistry()
    const ask = { id: "req-1", sessionID: TARGET_SESSION, permission: "bash", patterns: ["ls"] }
    fake.permission!.seedAsks([ask])
    registry.onAsked(
      { requestID: "req-1", sessionID: TARGET_SESSION, directory: FAKE_DIRECTORY, permission: "bash", patterns: ["ls"] },
      0,
    )

    const outcome = await enforcePermissionReplyGuard(fake as unknown as DispatchSdk, guardInput(fake, registry))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain("was not surfaced to this caller")
  })

  it("fails closed when the request was surfaced to a different caller", async () => {
    const fake = happyFake([humanMessage("msg-h1")])
    const registry = new PermissionAskRegistry()
    seedSurfaced(fake, registry, "msg-h1", 0, "ses_other_caller")

    const outcome = await enforcePermissionReplyGuard(fake as unknown as DispatchSdk, guardInput(fake, registry))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain("was not surfaced to this caller")
  })

  it("fails closed when the caller conversation cannot be read", async () => {
    const fake = happyFake([humanMessage("msg-h1")])
    const registry = new PermissionAskRegistry()
    seedSurfaced(fake, registry, undefined)
    const base = fake as unknown as DispatchSdk
    const sdk = {
      session: { ...base.session, messages: async () => ({ error: "boom" }) },
    } as unknown as DispatchSdk

    const outcome = await enforcePermissionReplyGuard(sdk, {
      sessionID: CALLER_SESSION,
      directory: FAKE_DIRECTORY,
      args: { sessionID: TARGET_SESSION, requestID: "req-1", reply: "once" },
      askRegistry: registry,
      permissionSdk: resolvePermissionSdk(fake),
      now: 0,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain("failed to read the caller conversation")
  })
})

describe("janus_permission_reply Gate 3 lineage", () => {
  it("fails closed past MAX_LINEAGE_DEPTH", async () => {
    const sessions = [makeSession(CALLER_SESSION, undefined, "human")]
    let parent = CALLER_SESSION
    for (let i = 1; i <= 10; i++) {
      const id = `ses_hop${i}`
      sessions.push(makeSession(id, parent, "hop"))
      parent = id
    }
    sessions.push(makeSession(TARGET_SESSION, parent, "target"))
    const fake = createFakeSdk({ seedPermission: true, sessions })
    fake.permission!.seedAsks([{ id: "req-1", sessionID: TARGET_SESSION, permission: "bash", patterns: ["ls"] }])
    const registry = new PermissionAskRegistry()

    const outcome = await enforcePermissionReplyGuard(fake as unknown as DispatchSdk, guardInput(fake, registry))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain("lineage exceeds 10 hops")
  })

  it("rejects a cross-workspace ancestor", async () => {
    const fake = createFakeSdk({
      seedPermission: true,
      sessions: [
        makeSession(CALLER_SESSION, undefined, "human"),
        makeSession("ses_foreign", undefined, "foreign", "/tmp/other-workspace"),
        makeSession(TARGET_SESSION, "ses_foreign", "job"),
      ],
    })
    fake.permission!.seedAsks([{ id: "req-1", sessionID: TARGET_SESSION, permission: "bash", patterns: ["ls"] }])
    const registry = new PermissionAskRegistry()

    const outcome = await enforcePermissionReplyGuard(fake as unknown as DispatchSdk, guardInput(fake, registry))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain("outside the caller workspace")
  })

  it("fails closed when a lineage hop cannot be read", async () => {
    const fake = createFakeSdk({
      seedPermission: true,
      sessions: [makeSession(CALLER_SESSION, undefined, "human"), makeSession(TARGET_SESSION, "ses_bad", "job")],
    })
    fake.permission!.seedAsks([{ id: "req-1", sessionID: TARGET_SESSION, permission: "bash", patterns: ["ls"] }])
    const base = fake as unknown as DispatchSdk
    const sdk = {
      session: {
        ...base.session,
        async get(input: { path: { id: string } }) {
          if (input.path.id === "ses_bad") throw new Error("transport")
          return base.session.get(input)
        },
      },
    } as unknown as DispatchSdk
    const registry = new PermissionAskRegistry()

    const outcome = await enforcePermissionReplyGuard(sdk, {
      sessionID: CALLER_SESSION,
      directory: FAKE_DIRECTORY,
      args: { sessionID: TARGET_SESSION, requestID: "req-1", reply: "once" },
      askRegistry: registry,
      permissionSdk: resolvePermissionSdk(fake),
      now: 0,
    })
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain("could not read the session lineage")
  })
})

describe("janus_permission_reply QS2 zero reply calls", () => {
  const dispatchedMessage =
    "Error: dispatched sub-session cannot call janus_permission_reply; surface pending_asks to the top-level user-facing caller"

  it("rejects a caller in the seeded dispatched set before any permission call", async () => {
    const fake = createFakeSdk({
      seedPermission: true,
      sessions: [makeSession(CALLER_SESSION, undefined, "human"), makeSession(TARGET_SESSION, CALLER_SESSION, "job")],
    })
    const registry = new PermissionAskRegistry()
    registry.dispatchedSessionIDs.add(CALLER_SESSION)

    const outcome = await enforcePermissionReplyGuard(fake as unknown as DispatchSdk, guardInput(fake, registry))
    expect(outcome).toEqual({ ok: false, message: dispatchedMessage })
    expect(totalPermissionCalls(fake)).toBe(0)
  })

  it("rejects a DISPATCH_MARKER caller title before any permission call", async () => {
    const marker = makeSession(CALLER_SESSION, undefined, `${DISPATCH_MARKER}coder`)
    const fake = createFakeSdk({ seedPermission: true, sessions: [marker, makeSession(TARGET_SESSION, CALLER_SESSION, "job")] })
    const registry = new PermissionAskRegistry()

    const outcome = await enforcePermissionReplyGuard(fake as unknown as DispatchSdk, guardInput(fake, registry))
    expect(outcome).toEqual({ ok: false, message: dispatchedMessage })
    expect(totalPermissionCalls(fake)).toBe(0)
  })

  it("rejects a caller with a defined parentID before any permission call", async () => {
    const fake = createFakeSdk({
      seedPermission: true,
      sessions: [
        makeSession("ses_grand", undefined, "human"),
        makeSession(CALLER_SESSION, "ses_grand", "sub"),
        makeSession(TARGET_SESSION, CALLER_SESSION, "job"),
      ],
    })
    const registry = new PermissionAskRegistry()

    const outcome = await enforcePermissionReplyGuard(fake as unknown as DispatchSdk, guardInput(fake, registry))
    expect(outcome).toEqual({ ok: false, message: dispatchedMessage })
    expect(totalPermissionCalls(fake)).toBe(0)
  })

  it("rejects a lineage mismatch with zero reply calls", async () => {
    const fake = createFakeSdk({
      seedPermission: true,
      sessions: [
        makeSession(CALLER_SESSION, undefined, "human"),
        makeSession("ses_other_parent", undefined, "other"),
        makeSession(TARGET_SESSION, "ses_other_parent", "job"),
      ],
    })
    fake.permission!.seedAsks([{ id: "req-1", sessionID: TARGET_SESSION, permission: "bash", patterns: ["ls"] }])
    const registry = new PermissionAskRegistry()

    const outcome = await enforcePermissionReplyGuard(fake as unknown as DispatchSdk, guardInput(fake, registry))
    expect(outcome.ok).toBe(false)
    if (!outcome.ok) expect(outcome.message).toContain("is not a descendant of the caller session")
    expect(replyCalls(fake)).toBe(0)
  })

  it("pins the seventh leaf-deny key that keeps a dispatched leaf from ever reaching the guard", () => {
    expect(LEAF_DISPATCH_DENY.janus_permission_reply).toBe("deny")
  })
})
