import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { setImmediate } from "node:timers/promises"
import type { PluginInput, ToolContext } from "@opencode-ai/plugin"

import { createJanusDispatchTool, createJanusDispatchTools, resolveRoleTarget, splitModel } from "./dispatch-tool.ts"
import { appendRecord, createAttemptSession, createJob } from "./dispatch-journal.ts"
import { JanusPluginConfigSchema, type JanusPluginConfig } from "./plugin-config.ts"
import { CODER_HARD_CEILING_TOKENS, CONTEXT_WATERMARK_TOKENS } from "./dispatch-guard.ts"
import { createFakeClock, createFakeSdk, legacyRoleSpecs, makeCancelledEnvelope, makeCompletedEnvelope, makeEnvelope, makeJobSpec, type FakeSdk } from "./dispatch-test-fixtures.ts"
import { createKeyedMutex, parseOutcomeEnvelope, PRODUCTION_WAIT_BUDGET_MS, type DispatchEnvelope, type JobSpec, type KeyedMutex, type SdkAssistantMessage, type SdkMessageWithParts, type SdkTokenUsage, type SdkTextPart } from "./dispatch-contract.ts"
import type { DispatchLifecycle, LaunchInput } from "./dispatch-lifecycle.ts"

function config(overrides: Partial<JanusPluginConfig> = {}): JanusPluginConfig {
  return JanusPluginConfigSchema.parse(overrides)
}

function fakeContext(overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionID: "ses_parent",
    messageID: "msg_parent",
    agent: "consultant",
    directory: "/tmp/project",
    worktree: "/tmp/project",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
    ...overrides,
  }
}

function textPart(text: string): SdkTextPart {
  return { type: "text", text }
}

function completedAssistantMessage(requestMessageID: string, text: string, overrides: Partial<SdkAssistantMessage> = {}): SdkMessageWithParts {
  return {
    info: {
      id: "msg-reply",
      sessionID: "ignored",
      role: "assistant",
      parentID: requestMessageID,
      time: { created: 0, completed: 0 },
      modelID: "m",
      providerID: "p",
      finish: "stop",
      ...overrides,
    } as SdkAssistantMessage,
    parts: [textPart(text)],
  }
}

function promptAsyncCount(fake: FakeSdk): number {
  return fake.calls.filter((c) => (c as { method: string }).method === "promptAsync").length
}

function abortCount(fake: FakeSdk): number {
  return fake.calls.filter((c) => (c as { method: string }).method === "abort").length
}

function lastPromptAsyncCall(fake: FakeSdk): { input: { path: { id: string }; body: { agent?: string; model?: { providerID: string; modelID: string }; parts: SdkTextPart[]; messageID?: string } } } {
  const calls = fake.calls.filter((c) => (c as { method: string }).method === "promptAsync")
  return calls[calls.length - 1] as { input: { path: { id: string }; body: { agent?: string; model?: { providerID: string; modelID: string }; parts: SdkTextPart[]; messageID?: string } } }
}

function createRespondingFake(responseText: string, clock = createFakeClock()): FakeSdk {
  const fake = createFakeSdk()
  const base = fake.session.promptAsync.bind(fake.session)
    fake.session.promptAsync = async (input) => {
      const result = await base(input)
      const requestMessageID = input.body.messageID!
      const sessionID = input.path.id
      fake.seedMessages(sessionID, [
        completedAssistantMessage(requestMessageID, responseText, { sessionID, id: `msg-reply-${sessionID}` }),
      ])
      return result
    }
  return fake
}

function outputText(result: unknown): string {
  if (typeof result === "string") return result
  if (typeof result === "object" && result !== null && "output" in result) {
    const output = (result as { output: unknown }).output
    if (typeof output === "string") return output
  }
  throw new Error(`unexpected tool result: ${JSON.stringify(result)}`)
}

/** Advance the fake clock until the observed promise settles so a pending
 * observation expires deterministically instead of sleeping forever. Each
 * step yields a real macrotask so the observation chain keeps pace with the
 * clock — a bare `await Promise.resolve()` starves the chain and can leave
 * the observation a few cycles short when the loop ends, hanging the awaited
 * promise forever because nothing advances the clock again. The settle-driven
 * condition plus the bounded cap turns a stalled chain into a visible hang
 * instead of a margin-guessing flake. */
async function exhaustBudget(clock: ReturnType<typeof createFakeClock>, observed: Promise<unknown>): Promise<void> {
  let settled = false
  const mark = (): void => {
    settled = true
  }
  void observed.then(mark, mark)
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  const maxSteps = Math.ceil(PRODUCTION_WAIT_BUDGET_MS / 2_000) * 4
  for (let i = 0; i < maxSteps && !settled; i++) {
    await setImmediate()
    clock.advance(2_000)
  }
}

describe("resolveRoleTarget", () => {
  it("maps every role to its agent and default model", () => {
    const expected = {
      "common-explorer": { agentName: "common-explorer", model: "opencode-go/deepseek-v4.1-flash" },
      "consultant-analyst": { agentName: "consultant-analyst", model: "opencode-go/kimi-k3.1-pro" },
      "consultant-critic": { agentName: "consultant-critic", model: "opencode/claude-sonnet-5-5" },
      "coder-reviewer": { agentName: "coder-reviewer", model: "opencode-go/kimi-k3.1-pro" },
      "consultant-auditor": { agentName: "consultant-auditor", model: "opencode-go/grok-4.7" },
      "author-writer": { agentName: "author-writer", model: "opencode/claude-sonnet-5-5" },
      "author-reviewer": { agentName: "author-reviewer", model: "opencode-go/kimi-k3.1-pro" },
      coder: { agentName: "coder", model: "opencode-go/glm-5.3" },
      simple: { agentName: "simple", model: "opencode-go/deepseek-v4.1-flash" },
      "tech-lead": { agentName: "tech-lead", model: "opencode-go/glm-5.3" },
      "solution-reviewer": { agentName: "solution-reviewer", model: "opencode/claude-sonnet-5-5" },
      consultant: { agentName: "consultant", model: "opencode-go/gemini-4-argon" },
      author: { agentName: "author", model: "opencode-go/gemini-4-argon" },
    } as const
    for (const [role, target] of Object.entries(expected)) {
      expect(resolveRoleTarget(config(), role as keyof typeof expected)).toEqual(target)
    }
  })

  it("applies scalar overrides, aliases, delegate routing, and mode/tier precedence", () => {
    expect(resolveRoleTarget(config({ consultant_analyst_model: "test/analyst" }), "consultant-analyst")).toEqual({
      agentName: "consultant-analyst",
      model: "test/analyst",
    })
    expect(resolveRoleTarget(config({ simple_agent: "my-simple", simple_model: "test/simple" }), "simple")).toEqual({
      agentName: "my-simple",
      model: "test/simple",
    })
    expect(resolveRoleTarget(config({ writer_delegate_agent: "host-writer" }), "author-writer")).toEqual({
      agentName: "host-writer",
      model: undefined,
    })
    expect(
      resolveRoleTarget(config({ writer_delegate_agent: "host-writer", writer_delegate_model: "p/m" }), "author-writer"),
    ).toEqual({ agentName: "host-writer", model: "p/m" })
    expect(
      resolveRoleTarget(config({ author_writer_agent: "custom-writer", author_writer_model: "provider/writer-model" }), "author-writer"),
    ).toEqual({ agentName: "custom-writer", model: "provider/writer-model" })

    const routed = config({
      consultant_analyst_model: "scalar/model",
      tier_models: { deep: { "consultant-analyst": "tier/model" } },
      mode_models: { research: { "consultant-analyst": "mode/model" } },
    })
    expect(resolveRoleTarget(routed, "consultant-analyst", { tier: "deep" })).toEqual({
      agentName: "consultant-analyst",
      model: "tier/model",
    })
    expect(resolveRoleTarget(routed, "consultant-analyst", { mode: "research", tier: "deep" })).toEqual({
      agentName: "consultant-analyst",
      model: "mode/model",
    })
  })
})

describe("splitModel", () => {
  it("splits provider/model on the first slash and rejects malformed ids", () => {
    expect(splitModel("deepseek/deepseek-v4.1-flash")).toEqual({
      providerID: "deepseek",
      modelID: "deepseek-v4.1-flash",
    })
    expect(splitModel("opencode-go/qwen3.8-max")).toEqual({
      providerID: "opencode-go",
      modelID: "qwen3.8-max",
    })
    expect(() => splitModel("no-slash")).toThrow(/provider\/model/)
    expect(() => splitModel("/leading")).toThrow()
    expect(() => splitModel("trailing/")).toThrow()
  })
})

describe("createJanusDispatchTool", () => {
  const savedEnv: Record<string, string | undefined> = {}
  let tmpConfigDir: string
  let configPath: string

  beforeEach(() => {
    savedEnv.JANUS_CONFIG = process.env.JANUS_CONFIG
    savedEnv.HOME = process.env.HOME
    tmpConfigDir = mkdtempSync(join(tmpdir(), "dispatch-config-"))
    configPath = join(tmpConfigDir, "config.jsonc")
    writeFileSync(
      configPath,
      JSON.stringify({
        common_explorer_model: "provider-a/explorer-m",
        consultant_analyst_model: "provider-b/analyst-m",
        consultant_critic_model: "provider-c/critic-m",
      }),
    )
    process.env.JANUS_CONFIG = configPath
  })

  afterEach(() => {
    if (savedEnv.JANUS_CONFIG === undefined) delete process.env.JANUS_CONFIG
    else process.env.JANUS_CONFIG = savedEnv.JANUS_CONFIG
    if (savedEnv.HOME === undefined) delete process.env.HOME
    else process.env.HOME = savedEnv.HOME
    rmSync(tmpConfigDir, { recursive: true, force: true })
  })

  it("dispatches to the right agent and model and returns the subagent text", async () => {
    const clock = createFakeClock()
    const fake = createRespondingFake("the analyst result", clock)
    const dispatchTool = createJanusDispatchTool(fake as unknown as PluginInput["client"], { clock })

    const result = await dispatchTool.execute({ role: "consultant-analyst", prompt: "analyze claims" }, fakeContext())

    expect(result).toBe("the analyst result")
    expect(promptAsyncCount(fake)).toBe(1)
    expect(abortCount(fake)).toBe(0)

    const createCall = fake.calls.find((c) => (c as { method: string }).method === "create") as { input: { body: { parentID?: string }; query: { directory?: string } } }
    expect(createCall.input.body.parentID).toBe("ses_parent")
    expect(createCall.input.query.directory).toBe("/tmp/project")

    const prompt = lastPromptAsyncCall(fake)
    expect(prompt.input.path.id).toMatch(/^ses_fake_/)
    expect(prompt.input.body.agent).toBe("consultant-analyst")
    expect(prompt.input.body.model).toEqual({ providerID: "provider-b", modelID: "analyst-m" })
    expect(prompt.input.body.parts).toEqual([{ type: "text", text: "analyze claims" }])
  })

  it("returns a clear error string when session create fails", async () => {
    const fake = createFakeSdk()
    fake.session.create = async () => ({ error: "boom", data: undefined })
    const dispatchTool = createJanusDispatchTool(fake as unknown as PluginInput["client"], { clock: createFakeClock() })

    const result = await dispatchTool.execute({ role: "consultant-critic", prompt: "challenge" }, fakeContext())

    expect(result).toContain("failed to create job")
    expect(result).toContain("unrecognized provider error")
    expect(result).not.toContain("boom")
  })

  it("returns a clear error string when promptAsync fails", async () => {
    const fake = createFakeSdk()
    fake.setPromptAsyncError({ status: 500, message: "model auth failed" })
    const dispatchTool = createJanusDispatchTool(fake as unknown as PluginInput["client"], { clock: createFakeClock() })

    const result = await dispatchTool.execute({ role: "common-explorer", prompt: "search" }, fakeContext())

    expect(result).toContain("explorer dispatch failed")
    expect(result).toContain("unrecognized provider error")
    expect(result).not.toContain("model auth failed")
  })

  it("fails after one attempt when a retryable quota error hits the single-model writer chain", async () => {
    const clock = createFakeClock()
    const fake = createFakeSdk()
    const base = fake.session.promptAsync.bind(fake.session)
    fake.session.promptAsync = async (input) => {
      const result = await base(input)
      const requestMessageID = input.body.messageID!
      const sessionID = input.path.id
      fake.seedMessages(sessionID, [
        {
          info: {
            id: `msg-fail-${sessionID}`,
            sessionID,
            role: "assistant",
            parentID: requestMessageID,
            time: { created: clock.now(), completed: clock.now() },
            modelID: "m",
            providerID: "p",
            error: { name: "APIError", data: { isRetryable: true, status: 402, message: "quota exhausted" } },
          } as SdkAssistantMessage,
          parts: [],
        },
      ])
      return result
    }
    const dispatchTool = createJanusDispatchTool(fake as unknown as PluginInput["client"], { clock })

    const result = await dispatchTool.execute({ role: "author-writer", prompt: "blueprint" }, fakeContext())

    expect(result).toContain("writer dispatch failed")
    expect(result).toContain("opencode/claude-sonnet-5-5")
    expect(promptAsyncCount(fake)).toBe(1)
  })

  it("reports every tried model when the whole chain fails", async () => {
    const clock = createFakeClock()
    const fake = createFakeSdk()
    const base = fake.session.promptAsync.bind(fake.session)
    fake.session.promptAsync = async (input) => {
      const result = await base(input)
      const requestMessageID = input.body.messageID!
      const sessionID = input.path.id
      fake.seedMessages(sessionID, [
        {
          info: {
            id: `msg-err-${sessionID}`,
            sessionID,
            role: "assistant",
            parentID: requestMessageID,
            time: { created: clock.now(), completed: clock.now() },
            modelID: "m",
            providerID: "p",
            error: { name: "APIError", data: { isRetryable: true, status: 429, message: "rate limited" } },
          } as SdkAssistantMessage,
          parts: [],
        },
      ])
      return result
    }
    const dispatchTool = createJanusDispatchTool(fake as unknown as PluginInput["client"], { clock })

    const result = await dispatchTool.execute({ role: "author-writer", prompt: "blueprint" }, fakeContext())

    expect(result).toContain("opencode/claude-sonnet-5-5")
    expect(result).toContain("degrade")
  })

  it("does not fall back on a non-retryable writer error", async () => {
    const clock = createFakeClock()
    const fake = createFakeSdk()
    const base = fake.session.promptAsync.bind(fake.session)
    fake.session.promptAsync = async (input) => {
      const result = await base(input)
      const requestMessageID = input.body.messageID!
      const sessionID = input.path.id
      fake.seedMessages(sessionID, [
        {
          info: {
            id: `msg-err-${sessionID}`,
            sessionID,
            role: "assistant",
            parentID: requestMessageID,
            time: { created: clock.now(), completed: clock.now() },
            modelID: "m",
            providerID: "p",
            error: { name: "APIError", data: { isRetryable: false, status: 401, message: "model auth failed" } },
          } as SdkAssistantMessage,
          parts: [],
        },
      ])
      return result
    }
    const dispatchTool = createJanusDispatchTool(fake as unknown as PluginInput["client"], { clock })

    const result = await dispatchTool.execute({ role: "author-writer", prompt: "blueprint" }, fakeContext())

    expect(result).toContain("writer dispatch failed")
    expect(promptAsyncCount(fake)).toBe(1)
  })

  it("dispatches a delegated writer without pinning a model", async () => {
    writeFileSync(configPath, JSON.stringify({ writer_delegate_agent: "host-writer" }))
    const clock = createFakeClock()
    const fake = createRespondingFake("host wrote it", clock)
    const dispatchTool = createJanusDispatchTool(fake as unknown as PluginInput["client"], { clock })

    const result = await dispatchTool.execute({ role: "author-writer", prompt: "blueprint" }, fakeContext())

    expect(result).toBe("host wrote it")
    expect(promptAsyncCount(fake)).toBe(1)
    const prompt = lastPromptAsyncCall(fake)
    expect(prompt.input.body.agent).toBe("host-writer")
    expect(prompt.input.body.model).toBeUndefined()
  })

  it("rejects simple when simple_enabled=false", async () => {
    // given
    const tmpConfigDir = mkdtempSync(join(tmpdir(), "dispatch-liteoff-"))
    const configPath = join(tmpConfigDir, "config.jsonc")
    writeFileSync(configPath, '{\n  "simple_enabled": false\n}')
    process.env.JANUS_CONFIG = configPath
    const tools = createJanusDispatchTools(createFakeSdk() as unknown as PluginInput["client"])

    try {
      // when
      const result = await tools.janus_dispatch.execute({ role: "simple", prompt: "quick lookup" }, fakeContext())

      // then
      expect(result).toBe("Error: simple is disabled by configuration")
    } finally {
      delete process.env.JANUS_CONFIG
      rmSync(tmpConfigDir, { recursive: true, force: true })
    }
  })

  it("rejects author-reviewer when author_reviewer_enabled=false", async () => {
    // given
    const tmpConfigDir = mkdtempSync(join(tmpdir(), "dispatch-aroff-"))
    const configPath = join(tmpConfigDir, "config.jsonc")
    writeFileSync(configPath, '{\n  "author_reviewer_enabled": false\n}')
    process.env.JANUS_CONFIG = configPath
    const tools = createJanusDispatchTools(createFakeSdk() as unknown as PluginInput["client"])

    try {
      // when
      const result = await tools.janus_dispatch.execute(
        { role: "author-reviewer", prompt: "review the drafted chapter" },
        fakeContext(),
      )

      // then
      expect(result).toBe("Error: author-reviewer is disabled by configuration")
    } finally {
      delete process.env.JANUS_CONFIG
      rmSync(tmpConfigDir, { recursive: true, force: true })
    }
  })

  it("rejects any dispatch with the removed coder-lite key migration guidance", async () => {
    // given — a config that still carries a retired coder-lite key
    const tmpConfigDir = mkdtempSync(join(tmpdir(), "dispatch-migrate-"))
    const configPath = join(tmpConfigDir, "config.jsonc")
    writeFileSync(configPath, JSON.stringify({ coder_lite_model: "fixture/coder-lite" }))
    const previousConfig = process.env.JANUS_CONFIG
    process.env.JANUS_CONFIG = configPath
    const fake = createFakeSdk()
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])

    try {
      // when — any janus_dispatch call hits the config load
      let message = ""
      try {
        message = outputText(
          await tools.janus_dispatch.execute({ role: "coder", prompt: "implement" }, fakeContext()),
        )
      } catch (error: unknown) {
        message = error instanceof Error ? error.message : String(error)
      }

      // then — the error carries the migration guidance and nothing is launched
      expect(message).toContain("removed coder-lite keys detected")
      expect(message).toContain("tech_lead_")
      expect(promptAsyncCount(fake)).toBe(0)
    } finally {
      if (previousConfig === undefined) delete process.env.JANUS_CONFIG
      else process.env.JANUS_CONFIG = previousConfig
      rmSync(tmpConfigDir, { recursive: true, force: true })
    }
  })

  it("launches tech-lead with the configured agent and model", async () => {
    // given
    const tmpConfigDir = mkdtempSync(join(tmpdir(), "dispatch-tl-"))
    const configPath = join(tmpConfigDir, "config.jsonc")
    writeFileSync(configPath, JSON.stringify({ tech_lead_agent: "custom-lead", tech_lead_model: "custom/lead" }))
    process.env.JANUS_CONFIG = configPath
    const fake = createRespondingFake("plan reviewed")
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])

    try {
      // when
      const result = await tools.janus_dispatch.execute({ role: "tech-lead", prompt: "plan the milestone" }, fakeContext())

      // then
      const body = lastPromptAsyncCall(fake).input.body
      expect(body.agent).toBe("custom-lead")
      expect(body.model).toEqual({ providerID: "custom", modelID: "lead" })
      expect(result).toBe("plan reviewed")
    } finally {
      delete process.env.JANUS_CONFIG
      rmSync(tmpConfigDir, { recursive: true, force: true })
    }
  })

  it("launches solution-reviewer on the default route", async () => {
    // given
    const fake = createRespondingFake("pre-mortem done")
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])

    // when
    const result = await tools.janus_dispatch.execute({ role: "solution-reviewer", prompt: "run the pre-mortem" }, fakeContext())

    // then
    const body = lastPromptAsyncCall(fake).input.body
    expect(body.agent).toBe("solution-reviewer")
    expect(body.model).toEqual({ providerID: "opencode", modelID: "claude-sonnet-5-5" })
    expect(result).toBe("pre-mortem done")
  })

  it("rejects an unknown role with the canonical role list", async () => {
    // given
    const fake = createRespondingFake("done")
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])

    // when
    const result = await tools.janus_dispatch.execute({ role: "build", prompt: "refactor X" }, fakeContext())

    // then
    expect(result).toContain("expected one of")
    expect(result).toContain("common-explorer")
    expect(promptAsyncCount(fake)).toBe(0)
  })

  it("prepends the protocol card to the first turn", async () => {
    // given
    const fake = createRespondingFake("reviewed")
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])

    // when
    const result = await tools.janus_dispatch.execute(
      { role: "consultant-critic", prompt: "challenge this conclusion", protocol: "counter_evidence" },
      fakeContext(),
    )

    // then
    expect(result).toBe("reviewed")
    const text = lastPromptAsyncCall(fake).input.body.parts[0]?.text ?? ""
    expect(text.startsWith("## Protocol: counter_evidence")).toBe(true)
    expect(text.endsWith("challenge this conclusion")).toBe(true)
  })

  it("rejects a protocol on a role that does not carry its contract", async () => {
    // given
    const fake = createRespondingFake("should not run")
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])

    // when
    const result = await tools.janus_dispatch.execute(
      { role: "consultant-analyst", prompt: "review", protocol: "design_premortem" },
      fakeContext(),
    )

    // then
    expect(result).toContain("protocol design_premortem is not supported by role consultant-analyst")
    expect(promptAsyncCount(fake)).toBe(0)
  })

  it("uses the production 1800000 ms wait budget at the tool boundary", async () => {
    const captured: LaunchInput[] = []
    const spyLifecycle: DispatchLifecycle = {
      launch: async (input) => {
        captured.push(input)
        const envelope: DispatchEnvelope = {
          v: 1,
          status: "pending",
          job_id: "ses_spy",
          role: input.role,
          attempt: { index: 0, model: input.modelChain[0] ?? null },
          session_id: "ses_spy",
          waited_ms: 0,
          reason: "spy",
          next: "janus_dispatch_wait",
        }
        return JSON.stringify(envelope)
      },
      wait: async () => "never called",
      continue: async () => "never called",
    }
    const fake = createFakeSdk()
    const dispatchTool = createJanusDispatchTool(fake as unknown as PluginInput["client"], { lifecycle: spyLifecycle })

    await dispatchTool.execute({ role: "consultant-analyst", prompt: "analyze evidence" }, fakeContext())

    expect(captured).toHaveLength(1)
    expect(captured[0]!.waitMs ?? PRODUCTION_WAIT_BUDGET_MS).toBe(PRODUCTION_WAIT_BUDGET_MS)
    expect(captured[0]!.returnHandle).toBeUndefined()
  })

  it("passes return_handle through to the lifecycle launch", async () => {
    const captured: LaunchInput[] = []
    const spyLifecycle: DispatchLifecycle = {
      launch: async (input) => {
        captured.push(input)
        return "spy result"
      },
      wait: async () => "never called",
      continue: async () => "never called",
    }
    const fake = createFakeSdk()
    const dispatchTool = createJanusDispatchTool(fake as unknown as PluginInput["client"], { lifecycle: spyLifecycle })

    await dispatchTool.execute({ role: "author-writer", prompt: "draft", return_handle: true }, fakeContext())

    expect(captured[0]!.returnHandle).toBe(true)
  })

  it("blocks author dispatch from a dispatched sub-session with no launch", async () => {
    // given — a caller session whose title marks it as a dispatched sub-session
    const fake = createRespondingFake("author prose")
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])
    const marked = await fake.session.create({
      body: { title: "[consultation-dispatch:v1] coder" },
      query: { directory: "/tmp/project" },
    })

    // when — the dispatched sub-session tries to delegate documentation
    const result = await tools.janus_dispatch.execute(
      { role: "author", prompt: "write the tutorial" },
      fakeContext({ sessionID: marked.data!.id }),
    )

    // then — the DAG guard rejects before any job session is created
    expect(result).toBe("Error: dispatched session cannot dispatch author; return the documentation request to the primary caller")
    expect(promptAsyncCount(fake)).toBe(0)
    const creates = fake.calls.filter((c) => (c as { method: string }).method === "create")
    expect(creates).toHaveLength(1) // only the seeded marked session
  })

  it("returns a retryable error when the caller session read fails", async () => {
    // given — the guard's caller read fails at the transport layer
    const fake = createRespondingFake("author prose")
    fake.setGetResult({ error: { name: "APIError", data: { statusCode: 503 } } })
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])

    // when
    const result = await tools.janus_dispatch.execute({ role: "author", prompt: "write the tutorial" }, fakeContext())

    // then — a retryable error, no job session, no prompt
    expect(result).toContain("failed to read caller session:")
    expect(result).toContain("ses_parent")
    expect(result).toContain("/tmp/project")
    expect(result).toContain("APIError: 503")
    expect(result).toContain("retry janus_dispatch")
    expect(promptAsyncCount(fake)).toBe(0)
    expect(fake.calls.filter((c) => (c as { method: string }).method === "create")).toHaveLength(0)
  })

  it("dispatches author from a top-level session with exactly one caller read", async () => {
    // given — the caller session is unknown to the SDK: no error, no title
    const fake = createRespondingFake("author prose")
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])

    // when
    const result = await tools.janus_dispatch.execute({ role: "author", prompt: "write the tutorial" }, fakeContext())

    // then — the guard reads the caller once and the launch proceeds normally
    expect(result).toBe("author prose")
    expect(promptAsyncCount(fake)).toBe(1)
    expect(fake.calls.filter((c) => (c as { method: string }).method === "get")).toHaveLength(1)
    const prompt = lastPromptAsyncCall(fake)
    expect(prompt.input.body.agent).toBe("author")
    expect(prompt.input.body.model).toEqual({ providerID: "opencode-go", modelID: "gemini-4-argon" })
  })

  it("makes no caller session read for non-author roles", async () => {
    // given
    const fake = createRespondingFake("the analyst result")
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])

    // when
    const result = await tools.janus_dispatch.execute({ role: "consultant-analyst", prompt: "analyze claims" }, fakeContext())

    // then — the existing call trace is unchanged: zero session.get calls
    expect(result).toBe("the analyst result")
    expect(fake.calls.filter((c) => (c as { method: string }).method === "get")).toHaveLength(0)
  })

  it("lets a dispatched sub-session dispatch non-author roles", async () => {
    // given — the legal edges out of a marked session
    const fake = createRespondingFake("specialist done")
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])
    const marked = await fake.session.create({
      body: { title: "[consultation-dispatch:v1] coder" },
      query: { directory: "/tmp/project" },
    })

    for (const role of ["coder", "author-writer", "author-reviewer"] as const) {
      // when
      const result = await tools.janus_dispatch.execute({ role, prompt: "bounded task" }, fakeContext({ sessionID: marked.data!.id }))

      // then — only the author dispatch is guarded
      expect(result).toBe("specialist done")
    }
    expect(promptAsyncCount(fake)).toBe(3)
  })

  it("blocks consultant and tech-lead dispatch from a dispatched sub-session with no launch", async () => {
    // given — a caller session whose title marks it as a dispatched sub-session
    const fake = createRespondingFake("specialist done")
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])
    const marked = await fake.session.create({
      body: { title: "[consultation-dispatch:v1] coder" },
      query: { directory: "/tmp/project" },
    })
    const rejections = [
      ["consultant", "Error: dispatched session cannot dispatch consultant; return the consultation request to the primary caller"],
      ["tech-lead", "Error: dispatched session cannot dispatch tech-lead; return the coding task to the primary caller"],
    ] as const

    for (const [role, message] of rejections) {
      // when — the dispatched sub-session tries to delegate a coordinator role
      const result = await tools.janus_dispatch.execute({ role, prompt: "coordinate this" }, fakeContext({ sessionID: marked.data!.id }))

      // then — the DAG guard rejects before any job session is created
      expect(result).toBe(message)
    }
    expect(promptAsyncCount(fake)).toBe(0)
    expect(fake.calls.filter((c) => (c as { method: string }).method === "get")).toHaveLength(2)
  })

  it("dispatches consultant and tech-lead from a top-level session with exactly one caller read each", async () => {
    // given — a caller session unknown to the SDK: no error, no marker title
    const fake = createRespondingFake("specialist done")
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])

    for (const role of ["consultant", "tech-lead"] as const) {
      // when
      const result = await tools.janus_dispatch.execute({ role, prompt: "coordinate this" }, fakeContext())

      // then — the guard reads the caller once per dispatch and proceeds
      expect(result).toBe("specialist done")
    }
    expect(fake.calls.filter((c) => (c as { method: string }).method === "get")).toHaveLength(2)
  })

  it("makes no caller session read for the ten unguarded roles", async () => {
    // given — every role outside {consultant, tech-lead, author} keeps the
    // existing call trace: the DAG guard never issues a session.get.
    const spyLifecycle: DispatchLifecycle = {
      launch: async () => "spy result",
      wait: async () => "never called",
      continue: async () => "never called",
    }
    const fake = createFakeSdk()
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"], { lifecycle: spyLifecycle })
    const roles = [
      "simple", "common-explorer", "consultant-analyst", "consultant-critic", "consultant-auditor",
      "solution-reviewer", "coder", "coder-reviewer", "author-writer", "author-reviewer",
    ] as const

    for (const role of roles) {
      const result = await tools.janus_dispatch.execute({ role, prompt: "bounded task" }, fakeContext())
      // coder-reviewer legitimately stops at the review guard (no ids); its
      // call trace must stay free of session.get all the same.
      if (role === "coder-reviewer") {
        expect(result).toMatch(/^Error: coder-reviewer requires reviews_job_ids/)
      } else {
        expect(result).toBe("spy result")
      }
    }

    expect(fake.calls.filter((c) => (c as { method: string }).method === "get")).toHaveLength(0)
  })

  it("rejects author dispatch and continuation when author is disabled", async () => {
    // given — an enabled dispatch captures a reusable author session
    const fake = createRespondingFake("author prose")
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])
    const launched = await tools.janus_dispatch.execute(
      { role: "author", prompt: "write the tutorial", return_handle: true },
      fakeContext(),
    )
    const parsed = parseOutcomeEnvelope(outputText(launched))
    if (!parsed.ok || parsed.value.status !== "completed") {
      throw new Error(`expected completed envelope: ${outputText(launched)}`)
    }

    // when — the user disables author afterwards
    writeFileSync(configPath, JSON.stringify({ author_enabled: false }))
    const before = promptAsyncCount(fake)
    const dispatch = await tools.janus_dispatch.execute({ role: "author", prompt: "write another tutorial" }, fakeContext())
    const continued = await tools.janus_dispatch_continue.execute(
      { session_id: parsed.value.session_id, prompt: "revise the tutorial" },
      fakeContext(),
    )

    // then — both surfaces reject with no new prompts
    expect(dispatch).toBe("Error: author is disabled by configuration")
    expect(continued).toBe("Error: author is disabled by configuration")
    expect(promptAsyncCount(fake)).toBe(before)
  })
})

describe("caller context watermark", () => {
  const savedEnv: Record<string, string | undefined> = {}
  let tmpConfigDir: string
  let configPath: string

  beforeEach(() => {
    savedEnv.JANUS_CONFIG = process.env.JANUS_CONFIG
    savedEnv.HOME = process.env.HOME
    tmpConfigDir = mkdtempSync(join(tmpdir(), "dispatch-watermark-"))
    configPath = join(tmpConfigDir, "config.jsonc")
    writeFileSync(configPath, "{}")
    process.env.JANUS_CONFIG = configPath
  })

  afterEach(() => {
    if (savedEnv.JANUS_CONFIG === undefined) delete process.env.JANUS_CONFIG
    else process.env.JANUS_CONFIG = savedEnv.JANUS_CONFIG
    if (savedEnv.HOME === undefined) delete process.env.HOME
    else process.env.HOME = savedEnv.HOME
    rmSync(tmpConfigDir, { recursive: true, force: true })
  })

  function completedAssistantWithTokens(tokens: SdkTokenUsage): SdkMessageWithParts {
    return {
      info: {
        id: "msg-context",
        sessionID: "ses_parent",
        role: "assistant",
        time: { created: 1, completed: 2 },
        parentID: "msg-user",
        modelID: "m",
        providerID: "p",
        finish: "stop",
        tokens,
      } as SdkAssistantMessage,
      parts: [],
    }
  }

  function watermarkLine(tokens: number): string {
    return `[context-watermark: ${tokens} tokens >= ${CONTEXT_WATERMARK_TOKENS}; checkpoint at milestone boundary]`
  }

  it("appends the marker line to a plain success text over the threshold", async () => {
    // given — a caller past the soft watermark
    const fake = createRespondingFake("the specialist report")
    fake.seedMessages("ses_parent", [completedAssistantWithTokens({ total: 260_000 })])
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])

    // when
    const result = await tools.janus_dispatch.execute({ role: "consultant-analyst", prompt: "analyze claims" }, fakeContext())

    // then
    expect(result).toBe(`the specialist report\n${watermarkLine(260_000)}`)
  })

  it("appends the marker line to a plain error text over the threshold", async () => {
    // given — a caller past the soft watermark hitting the DAG guard
    const fake = createRespondingFake("author prose")
    const marked = await fake.session.create({
      body: { title: "[consultation-dispatch:v1] coder" },
      query: { directory: "/tmp/project" },
    })
    fake.seedMessages(marked.data!.id, [completedAssistantWithTokens({ total: 260_000 })])
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])

    // when
    const result = await tools.janus_dispatch.execute({ role: "author", prompt: "write the tutorial" }, fakeContext({ sessionID: marked.data!.id }))

    // then
    expect(result).toBe(
      `Error: dispatched session cannot dispatch author; return the documentation request to the primary caller\n${watermarkLine(260_000)}`,
    )
  })

  it("appends the marker line to a review-guard error text over the threshold", async () => {
    // given — a caller past the soft watermark misusing the review seat
    const fake = createFakeSdk()
    fake.seedMessages("ses_parent", [completedAssistantWithTokens({ total: 300_000 })])
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])

    // when
    const result = await tools.janus_dispatch.execute({ role: "coder-reviewer", prompt: "review the plan" }, fakeContext())

    // then
    expect(result).toBe(
      `Error: coder-reviewer requires reviews_job_ids: pass the root job_id of each coder task it reviews (the janus_dispatch job_id of the coder work)\n${watermarkLine(300_000)}`,
    )
  })

  it("adds context_watermark to every decorated envelope form without free text", async () => {
    // given — a caller past the soft watermark and a canned launch outcome
    const fake = createFakeSdk()
    fake.seedMessages("ses_parent", [completedAssistantWithTokens({ total: 260_000 })])
    const cases: ReadonlyArray<() => string> = [
      () => JSON.stringify(makeEnvelope("pending")),
      () => JSON.stringify(makeEnvelope("unknown")),
      () => JSON.stringify(makeEnvelope("cancelling")),
      () => JSON.stringify(makeCompletedEnvelope()),
    ]

    for (const make of cases) {
      const spyLifecycle: DispatchLifecycle = {
        launch: async () => make(),
        wait: async () => "never called",
        continue: async () => "never called",
      }
      const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"], { lifecycle: spyLifecycle })

      // when
      const result = await tools.janus_dispatch.execute({ role: "consultant-analyst", prompt: "analyze" }, fakeContext())

      // then — the envelope carries the field and no free-text marker
      const parsed = parseOutcomeEnvelope(outputText(result))
      if (!parsed.ok || parsed.value.status === "cancelled") throw new Error(`expected a decorated envelope: ${outputText(result)}`)
      expect(parsed.value.context_watermark).toBe(260_000)
      expect(outputText(result)).not.toContain("[context-watermark:")
    }
  })

  it("passes a cancelled envelope through untouched", async () => {
    // given — the cancelled form is outside the decorated set
    const fake = createFakeSdk()
    fake.seedMessages("ses_parent", [completedAssistantWithTokens({ total: 260_000 })])
    const launchText = JSON.stringify(makeCancelledEnvelope())
    const spyLifecycle: DispatchLifecycle = {
      launch: async () => launchText,
      wait: async () => "never called",
      continue: async () => "never called",
    }
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"], { lifecycle: spyLifecycle })

    // when
    const result = await tools.janus_dispatch.execute({ role: "consultant-analyst", prompt: "analyze" }, fakeContext())

    // then
    expect(outputText(result)).toBe(launchText)
    const parsed = parseOutcomeEnvelope(outputText(result))
    if (!parsed.ok || parsed.value.status !== "cancelled") throw new Error(`expected a cancelled envelope: ${outputText(result)}`)
    expect("context_watermark" in parsed.value).toBe(false)
  })

  it("rejects a coder dispatch at the hard ceiling byte-exactly with no SDK write traffic", async () => {
    // given — a caller past the coder hard ceiling
    const fake = createRespondingFake("never runs")
    fake.seedMessages("ses_parent", [completedAssistantWithTokens({ total: 400_000 })])
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])

    // when
    const result = await tools.janus_dispatch.execute({ role: "coder", prompt: "implement the milestone" }, fakeContext())

    // then — the full rejection text, the marker line, and zero writes
    expect(result).toBe(
      `Error: controller context exceeded ${CODER_HARD_CEILING_TOKENS} tokens hard ceiling; checkpoint to plan.md and handoff.md before continuing. Recovery: update the plan.md ledger and write handoff.md, resume from a fresh controller session with 继续交接, or reduce context and retry.\n${watermarkLine(400_000)}`,
    )
    expect(promptAsyncCount(fake)).toBe(0)
    expect(fake.calls.filter((c) => (c as { method: string }).method === "create")).toHaveLength(0)
  })

  it("runs non-coder roles normally at and beyond the hard ceiling", async () => {
    // given — the hard ceiling only guards the coder target
    for (const tokens of [CODER_HARD_CEILING_TOKENS, 400_000]) {
      const fake = createRespondingFake("the specialist report")
      fake.seedMessages("ses_parent", [completedAssistantWithTokens({ total: tokens })])
      const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])

      const analyst = await tools.janus_dispatch.execute({ role: "consultant-analyst", prompt: "analyze" }, fakeContext())
      expect(analyst).toBe(`the specialist report\n${watermarkLine(tokens)}`)

      const lead = await tools.janus_dispatch.execute({ role: "tech-lead", prompt: "plan" }, fakeContext())
      expect(lead).toBe(`the specialist report\n${watermarkLine(tokens)}`)
    }
  })

  it("marks but never rejects between the soft watermark and the hard ceiling", async () => {
    // given — 250k <= t < 350k: marking only
    for (const tokens of [CONTEXT_WATERMARK_TOKENS, 349_999]) {
      const fake = createRespondingFake("the specialist report")
      fake.seedMessages("ses_parent", [completedAssistantWithTokens({ total: tokens })])
      const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])

      // when — even the coder target is dispatched
      const result = await tools.janus_dispatch.execute({ role: "coder", prompt: "implement" }, fakeContext())

      // then
      expect(result).toBe(`the specialist report\n${watermarkLine(tokens)}`)
    }
  })

  it("adds no marker below the soft watermark", async () => {
    // given — one token under the threshold
    const fake = createRespondingFake("the specialist report")
    fake.seedMessages("ses_parent", [completedAssistantWithTokens({ total: CONTEXT_WATERMARK_TOKENS - 1 })])
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])

    // when
    const result = await tools.janus_dispatch.execute({ role: "coder", prompt: "implement" }, fakeContext())

    // then
    expect(result).toBe("the specialist report")
  })

  it("dispatches normally with no marker when the context read fails", async () => {
    // given — the caller session's messages error: the watermark must never
    // block a dispatch (job sessions keep their own working reads)
    const fake = createRespondingFake("the specialist report")
    const base = fake.session.messages.bind(fake.session)
    fake.session.messages = async (input) => {
      if (input.path.id === "ses_parent") return { error: { name: "APIError", data: { statusCode: 500 } } }
      return base(input)
    }
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])

    // when — a coder dispatch with an unreadable context: pass through
    const result = await tools.janus_dispatch.execute({ role: "coder", prompt: "implement" }, fakeContext())

    // then
    expect(result).toBe("the specialist report")
  })

  it("adds context_watermark to janus_dispatch_wait pending and completed envelopes", async () => {
    // given — a caller past the soft watermark and canned wait outcomes
    const fake = createFakeSdk()
    fake.seedMessages("ses_parent", [completedAssistantWithTokens({ total: 260_000 })])
    const outcomes = [
      ["pending", JSON.stringify(makeEnvelope("pending"))],
      ["completed", JSON.stringify(makeCompletedEnvelope())],
    ] as const

    for (const [name, outcome] of outcomes) {
      const spyLifecycle: DispatchLifecycle = {
        launch: async () => "never called",
        wait: async () => outcome,
        continue: async () => "never called",
      }
      const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"], { lifecycle: spyLifecycle })

      // when
      const result = await tools.janus_dispatch_wait.execute({ job_id: "ses_fake_job" }, fakeContext())

      // then — the envelope carries the field and no free-text marker
      const parsed = parseOutcomeEnvelope(outputText(result))
      if (!parsed.ok || parsed.value.status === "cancelled") throw new Error(`expected a decorated envelope (${name}): ${outputText(result)}`)
      expect(parsed.value.context_watermark).toBe(260_000)
      expect(outputText(result)).not.toContain("[context-watermark:")
    }
  })

  it("appends the marker line to a janus_dispatch_continue text return over the threshold", async () => {
    // given — a caller past the soft watermark and a completed dispatch session
    const clock = createFakeClock()
    const fake = createRespondingFake("maintenance applied", clock)
    fake.seedMessages("ses_parent", [completedAssistantWithTokens({ total: 260_000 })])
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"], { clock })
    const dispatchResult = await tools.janus_dispatch.execute(
      { role: "author-writer", prompt: "draft chapter one", return_handle: true },
      fakeContext(),
    )
    const dispatched = parseOutcomeEnvelope(outputText(dispatchResult))
    if (!dispatched.ok || dispatched.value.status !== "completed") {
      throw new Error(`expected completed envelope: ${outputText(dispatchResult)}`)
    }

    // when
    const result = await tools.janus_dispatch_continue.execute(
      { session_id: dispatched.value.session_id, prompt: "apply the review fix" },
      fakeContext(),
    )

    // then — the text return carries the appended marker line
    expect(result).toBe(`maintenance applied\n${watermarkLine(260_000)}`)
  })

  it("adds context_watermark to a janus_dispatch_continue pending envelope", async () => {
    // given — a caller past the soft watermark and a promptAsync that never completes
    const clock = createFakeClock()
    const fake = createFakeSdk()
    fake.setPromptAsyncResult({ data: undefined })
    fake.seedMessages("ses_parent", [completedAssistantWithTokens({ total: 260_000 })])
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"], { clock })

    const firstResult = await (async () => {
      const launched = tools.janus_dispatch.execute({ role: "author-writer", prompt: "draft chapter one" }, fakeContext())
      await exhaustBudget(clock, launched)
      return outputText(await launched)
    })()
    const first = parseOutcomeEnvelope(firstResult)
    if (!first.ok) throw first.error
    expect(first.value.status).toMatch(/pending|unknown/)
    const targetSession = first.value.session_id

    // when
    const continueResult = await (async () => {
      const continued = tools.janus_dispatch_continue.execute(
        { session_id: targetSession, prompt: "apply the review fix" },
        fakeContext(),
      )
      await exhaustBudget(clock, continued)
      return outputText(await continued)
    })()

    // then — the pending envelope carries the field and no free-text marker
    const parsed = parseOutcomeEnvelope(continueResult)
    if (!parsed.ok || parsed.value.status === "cancelled") throw new Error(`expected a decorated envelope: ${continueResult}`)
    expect(parsed.value.context_watermark).toBe(260_000)
    expect(continueResult).not.toContain("[context-watermark:")
  })

  it("decorates neither wait nor continue below the soft watermark", async () => {
    // given — a caller one token under the threshold
    const clock = createFakeClock()
    const fake = createRespondingFake("maintenance applied", clock)
    fake.seedMessages("ses_parent", [completedAssistantWithTokens({ total: CONTEXT_WATERMARK_TOKENS - 1 })])

    const waitSpy: DispatchLifecycle = {
      launch: async () => "never called",
      wait: async () => JSON.stringify(makeCompletedEnvelope()),
      continue: async () => "never called",
    }
    const waitTools = createJanusDispatchTools(fake as unknown as PluginInput["client"], { lifecycle: waitSpy, clock })

    // when — a wait over the undecorated caller context
    const waitResult = await waitTools.janus_dispatch_wait.execute({ job_id: "ses_fake_job" }, fakeContext())

    // then
    const waitParsed = parseOutcomeEnvelope(outputText(waitResult))
    if (!waitParsed.ok) throw waitParsed.error
    expect("context_watermark" in waitParsed.value).toBe(false)
    expect(outputText(waitResult)).not.toContain("[context-watermark:")

    // when — a continue over the undecorated caller context
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"], { clock })
    const dispatchResult = await tools.janus_dispatch.execute(
      { role: "author-writer", prompt: "draft chapter one", return_handle: true },
      fakeContext(),
    )
    const dispatched = parseOutcomeEnvelope(outputText(dispatchResult))
    if (!dispatched.ok || dispatched.value.status !== "completed") {
      throw new Error(`expected completed envelope: ${outputText(dispatchResult)}`)
    }
    const result = await tools.janus_dispatch_continue.execute(
      { session_id: dispatched.value.session_id, prompt: "apply the review fix" },
      fakeContext(),
    )

    // then
    expect(result).toBe("maintenance applied")
  })
})

describe("janus_dispatch return_handle results", () => {
  const savedEnv: Record<string, string | undefined> = {}
  let tmpConfigDir: string
  let configPath: string

  beforeEach(() => {
    savedEnv.JANUS_CONFIG = process.env.JANUS_CONFIG
    savedEnv.HOME = process.env.HOME
    tmpConfigDir = mkdtempSync(join(tmpdir(), "dispatch-handle-"))
    configPath = join(tmpConfigDir, "config.jsonc")
    writeFileSync(configPath, "{}")
    process.env.JANUS_CONFIG = configPath
  })

  afterEach(() => {
    if (savedEnv.JANUS_CONFIG === undefined) delete process.env.JANUS_CONFIG
    else process.env.JANUS_CONFIG = savedEnv.JANUS_CONFIG
    if (savedEnv.HOME === undefined) delete process.env.HOME
    else process.env.HOME = savedEnv.HOME
    rmSync(tmpConfigDir, { recursive: true, force: true })
  })

  it("returns a completed envelope with the reused session id on success", async () => {
    const clock = createFakeClock()
    const fake = createRespondingFake("the writer result", clock)
    const dispatchTool = createJanusDispatchTool(fake as unknown as PluginInput["client"], { clock })

    const result = await dispatchTool.execute({ role: "author-writer", prompt: "draft chapter one", return_handle: true }, fakeContext())

    const parsed = parseOutcomeEnvelope(outputText(result))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw parsed.error
    expect(parsed.value.status).toBe("completed")
    if (parsed.value.status !== "completed") throw new Error("expected completed envelope")
    expect(parsed.value.role).toBe("author-writer")
    expect(parsed.value.job_id).toMatch(/^ses_fake_/)
    expect(parsed.value.session_id).toMatch(/^ses_fake_/)
    expect(parsed.value.attempt.index).toBe(0)
    expect(parsed.value.text).toBe("the writer result")
  })

  it("keeps plain text as the default success result without return_handle", async () => {
    const fake = createRespondingFake("plain writer result")
    const dispatchTool = createJanusDispatchTool(fake as unknown as PluginInput["client"])

    const result = await dispatchTool.execute({ role: "author-writer", prompt: "draft chapter one" }, fakeContext())

    expect(outputText(result)).toBe("plain writer result")
    expect(parseOutcomeEnvelope(outputText(result)).ok).toBe(false)
  })
})

describe("janus_dispatch_continue", () => {
  const savedEnv: Record<string, string | undefined> = {}
  let tmpConfigDir: string
  let configPath: string

  beforeEach(() => {
    savedEnv.JANUS_CONFIG = process.env.JANUS_CONFIG
    savedEnv.HOME = process.env.HOME
    tmpConfigDir = mkdtempSync(join(tmpdir(), "dispatch-continue-"))
    configPath = join(tmpConfigDir, "config.jsonc")
    writeFileSync(configPath, "{}")
    process.env.JANUS_CONFIG = configPath
  })

  afterEach(() => {
    if (savedEnv.JANUS_CONFIG === undefined) delete process.env.JANUS_CONFIG
    else process.env.JANUS_CONFIG = savedEnv.JANUS_CONFIG
    if (savedEnv.HOME === undefined) delete process.env.HOME
    else process.env.HOME = savedEnv.HOME
    rmSync(tmpConfigDir, { recursive: true, force: true })
  })

  function createTools(fake: FakeSdk, clock = createFakeClock()) {
    return createJanusDispatchTools(fake as unknown as PluginInput["client"], { clock })
  }

  async function dispatchWriterWithHandle(fake: FakeSdk, tools: ReturnType<typeof createTools>, responseText = "chapter one prose"): Promise<{ jobID: string; sessionID: string; text: string }> {
    const result = await tools.janus_dispatch.execute(
      { role: "author-writer", prompt: "draft chapter one", return_handle: true },
      fakeContext(),
    )
    const parsed = parseOutcomeEnvelope(outputText(result))
    if (!parsed.ok || parsed.value.status !== "completed") {
      throw new Error(`expected completed envelope: ${outputText(result)}`)
    }
    expect(parsed.value.text).toBe(responseText)
    return { jobID: parsed.value.job_id, sessionID: parsed.value.session_id, text: parsed.value.text }
  }

  it("continues the writer job-root session and records the reuse in a continuation job", async () => {
    const clock = createFakeClock()
    const fake = createRespondingFake("maintenance applied", clock)
    const tools = createTools(fake, clock)
    const { sessionID } = await dispatchWriterWithHandle(fake, tools, "maintenance applied")

    const result = await tools.janus_dispatch_continue.execute(
      { session_id: sessionID, prompt: "apply the review fix to chapter one" },
      fakeContext(),
    )

    expect(result).toBe("maintenance applied")
    const asyncs = fake.calls.filter((c) => (c as { method: string }).method === "promptAsync") as Array<{ input: { path: { id: string }; body: { agent?: string; parts: SdkTextPart[] } } }>
    expect(asyncs).toHaveLength(2)
    // Both prompts went to the same reused session.
    expect(asyncs[0]!.input.path.id).toBe(sessionID)
    expect(asyncs[1]!.input.path.id).toBe(sessionID)
    expect(asyncs[1]!.input.body.agent).toBe("author-writer")
    expect(asyncs[1]!.input.body.parts).toEqual([{ type: "text", text: "apply the review fix to chapter one" }])
    // A continuation job root was created under the caller, with the reuse journaled.
    const creates = fake.calls.filter((c) => (c as { method: string }).method === "create") as Array<{ input: { body: { title: string; parentID: string } } }>
    expect(creates).toHaveLength(2)
    expect(creates[1]!.input.body.title).toBe("[consultation-dispatch:v1] author-writer")
    expect(creates[1]!.input.body.parentID).toBe("ses_parent")
  })

  it("locks the original agent and model on continuation after a config change", async () => {
    const clock = createFakeClock()
    const fake = createRespondingFake("maintenance applied", clock)
    const tools = createTools(fake, clock)
    const { sessionID } = await dispatchWriterWithHandle(fake, tools, "maintenance applied")

    // The user changes the writer route between the first turn and the follow-up.
    writeFileSync(
      configPath,
      JSON.stringify({ author_writer_agent: "other-writer", author_writer_model: "other/model" }),
    )

    const result = await tools.janus_dispatch_continue.execute(
      { session_id: sessionID, prompt: "apply the fix" },
      fakeContext(),
    )

    expect(result).toBe("maintenance applied")
    const asyncs = fake.calls.filter((c) => (c as { method: string }).method === "promptAsync") as Array<{ input: { body: { agent?: string; model?: { providerID: string; modelID: string } } } }>
    expect(asyncs).toHaveLength(2)
    expect(asyncs[1]!.input.body.agent).toBe("author-writer")
    expect(asyncs[1]!.input.body.model).toEqual({ providerID: "opencode", modelID: "claude-sonnet-5-5" })
  })

  it("continues an attempt-child session of a normal job root", async () => {
    // The tool always resolves a single-model chain, so a retry attempt child
    // is constructed directly through the journal (two-model spec).
    const clock = createFakeClock()
    const fake = createFakeSdk()
    const { jobID, attemptSessionID } = await (async () => {
      const created = await createJob(fake, {
        parentID: "ses_parent", directory: "/tmp/project", role: "author-writer",
        agentName: "author-writer", modelChain: ["opencode/claude-sonnet-5-5", "opencode-go/glm-5.3"],
        prompt: "draft chapter one", clock,
      })
      if (!created.ok) throw created.error
      const jobID = created.value.jobID
      const child = await createAttemptSession(fake, { jobID, directory: "/tmp/project", role: "author-writer" })
      if (!child.ok) throw child.error
      const messageID = "msg-attempt-child-0"
      for (const record of [
        { v: 1, kind: "attempt-reservation", job_id: jobID, attempt_index: 1, model: "opencode-go/glm-5.3", message_id: messageID, reserved_at: clock.now() } as const,
        { v: 1, kind: "attempt-receipt", job_id: jobID, attempt_index: 1, session_id: child.value.sessionID, message_id: messageID, received_at: clock.now() } as const,
      ]) {
        const appended = await appendRecord(fake, { jobID, directory: "/tmp/project", record })
        if (!appended.ok) throw appended.error
      }
      return { jobID, attemptSessionID: child.value.sessionID }
    })()
    const tools = createTools(fake, clock)

    // Seed the attempt child's completed reply so the continuation observes it.
    const base = fake.session.promptAsync.bind(fake.session)
    let promptAsyncCalls = 0
    fake.session.promptAsync = async (input) => {
      const result = await base(input)
      promptAsyncCalls++
      fake.seedMessages(input.path.id, [
        completedAssistantMessage(input.body.messageID!, "maintenance applied", {
          sessionID: input.path.id, id: `msg-continue-${input.path.id}`,
        }),
      ])
      return result
    }

    const result = await tools.janus_dispatch_continue.execute(
      { session_id: attemptSessionID, prompt: "apply the review fix" },
      fakeContext(),
    )

    expect(result).toBe("maintenance applied")
    // The continuation prompted the attempt child, not the job root.
    const asyncs = fake.calls.filter((c) => (c as { method: string }).method === "promptAsync") as Array<{ input: { path: { id: string } } }>
    expect(asyncs).toHaveLength(1)
    expect(asyncs[0]!.input.path.id).toBe(attemptSessionID)
    expect(promptAsyncCalls).toBe(1)
    // The continuation root was created under the caller.
    const creates = fake.calls.filter((c) => (c as { method: string }).method === "create") as Array<{ input: { body: { title: string; parentID: string } } }>
    expect(creates.at(-1)!.input.body.title).toBe("[consultation-dispatch:v1] author-writer")
    expect(creates.at(-1)!.input.body.parentID).toBe("ses_parent")
    expect(jobID).toMatch(/^ses_fake_/)
  })

  it("returns a pending envelope carrying the continuation job id and the target session id", async () => {
    const clock = createFakeClock()
    const fake = createFakeSdk()
    fake.setPromptAsyncResult({ data: undefined })
    const tools = createTools(fake, clock)

    const firstResult = await (async () => {
      const launched = tools.janus_dispatch.execute({ role: "author-writer", prompt: "draft chapter one" }, fakeContext())
      await exhaustBudget(clock, launched)
      return outputText(await launched)
    })()
    const first = parseOutcomeEnvelope(firstResult)
    if (!first.ok) throw first.error
    expect(first.value.status).toMatch(/pending|unknown/)
    const targetSession = first.value.session_id

    const continueResult = await (async () => {
      const continued = tools.janus_dispatch_continue.execute(
        { session_id: targetSession, prompt: "apply the review fix" },
        fakeContext(),
      )
      await exhaustBudget(clock, continued)
      return outputText(await continued)
    })()
    const continued = parseOutcomeEnvelope(continueResult)
    if (!continued.ok) throw continued.error
    expect(continued.value.status).toMatch(/pending|unknown/)
    expect(continued.value.job_id).not.toBe(first.value.job_id)
    expect(continued.value.session_id).toBe(targetSession)
    expect(promptAsyncCount(fake)).toBe(2)
  })

  it("infers the role from the target job and rejects a mismatched role argument", async () => {
    const clock = createFakeClock()
    const fake = createRespondingFake("analyst analysis", clock)
    const tools = createTools(fake, clock)
    const result = await tools.janus_dispatch.execute(
      { role: "consultant-analyst", prompt: "analyze the evidence", return_handle: true },
      fakeContext(),
    )
    const parsed = parseOutcomeEnvelope(outputText(result))
    if (!parsed.ok || parsed.value.status !== "completed") throw new Error("expected completed envelope")
    const sessionID = parsed.value.session_id

    // Role is inferred when omitted.
    const continued = await tools.janus_dispatch_continue.execute(
      { session_id: sessionID, prompt: "re-analyze with the new evidence" },
      fakeContext(),
    )
    expect(continued).toBe("analyst analysis")

    // A mismatched role is rejected without a new prompt.
    const before = promptAsyncCount(fake)
    const mismatch = await tools.janus_dispatch_continue.execute(
      { session_id: sessionID, prompt: "re-analyze", role: "author-writer" },
      fakeContext(),
    )
    expect(mismatch).toMatch(/^Error: role author-writer does not match/)
    expect(promptAsyncCount(fake)).toBe(before)
  })

  it("rejects a busy target with a wait-first error and no new prompt", async () => {
    const clock = createFakeClock()
    const fake = createRespondingFake("chapter one prose", clock)
    const tools = createTools(fake, clock)
    const { sessionID } = await dispatchWriterWithHandle(fake, tools)

    fake.setStatusResult({ data: { [sessionID]: { type: "busy" } } })
    const before = promptAsyncCount(fake)
    const result = await tools.janus_dispatch_continue.execute(
      { session_id: sessionID, prompt: "apply the review fix" },
      fakeContext(),
    )

    expect(result).toMatch(/^Error: target session is busy; wait for the active job first/)
    expect(promptAsyncCount(fake)).toBe(before)
  })

  it("allows a target whose status entry reports idle and rejects retrying targets", async () => {
    const clock = createFakeClock()
    const fake = createRespondingFake("chapter one prose", clock)
    const tools = createTools(fake, clock)
    const { sessionID } = await dispatchWriterWithHandle(fake, tools)

    fake.setStatusResult({ data: { [sessionID]: { type: "idle" } } })
    const idle = await tools.janus_dispatch_continue.execute(
      { session_id: sessionID, prompt: "apply the review fix" },
      fakeContext(),
    )
    expect(idle).toBe("chapter one prose")

    fake.setStatusResult({ data: { [sessionID]: { type: "retry" } } })
    const retrying = await tools.janus_dispatch_continue.execute(
      { session_id: sessionID, prompt: "apply the review fix again" },
      fakeContext(),
    )
    expect(retrying).toMatch(/^Error: target session is retry; wait for the active job first/)
  })

  it("rejects a continuation job id used as session_id", async () => {
    const clock = createFakeClock()
    const fake = createRespondingFake("maintenance applied", clock)
    const tools = createTools(fake, clock)
    const { sessionID } = await dispatchWriterWithHandle(fake, tools, "maintenance applied")

    const first = await tools.janus_dispatch_continue.execute(
      { session_id: sessionID, prompt: "apply the review fix" },
      fakeContext(),
    )
    expect(first).toBe("maintenance applied")
    // The continuation job root is the second created session.
    const creates = fake.calls.filter((c) => (c as { method: string }).method === "create") as Array<{ input: { body: { title: string } } }>
    expect(creates).toHaveLength(2)
    // ses_fake_2 is the continuation job root created by the continue above.
    const before = promptAsyncCount(fake)
    const rejected = await tools.janus_dispatch_continue.execute(
      { session_id: "ses_fake_2", prompt: "continue the continuation" },
      fakeContext(),
    )
    expect(rejected).toMatch(/^Error: ses_fake_2 is a continuation job; use the original dispatch session_id/)
    expect(promptAsyncCount(fake)).toBe(before)
  })

  it("rejects continuing a legacy coder-lite session with migration guidance and no prompt", async () => {
    // given — a historical job root whose spec records the retired coder-lite role
    const fake = createFakeSdk()
    const root = await fake.session.create({
      body: { parentID: "ses_parent", title: "[consultation-dispatch:v1] coder-lite" },
      query: { directory: "/tmp/project" },
    })
    if (root.data === undefined) throw new Error("missing root")
    await fake.session.prompt({
      path: { id: root.data.id },
      body: {
        noReply: true,
        parts: [{ type: "text", synthetic: true, ignored: true, text: JSON.stringify(legacyRoleSpecs[0]!.record) }],
      },
      query: { directory: "/tmp/project" },
    })
    const tools = createTools(fake)

    // when
    const result = await tools.janus_dispatch_continue.execute(
      { session_id: root.data.id, prompt: "continue the milestone" },
      fakeContext(),
    )

    // then — the legacy role is blocked before any prompt is issued
    expect(result).toMatch(/^Error: the coder-lite role is retired/)
    expect(result).toContain('role "coder"')
    expect(result).toContain('tier: "fast"')
    expect(result).toContain("tier_models.fast.coder")
    expect(promptAsyncCount(fake)).toBe(0)
  })

  it("rejects a foreign caller, a foreign workspace, and a non-dispatch session", async () => {
    const clock = createFakeClock()
    const fake = createRespondingFake("chapter one prose", clock)
    const tools = createTools(fake, clock)
    const { sessionID } = await dispatchWriterWithHandle(fake, tools)
    const before = promptAsyncCount(fake)

    // A different caller session cannot reuse the job.
    const foreignCaller = await tools.janus_dispatch_continue.execute(
      { session_id: sessionID, prompt: "apply the review fix" },
      fakeContext({ sessionID: "ses_other_caller" }),
    )
    expect(foreignCaller).toMatch(/^Error: target dispatch session is not owned by this caller/)
    expect(promptAsyncCount(fake)).toBe(before)

    // A session in a different workspace is rejected.
    const foreignWorkspace = await tools.janus_dispatch_continue.execute(
      { session_id: sessionID, prompt: "apply the review fix" },
      fakeContext({ directory: "/tmp/other-project" }),
    )
    expect(foreignWorkspace).toMatch(/^Error: target session belongs to a different workspace/)
    expect(promptAsyncCount(fake)).toBe(before)

    // A non-dispatch session title is rejected.
    const plain = await fake.session.create({
      body: { parentID: "ses_parent", title: "plain chat session" },
      query: { directory: "/tmp/project" },
    })
    const nonDispatch = await tools.janus_dispatch_continue.execute(
      { session_id: plain.data!.id, prompt: "apply the review fix" },
      fakeContext(),
    )
    expect(nonDispatch).toMatch(/^Error: target session is not a dispatch session/)
    expect(promptAsyncCount(fake)).toBe(before)
  })

  it("rejects a missing target session with a clear error", async () => {
    const fake = createFakeSdk()
    const tools = createTools(fake)

    const result = await tools.janus_dispatch_continue.execute(
      { session_id: "ses_missing", prompt: "apply the review fix" },
      fakeContext(),
    )

    expect(result).toMatch(/^Error: target session ses_missing was not found/)
  })

  it("rejects a disabled role target without a new prompt", async () => {
    const clock = createFakeClock()
    const fake = createRespondingFake("chapter one prose", clock)
    const tools = createTools(fake, clock)
    const { sessionID } = await dispatchWriterWithHandle(fake, tools)

    writeFileSync(configPath, JSON.stringify({ author_writer_enabled: false }))
    const before = promptAsyncCount(fake)
    const result = await tools.janus_dispatch_continue.execute(
      { session_id: sessionID, prompt: "apply the review fix" },
      fakeContext(),
    )

    expect(result).toBe("Error: author-writer is disabled by configuration")
    expect(promptAsyncCount(fake)).toBe(before)
  })

  it("rejects a continue onto a disabled author-reviewer session", async () => {
    const clock = createFakeClock()
    const fake = createRespondingFake("review report", clock)
    const tools = createTools(fake, clock)
    const launched = await tools.janus_dispatch.execute(
      { role: "author-reviewer", prompt: "review the drafted chapter", return_handle: true },
      fakeContext(),
    )
    const parsed = parseOutcomeEnvelope(outputText(launched))
    if (!parsed.ok || parsed.value.status !== "completed") {
      throw new Error(`expected completed envelope: ${outputText(launched)}`)
    }
    expect(parsed.value.role).toBe("author-reviewer")

    writeFileSync(configPath, JSON.stringify({ author_reviewer_enabled: false }))
    const before = promptAsyncCount(fake)
    const result = await tools.janus_dispatch_continue.execute(
      { session_id: parsed.value.session_id, prompt: "re-check section two" },
      fakeContext(),
    )

    expect(result).toBe("Error: author-reviewer is disabled by configuration")
    expect(promptAsyncCount(fake)).toBe(before)
  })

  it("rejects untrusted arg fields at the boundary and foreign callers through valid args", async () => {
    const clock = createFakeClock()
    const fake = createRespondingFake("maintenance applied", clock)
    const tools = createTools(fake, clock)
    const { sessionID } = await dispatchWriterWithHandle(fake, tools, "maintenance applied")

    expect(Object.keys(tools.janus_dispatch_continue.args)).toEqual(["session_id", "prompt", "role", "reviews_job_ids"])

    // Unknown arg fields are rejected by the strict args schema before any
    // SDK access or context binding is consulted.
    const maliciousArgs = {
      session_id: sessionID, prompt: "apply the review fix", role: "author-writer" as const,
      parentID: "ses_evil", agent: "evil", model: "evil/model", return_handle: true,
    }
    const rejected = await tools.janus_dispatch_continue.execute(maliciousArgs, { ...fakeContext(), sessionID: "ses_attacker" })
    expect(rejected).toMatch(/^Error: invalid continue args/)
    expect(promptAsyncCount(fake)).toBe(1)

    // With valid args, ownership comes from the tool context, never the args:
    // a foreign caller session cannot reuse this caller's job.
    const foreign = await tools.janus_dispatch_continue.execute(
      { session_id: sessionID, prompt: "apply the review fix" },
      { ...fakeContext(), sessionID: "ses_attacker" },
    )
    expect(foreign).toMatch(/^Error: target dispatch session is not owned by this caller/)
    expect(promptAsyncCount(fake)).toBe(1)
  })

  it("returns a retryable error and prompts nothing when the target session read fails", async () => {
    const clock = createFakeClock()
    const fake = createRespondingFake("chapter one prose", clock)
    const tools = createTools(fake, clock)
    const { sessionID } = await dispatchWriterWithHandle(fake, tools)
    const beforePrompts = promptAsyncCount(fake)
    const beforeCreates = fake.calls.filter((c) => (c as { method: string }).method === "create").length

    fake.setGetResult({ error: { name: "APIError", data: { statusCode: 503 } } })
    const result = await tools.janus_dispatch_continue.execute(
      { session_id: sessionID, prompt: "apply the review fix" },
      fakeContext(),
    )

    expect(result).toContain("failed to read target session:")
    expect(result).toContain(sessionID)
    expect(result).toContain("/tmp/project")
    expect(result).toContain("APIError: 503")
    expect(result).toContain("retry janus_dispatch_continue")
    expect(promptAsyncCount(fake)).toBe(beforePrompts)
    expect(fake.calls.filter((c) => (c as { method: string }).method === "create")).toHaveLength(beforeCreates)
  })

  it("returns a retryable error and prompts nothing when the dispatch journal read fails", async () => {
    const clock = createFakeClock()
    const fake = createRespondingFake("chapter one prose", clock)
    const tools = createTools(fake, clock)
    const { jobID, sessionID } = await dispatchWriterWithHandle(fake, tools)
    const beforePrompts = promptAsyncCount(fake)
    const beforeCreates = fake.calls.filter((c) => (c as { method: string }).method === "create").length

    fake.setChildrenResult({ error: { name: "APIError", data: { statusCode: 503 } } })
    const result = await tools.janus_dispatch_continue.execute(
      { session_id: sessionID, prompt: "apply the review fix" },
      fakeContext(),
    )

    expect(result).toContain("target dispatch journal is temporarily unreadable:")
    expect(result).toContain(jobID)
    expect(result).toContain("/tmp/project")
    expect(result).toContain("retry janus_dispatch_continue")
    expect(result).not.toContain("not owned by this caller")
    expect(promptAsyncCount(fake)).toBe(beforePrompts)
    expect(fake.calls.filter((c) => (c as { method: string }).method === "create")).toHaveLength(beforeCreates)
  })

  it("returns a retryable error and prompts nothing when the target status read fails", async () => {
    const clock = createFakeClock()
    const fake = createRespondingFake("chapter one prose", clock)
    const tools = createTools(fake, clock)
    const { sessionID } = await dispatchWriterWithHandle(fake, tools)
    const beforePrompts = promptAsyncCount(fake)
    const beforeCreates = fake.calls.filter((c) => (c as { method: string }).method === "create").length

    fake.setStatusResult({ error: { name: "APIError", data: { statusCode: 503 } } })
    const result = await tools.janus_dispatch_continue.execute(
      { session_id: sessionID, prompt: "apply the review fix" },
      fakeContext(),
    )

    expect(result).toContain("failed to read target session status:")
    expect(result).toContain(sessionID)
    expect(result).toContain("/tmp/project")
    expect(result).toContain("APIError: 503")
    expect(result).toContain("retry janus_dispatch_continue")
    expect(promptAsyncCount(fake)).toBe(beforePrompts)
    expect(fake.calls.filter((c) => (c as { method: string }).method === "create")).toHaveLength(beforeCreates)
  })

  it("serializes concurrent continues so the second re-checks status before prompting", async () => {
    // given — an owned writer job root and a mutex that records lock attempts
    const clock = createFakeClock()
    const fake = createFakeSdk()
    const created = await createJob(fake, {
      parentID: "ses_parent", directory: "/tmp/project", role: "author-writer",
      agentName: "author-writer", modelChain: ["opencode/claude-sonnet-5-5"],
      prompt: "draft chapter one", clock,
    })
    if (!created.ok) throw created.error
    const targetSessionID = created.value.jobID

    const inner = createKeyedMutex()
    const keys: string[] = []
    const secondQueued = Promise.withResolvers<void>()
    const mutex: KeyedMutex = {
      withLock: (key, fn, signal) => {
        keys.push(key)
        if (keys.filter((candidate) => candidate === `continue:${targetSessionID}`).length === 2) {
          secondQueued.resolve()
        }
        return inner.withLock(key, fn, signal)
      },
    }

    // The first continue sees idle and holds the lock; the second attempt sees
    // busy once the first prompt is in flight.
    let statusCalls = 0
    fake.session.status = async () => {
      statusCalls++
      return { data: { [targetSessionID]: { type: statusCalls === 1 ? "idle" : "busy" } } }
    }

    const entered = Promise.withResolvers<void>()
    const release = Promise.withResolvers<void>()
    let continueCalls = 0
    const lifecycle: DispatchLifecycle = {
      launch: async () => "never called",
      wait: async () => "never called",
      continue: async () => {
        continueCalls++
        entered.resolve()
        await release.promise
        return "first continuation"
      },
    }
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"], { clock, mutex, lifecycle })

    // when — two continues race for the same target session
    const first = tools.janus_dispatch_continue.execute(
      { session_id: targetSessionID, prompt: "apply the first fix" },
      fakeContext(),
    )
    await entered.promise
    const second = tools.janus_dispatch_continue.execute(
      { session_id: targetSessionID, prompt: "apply the second fix" },
      fakeContext(),
    )

    // The second attempt queues on the per-target lock instead of probing status
    // or entering the lifecycle while the first still holds it.
    await secondQueued.promise
    expect(keys.filter((key) => key === `continue:${targetSessionID}`)).toHaveLength(2)
    expect(statusCalls).toBe(1)
    expect(continueCalls).toBe(1)

    release.resolve()
    const [firstResult, secondResult] = await Promise.all([first, second])

    // then — the first completes, the second re-probes and rejects as busy
    expect(firstResult).toBe("first continuation")
    expect(secondResult).toMatch(/^Error: target session is busy; wait for the active job first/)
    expect(statusCalls).toBe(2)
    expect(continueCalls).toBe(1)
  })
})

describe("review seat dispatch guards", () => {
  const savedEnv: Record<string, string | undefined> = {}
  let tmpConfigDir: string
  let configPath: string

  beforeEach(() => {
    savedEnv.JANUS_CONFIG = process.env.JANUS_CONFIG
    savedEnv.HOME = process.env.HOME
    tmpConfigDir = mkdtempSync(join(tmpdir(), "dispatch-guard-"))
    configPath = join(tmpConfigDir, "config.jsonc")
    writeFileSync(configPath, "{}")
    process.env.JANUS_CONFIG = configPath
  })

  afterEach(() => {
    if (savedEnv.JANUS_CONFIG === undefined) delete process.env.JANUS_CONFIG
    else process.env.JANUS_CONFIG = savedEnv.JANUS_CONFIG
    if (savedEnv.HOME === undefined) delete process.env.HOME
    else process.env.HOME = savedEnv.HOME
    rmSync(tmpConfigDir, { recursive: true, force: true })
  })

  /** Seed a dispatch job root in the fake SDK with the given spec. */
  async function seedJobRoot(fake: FakeSdk, spec: JobSpec): Promise<string> {
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

  async function seedCoderJob(fake: FakeSdk, model: string | null): Promise<string> {
    return seedJobRoot(fake, makeJobSpec({ role: "coder", agent_name: "coder", model_chain: [model] }))
  }

  function createCount(fake: FakeSdk): number {
    return fake.calls.filter((c) => (c as { method: string }).method === "create").length
  }

  it("rejects coder-reviewer without reviews_job_ids before any SDK traffic", async () => {
    const fake = createRespondingFake("review")
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])

    const result = await tools.janus_dispatch.execute({ role: "coder-reviewer", prompt: "review the plan" }, fakeContext())

    expect(result).toMatch(/^Error: coder-reviewer requires reviews_job_ids/)
    expect(result).toContain("root job_id")
    expect(promptAsyncCount(fake)).toBe(0)
    expect(createCount(fake)).toBe(0)
  })

  it("rejects coder-reviewer with an empty reviews_job_ids array", async () => {
    const fake = createRespondingFake("review")
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])

    const result = await tools.janus_dispatch.execute(
      { role: "coder-reviewer", prompt: "review the plan", reviews_job_ids: [] },
      fakeContext(),
    )

    expect(result).toMatch(/^Error: coder-reviewer requires reviews_job_ids/)
    expect(promptAsyncCount(fake)).toBe(0)
  })

  it("rejects a coder-reviewer sharing the coder model (same model)", async () => {
    writeFileSync(configPath, JSON.stringify({ coder_reviewer_model: "opencode-go/glm-5.3" }))
    const fake = createRespondingFake("review")
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])
    const coderJobID = await seedCoderJob(fake, "opencode-go/glm-5.3")

    const result = await tools.janus_dispatch.execute(
      { role: "coder-reviewer", prompt: "review the milestone", reviews_job_ids: [coderJobID] },
      fakeContext(),
    )

    expect(result).toContain("model conflict")
    expect(result).toContain("reviewer opencode-go/glm-5.3 vs coder opencode-go/glm-5.3")
    expect(result).toContain(coderJobID)
    expect(result).toContain("coder_reviewer_model")
    expect(result).toContain("tier_models")
    expect(promptAsyncCount(fake)).toBe(0)
    expect(createCount(fake)).toBe(1) // only the seeded coder root
  })

  it("rejects a coder-reviewer in the same family with a different model", async () => {
    // Default reviewer is kimi-k3.1-pro; a kimi-k2 coder is the same Moonshot
    // family under a different model.
    const fake = createRespondingFake("review")
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])
    const coderJobID = await seedCoderJob(fake, "moonshot/kimi-k2")

    const result = await tools.janus_dispatch.execute(
      { role: "coder-reviewer", prompt: "review the milestone", reviews_job_ids: [coderJobID] },
      fakeContext(),
    )

    expect(result).toContain("model conflict")
    expect(result).toContain("reviewer opencode-go/kimi-k3.1-pro vs coder moonshot/kimi-k2")
    expect(promptAsyncCount(fake)).toBe(0)
  })

  it("passes a cross-family coder-reviewer and prompts the reviewer session", async () => {
    writeFileSync(configPath, JSON.stringify({ coder_reviewer_model: "opencode-go/kimi-k3.1-pro" }))
    const fake = createRespondingFake("cross-family review", createFakeClock())
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])
    const coderJobID = await seedCoderJob(fake, "opencode-go/glm-5.3")

    const result = await tools.janus_dispatch.execute(
      { role: "coder-reviewer", prompt: "review the milestone", reviews_job_ids: [coderJobID] },
      fakeContext(),
    )

    expect(result).toBe("cross-family review")
    expect(promptAsyncCount(fake)).toBe(1)
    const body = lastPromptAsyncCall(fake).input.body
    expect(body.agent).toBe("coder-reviewer")
    expect(body.model).toEqual({ providerID: "opencode-go", modelID: "kimi-k3.1-pro" })
  })

  it("rejects a reviewed coder job that pins no model", async () => {
    writeFileSync(configPath, JSON.stringify({ coder_reviewer_model: "opencode-go/kimi-k3.1-pro" }))
    const fake = createRespondingFake("review")
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])
    const coderJobID = await seedCoderJob(fake, null)

    const result = await tools.janus_dispatch.execute(
      { role: "coder-reviewer", prompt: "review the milestone", reviews_job_ids: [coderJobID] },
      fakeContext(),
    )

    expect(result).toMatch(/^Error: /)
    expect(result).toContain("pins no model")
    expect(result).toContain(coderJobID)
    expect(promptAsyncCount(fake)).toBe(0)
  })

  it("rejects reviews_job_ids pointing at a continuation job root and names the original root", async () => {
    const clock = createFakeClock()
    const fake = createRespondingFake("review", clock)
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])
    const coderJobID = await seedCoderJob(fake, "opencode-go/glm-5.3")
    const continuation = await createJob(fake, {
      parentID: "ses_parent", directory: "/tmp/project", role: "coder", agentName: "coder",
      modelChain: ["opencode-go/glm-5.3"], prompt: "more milestone work", clock,
      sessionID: coderJobID, continuedFrom: coderJobID,
    })
    if (!continuation.ok) throw continuation.error

    const result = await tools.janus_dispatch.execute(
      { role: "coder-reviewer", prompt: "review the milestone", reviews_job_ids: [continuation.value.jobID] },
      fakeContext(),
    )

    expect(result).toMatch(/^Error: /)
    expect(result).toContain("continuation job root")
    expect(result).toContain(coderJobID)
    expect(promptAsyncCount(fake)).toBe(0)
  })

  it("rejects reviews_job_ids pointing at an attempt session with a root job_id hint", async () => {
    const fake = createRespondingFake("review")
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])
    const coderJobID = await seedCoderJob(fake, "opencode-go/glm-5.3")
    const attempt = await fake.session.create({
      body: { parentID: coderJobID, title: "[consultation-dispatch:v1] attempt coder" },
      query: { directory: "/tmp/project" },
    })

    const result = await tools.janus_dispatch.execute(
      { role: "coder-reviewer", prompt: "review the milestone", reviews_job_ids: [attempt.data!.id] },
      fakeContext(),
    )

    expect(result).toMatch(/^Error: /)
    expect(result).toContain("root job_id")
    expect(promptAsyncCount(fake)).toBe(0)
  })

  it("rejects reviews_job_ids pointing at a non-coder job", async () => {
    const fake = createRespondingFake("review")
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])
    const consultantJobID = await seedJobRoot(
      fake,
      makeJobSpec({ role: "consultant-analyst", agent_name: "consultant-analyst", model_chain: ["opencode-go/kimi-k3.1-pro"] }),
    )

    const result = await tools.janus_dispatch.execute(
      { role: "coder-reviewer", prompt: "review the milestone", reviews_job_ids: [consultantJobID] },
      fakeContext(),
    )

    expect(result).toMatch(/^Error: /)
    expect(result).toContain("consultant-analyst")
    expect(result).toContain("coder")
    expect(promptAsyncCount(fake)).toBe(0)
  })

  it("rejects solution-reviewer with code_plan_review and no stage", async () => {
    const fake = createRespondingFake("review")
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])

    const result = await tools.janus_dispatch.execute(
      { role: "solution-reviewer", prompt: "review", protocol: "code_plan_review" },
      fakeContext(),
    )

    expect(result).toMatch(/^Error: solution-reviewer with protocol code_plan_review requires stage/)
    expect(result).toContain('"plan"')
    expect(result).toContain('"final"')
    expect(promptAsyncCount(fake)).toBe(0)
  })

  it("rejects stage plan carrying reviews_job_ids, including an empty array", async () => {
    const fake = createRespondingFake("review")
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])
    const coderJobID = await seedCoderJob(fake, "opencode-go/glm-5.3")

    const result = await tools.janus_dispatch.execute(
      { role: "solution-reviewer", prompt: "review the plan", protocol: "code_plan_review", stage: "plan", reviews_job_ids: [coderJobID] },
      fakeContext(),
    )
    expect(result).toContain('stage "plan" must not carry reviews_job_ids')

    const empty = await tools.janus_dispatch.execute(
      { role: "solution-reviewer", prompt: "review the plan", protocol: "code_plan_review", stage: "plan", reviews_job_ids: [] },
      fakeContext(),
    )
    expect(empty).toContain('stage "plan" must not carry reviews_job_ids')
    expect(promptAsyncCount(fake)).toBe(0)
  })

  it("passes stage plan cross-family against the tech-lead and rejects the same family", async () => {
    const fake = createRespondingFake("plan reviewed", createFakeClock())
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])

    // Default config: reviewer claude-sonnet vs tech-lead glm-5.3 — cross-family.
    const ok = await tools.janus_dispatch.execute(
      { role: "solution-reviewer", prompt: "review the plan", protocol: "code_plan_review", stage: "plan" },
      fakeContext(),
    )
    expect(ok).toBe("plan reviewed")
    expect(promptAsyncCount(fake)).toBe(1)

    writeFileSync(configPath, JSON.stringify({ tech_lead_model: "anthropic/claude-opus-5-5" }))
    const rejected = await tools.janus_dispatch.execute(
      { role: "solution-reviewer", prompt: "review the plan", protocol: "code_plan_review", stage: "plan" },
      fakeContext(),
    )
    expect(rejected).toContain("model conflict")
    expect(rejected).toContain("reviewer opencode/claude-sonnet-5-5 vs tech-lead anthropic/claude-opus-5-5")
    expect(rejected).toContain("tech_lead_model")
    expect(promptAsyncCount(fake)).toBe(1) // unchanged: the rejection prompted nothing
  })

  it("rejects stage final without reviews_job_ids", async () => {
    const fake = createRespondingFake("review")
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])

    const result = await tools.janus_dispatch.execute(
      { role: "solution-reviewer", prompt: "review the final diff", protocol: "code_plan_review", stage: "final" },
      fakeContext(),
    )

    expect(result).toContain('stage "final" requires reviews_job_ids')
    expect(promptAsyncCount(fake)).toBe(0)
  })

  it("validates stage final against the tech-lead and every listed coder job", async () => {
    const fake = createRespondingFake("final review", createFakeClock())
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])
    const glmJob = await seedCoderJob(fake, "opencode-go/glm-5.3")
    const haikuJob = await seedCoderJob(fake, "opencode-go/claude-haiku-5-5")

    // A tech-lead conflict rejects even when the coder jobs are cross-family.
    writeFileSync(configPath, JSON.stringify({ tech_lead_model: "anthropic/claude-opus-5-5" }))
    const techLeadConflict = await tools.janus_dispatch.execute(
      { role: "solution-reviewer", prompt: "review the final diff", protocol: "code_plan_review", stage: "final", reviews_job_ids: [glmJob] },
      fakeContext(),
    )
    expect(techLeadConflict).toContain("vs tech-lead anthropic/claude-opus-5-5")

    // Default tech-lead (glm): one same-family coder job rejects the dispatch.
    writeFileSync(configPath, "{}")
    const coderConflict = await tools.janus_dispatch.execute(
      { role: "solution-reviewer", prompt: "review the final diff", protocol: "code_plan_review", stage: "final", reviews_job_ids: [glmJob, haikuJob] },
      fakeContext(),
    )
    expect(coderConflict).toContain("model conflict")
    expect(coderConflict).toContain("reviewer opencode/claude-sonnet-5-5 vs coder opencode-go/claude-haiku-5-5")
    expect(coderConflict).toContain(haikuJob)
    expect(promptAsyncCount(fake)).toBe(0)

    // An all-cross chain passes and prompts the reviewer session.
    const kimiJob = await seedCoderJob(fake, "opencode-go/kimi-k3.1-pro")
    const ok = await tools.janus_dispatch.execute(
      { role: "solution-reviewer", prompt: "review the final diff", protocol: "code_plan_review", stage: "final", reviews_job_ids: [glmJob, kimiJob] },
      fakeContext(),
    )
    expect(ok).toBe("final review")
    expect(promptAsyncCount(fake)).toBe(1)
  })

  it("validates design_premortem against the architect model", async () => {
    const fake = createRespondingFake("pre-mortem done", createFakeClock())
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])

    // Default config: reviewer claude-sonnet vs architect gemini-4-argon — cross-family.
    const ok = await tools.janus_dispatch.execute(
      { role: "solution-reviewer", prompt: "run the pre-mortem", protocol: "design_premortem" },
      fakeContext(),
    )
    expect(ok).toBe("pre-mortem done")
    expect(promptAsyncCount(fake)).toBe(1)

    writeFileSync(configPath, JSON.stringify({ solution_reviewer_model: "opencode-go/gemini-4-argon" }))
    const rejected = await tools.janus_dispatch.execute(
      { role: "solution-reviewer", prompt: "run the pre-mortem", protocol: "design_premortem" },
      fakeContext(),
    )
    expect(rejected).toContain("model conflict")
    expect(rejected).toContain("reviewer opencode-go/gemini-4-argon vs architect opencode-go/gemini-4-argon")
    expect(rejected).toContain("architect_model")
    expect(promptAsyncCount(fake)).toBe(1) // unchanged
  })

  it("rejects stage outside the solution-reviewer code_plan_review combination", async () => {
    const fake = createRespondingFake("review")
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])

    const result = await tools.janus_dispatch.execute(
      { role: "coder-reviewer", prompt: "review the plan", stage: "plan", reviews_job_ids: ["ses_whatever"] },
      fakeContext(),
    )

    expect(result).toContain("stage is only valid for solution-reviewer with protocol code_plan_review")
    expect(promptAsyncCount(fake)).toBe(0)
  })

  it("passes stage through to the lifecycle launch", async () => {
    const captured: LaunchInput[] = []
    const spyLifecycle: DispatchLifecycle = {
      launch: async (input) => {
        captured.push(input)
        return "spy result"
      },
      wait: async () => "never called",
      continue: async () => "never called",
    }
    const fake = createFakeSdk()
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"], { lifecycle: spyLifecycle })

    await tools.janus_dispatch.execute(
      { role: "solution-reviewer", prompt: "review the plan", protocol: "code_plan_review", stage: "plan" },
      fakeContext(),
    )
    await tools.janus_dispatch.execute(
      { role: "solution-reviewer", prompt: "run the pre-mortem", protocol: "design_premortem" },
      fakeContext(),
    )

    expect(captured[0]!.stage).toBe("plan")
    expect(captured[1]!.stage).toBeUndefined()
  })
})

describe("review seat continuation guards", () => {
  const savedEnv: Record<string, string | undefined> = {}
  let tmpConfigDir: string
  let configPath: string

  beforeEach(() => {
    savedEnv.JANUS_CONFIG = process.env.JANUS_CONFIG
    savedEnv.HOME = process.env.HOME
    tmpConfigDir = mkdtempSync(join(tmpdir(), "dispatch-continue-guard-"))
    configPath = join(tmpConfigDir, "config.jsonc")
    writeFileSync(configPath, "{}")
    process.env.JANUS_CONFIG = configPath
  })

  afterEach(() => {
    if (savedEnv.JANUS_CONFIG === undefined) delete process.env.JANUS_CONFIG
    else process.env.JANUS_CONFIG = savedEnv.JANUS_CONFIG
    if (savedEnv.HOME === undefined) delete process.env.HOME
    else process.env.HOME = savedEnv.HOME
    rmSync(tmpConfigDir, { recursive: true, force: true })
  })

  async function seedCoderJob(fake: FakeSdk, model: string | null): Promise<string> {
    const root = await fake.session.create({
      body: { parentID: "ses_parent", title: "[consultation-dispatch:v1] coder" },
      query: { directory: "/tmp/project" },
    })
    if (root.data === undefined) throw new Error("missing seeded root")
    await fake.session.prompt({
      path: { id: root.data.id },
      body: {
        noReply: true,
        messageID: `msg-spec-${root.data.id}`,
        parts: [{
          type: "text",
          text: JSON.stringify(makeJobSpec({ role: "coder", agent_name: "coder", model_chain: [model] })),
          synthetic: true,
          ignored: true,
        }],
      },
      query: { directory: "/tmp/project" },
    })
    return root.data.id
  }

  async function dispatchWithHandle(
    fake: FakeSdk,
    tools: ReturnType<typeof createJanusDispatchTools>,
    args: Record<string, string | string[] | boolean | undefined>,
  ): Promise<{ sessionID: string }> {
    const result = await tools.janus_dispatch.execute({ ...args, return_handle: true } as { role: "coder-reviewer" | "solution-reviewer"; prompt: string; return_handle: true }, fakeContext())
    const parsed = parseOutcomeEnvelope(outputText(result))
    if (!parsed.ok || parsed.value.status !== "completed") {
      throw new Error(`expected completed envelope: ${outputText(result)}`)
    }
    return { sessionID: parsed.value.session_id }
  }

  it("rejects continuing a coder-reviewer session without reviews_job_ids and prompts nothing", async () => {
    const clock = createFakeClock()
    const fake = createRespondingFake("review done", clock)
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"], { clock })
    const glmJob = await seedCoderJob(fake, "opencode-go/glm-5.3")
    const { sessionID } = await dispatchWithHandle(fake, tools, {
      role: "coder-reviewer", prompt: "review the milestone", reviews_job_ids: [glmJob],
    })
    const before = promptAsyncCount(fake)

    const result = await tools.janus_dispatch_continue.execute(
      { session_id: sessionID, prompt: "re-check the diff" },
      fakeContext(),
    )

    expect(result).toMatch(/^Error: coder-reviewer continuation requires reviews_job_ids/)
    expect(promptAsyncCount(fake)).toBe(before)
  })

  it("rejects a continuing coder-reviewer whose ids conflict with the session's pinned model", async () => {
    const clock = createFakeClock()
    const fake = createRespondingFake("review done", clock)
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"], { clock })
    const glmJob = await seedCoderJob(fake, "opencode-go/glm-5.3")
    const { sessionID } = await dispatchWithHandle(fake, tools, {
      role: "coder-reviewer", prompt: "review the milestone", reviews_job_ids: [glmJob],
    })
    const before = promptAsyncCount(fake)

    // The session runs kimi-k3.1-pro (its durable spec): a same-family coder
    // job id conflicts with it even though the ids differ.
    const k2Job = await seedCoderJob(fake, "moonshot/kimi-k2")
    const rejected = await tools.janus_dispatch_continue.execute(
      { session_id: sessionID, prompt: "re-check the diff", reviews_job_ids: [k2Job] },
      fakeContext(),
    )
    expect(rejected).toContain("model conflict")
    expect(rejected).toContain("reviewer opencode-go/kimi-k3.1-pro vs coder moonshot/kimi-k2")
    expect(promptAsyncCount(fake)).toBe(before)

    // The cross-family id keeps passing and the continuation prompts.
    const ok = await tools.janus_dispatch_continue.execute(
      { session_id: sessionID, prompt: "re-check the diff", reviews_job_ids: [glmJob] },
      fakeContext(),
    )
    expect(ok).toBe("review done")
    expect(promptAsyncCount(fake)).toBe(before + 1)
  })

  it("rejects continuing a code_plan_review solution-reviewer session without ids, plan stage included", async () => {
    const clock = createFakeClock()
    const fake = createRespondingFake("plan reviewed", clock)
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"], { clock })
    const glmJob = await seedCoderJob(fake, "opencode-go/glm-5.3")
    const { sessionID } = await dispatchWithHandle(fake, tools, {
      role: "solution-reviewer", prompt: "review the plan", protocol: "code_plan_review", stage: "plan",
    })
    const before = promptAsyncCount(fake)

    // Stage-1 (plan) re-review should be a fresh dispatch; a continuation
    // still requires the full ids discipline, no plan-stage back door.
    const result = await tools.janus_dispatch_continue.execute(
      { session_id: sessionID, prompt: "re-check the plan" },
      fakeContext(),
    )
    expect(result).toMatch(/^Error: solution-reviewer continuation requires reviews_job_ids/)
    expect(promptAsyncCount(fake)).toBe(before)

    // With ids that stay cross-family against the pinned reviewer and the
    // tech-lead, the continuation proceeds.
    const ok = await tools.janus_dispatch_continue.execute(
      { session_id: sessionID, prompt: "scoped re-review", reviews_job_ids: [glmJob] },
      fakeContext(),
    )
    expect(ok).toBe("plan reviewed")
    expect(promptAsyncCount(fake)).toBe(before + 1)
  })

  it("leaves a design_premortem solution-reviewer continuation ungated by ids", async () => {
    const clock = createFakeClock()
    const fake = createRespondingFake("pre-mortem done", clock)
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"], { clock })
    const { sessionID } = await dispatchWithHandle(fake, tools, {
      role: "solution-reviewer", prompt: "run the pre-mortem", protocol: "design_premortem",
    })

    const result = await tools.janus_dispatch_continue.execute(
      { session_id: sessionID, prompt: "one more pre-mortem pass" },
      fakeContext(),
    )

    expect(result).toBe("pre-mortem done")
    expect(promptAsyncCount(fake)).toBe(2)
  })
})
