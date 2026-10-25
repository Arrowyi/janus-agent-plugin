import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import type { PluginInput, ToolContext } from "@opencode-ai/plugin"

import { createJanusDispatchTool, createJanusDispatchTools, resolveRoleTarget, splitModel } from "./dispatch-tool.ts"
import { appendRecord, createAttemptSession, createJob } from "./dispatch-journal.ts"
import { JanusPluginConfigSchema, type JanusPluginConfig } from "./plugin-config.ts"
import { createFakeClock, createFakeSdk, type FakeSdk } from "./dispatch-test-fixtures.ts"
import { parseOutcomeEnvelope, PRODUCTION_WAIT_BUDGET_MS, type DispatchEnvelope, type SdkAssistantMessage, type SdkMessageWithParts, type SdkTextPart } from "./dispatch-contract.ts"
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

/** Advance the fake clock past the 300000 ms soft wait budget so a pending
 * observation expires deterministically instead of sleeping forever. */
async function exhaustBudget(clock: ReturnType<typeof createFakeClock>): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0))
  for (let i = 0; i < 160; i++) {
    await Promise.resolve()
    clock.advance(2_000)
  }
}

describe("resolveRoleTarget", () => {
  it("maps each role to its own agent and default model", () => {
    const explorer = resolveRoleTarget(config(), "explorer")
    const analyst = resolveRoleTarget(config(), "analyst")
    const critic = resolveRoleTarget(config(), "critic")
    const verifier = resolveRoleTarget(config(), "verifier")
    const writer = resolveRoleTarget(config(), "writer")

    expect(explorer).toEqual({ agentName: "consultation-explorer", model: "opencode-go/deepseek-v4.1-flash" })
    expect(analyst).toEqual({ agentName: "consultation-analyst", model: "opencode-go/qwen3.8-max" })
    expect(critic).toEqual({ agentName: "consultation-critic", model: "opencode/gemini-3.8-flash" })
    expect(verifier).toEqual({ agentName: "consultation-verifier", model: "opencode/gemini-3.8-flash" })
    expect(writer).toEqual({ agentName: "consultation-writer", model: "opencode/claude-sonnet-5-5" })
    const coder = resolveRoleTarget(config(), "coder")
    expect(coder).toEqual({ agentName: "coder", model: "opencode-go/glm-5.3" })
    const lite = resolveRoleTarget(config(), "lite")
    expect(lite).toEqual({ agentName: "lite", model: "opencode-go/deepseek-v4.1-flash" })
    const coderLite = resolveRoleTarget(config(), "coder-lite")
    expect(coderLite).toEqual({ agentName: "coder-lite", model: "opencode-go/glm-5.3-flash" })
    const build = resolveRoleTarget(config(), "build")
    expect(build).toEqual({ agentName: "build", model: undefined })
    const consultant = resolveRoleTarget(config(), "consultant")
    expect(consultant).toEqual({ agentName: "consultant", model: "opencode-go/glm-5.3" })
  })

  it("resolves a renamed lite agent", () => {
    const cfg = config({ lite_agent: "my-lite", lite_model: "test/lite" })
    expect(resolveRoleTarget(cfg, "lite")).toEqual({ agentName: "my-lite", model: "test/lite" })
  })

  it("routes the build role to the configured host agent and pins its model only when set", () => {
    const cfg = config({ build_agent: "host-build", build_model: "p/build-m" })
    expect(resolveRoleTarget(cfg, "build")).toEqual({ agentName: "host-build", model: "p/build-m" })
    const unpinned = config({ build_agent: "host-build" })
    expect(resolveRoleTarget(unpinned, "build")).toEqual({ agentName: "host-build", model: undefined })
  })

  it("routes the writer to a delegate agent without pinning a model by default", () => {
    const cfg = config({ writer_delegate_agent: "host-writer" })
    expect(resolveRoleTarget(cfg, "writer")).toEqual({ agentName: "host-writer", model: undefined })
  })

  it("pins the delegate model only when writer_delegate_model is set", () => {
    const cfg = config({ writer_delegate_agent: "host-writer", writer_delegate_model: "p/m" })
    expect(resolveRoleTarget(cfg, "writer")).toEqual({ agentName: "host-writer", model: "p/m" })
  })

  it("honors model overrides", () => {
    const cfg = config({ analyst_model: "test/analyst" })
    expect(resolveRoleTarget(cfg, "analyst")).toEqual({ agentName: "consultation-analyst", model: "test/analyst" })
  })

  it("resolves the configured writer target", () => {
    const cfg = config({ writer_agent: "custom-writer", writer_model: "provider/writer-model" })
    expect(resolveRoleTarget(cfg, "writer")).toEqual({ agentName: "custom-writer", model: "provider/writer-model" })
  })
})

describe("splitModel", () => {
  it("splits provider/model on the first slash", () => {
    expect(splitModel("deepseek/deepseek-v4.1-flash")).toEqual({ providerID: "deepseek", modelID: "deepseek-v4.1-flash" })
    expect(splitModel("opencode-go/qwen3.8-max")).toEqual({ providerID: "opencode-go", modelID: "qwen3.8-max" })
  })

  it("throws on a model id without a provider separator", () => {
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
        explorer_model: "provider-a/explorer-m",
        analyst_model: "provider-b/analyst-m",
        critic_model: "provider-c/critic-m",
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

    const result = await dispatchTool.execute({ role: "analyst", prompt: "analyze claims" }, fakeContext())

    expect(result).toBe("the analyst result")
    expect(promptAsyncCount(fake)).toBe(1)
    expect(abortCount(fake)).toBe(0)

    const createCall = fake.calls.find((c) => (c as { method: string }).method === "create") as { input: { body: { parentID?: string }; query: { directory?: string } } }
    expect(createCall.input.body.parentID).toBe("ses_parent")
    expect(createCall.input.query.directory).toBe("/tmp/project")

    const prompt = lastPromptAsyncCall(fake)
    expect(prompt.input.path.id).toMatch(/^ses_fake_/)
    expect(prompt.input.body.agent).toBe("consultation-analyst")
    expect(prompt.input.body.model).toEqual({ providerID: "provider-b", modelID: "analyst-m" })
    expect(prompt.input.body.parts).toEqual([{ type: "text", text: "analyze claims" }])
  })

  it("returns a clear error string when session create fails", async () => {
    const fake = createFakeSdk()
    fake.session.create = async () => ({ error: "boom", data: undefined })
    const dispatchTool = createJanusDispatchTool(fake as unknown as PluginInput["client"], { clock: createFakeClock() })

    const result = await dispatchTool.execute({ role: "critic", prompt: "challenge" }, fakeContext())

    expect(result).toContain("failed to create job")
    expect(result).toContain("unrecognized provider error")
    expect(result).not.toContain("boom")
  })

  it("returns a clear error string when promptAsync fails", async () => {
    const fake = createFakeSdk()
    fake.setPromptAsyncError({ status: 500, message: "model auth failed" })
    const dispatchTool = createJanusDispatchTool(fake as unknown as PluginInput["client"], { clock: createFakeClock() })

    const result = await dispatchTool.execute({ role: "explorer", prompt: "search" }, fakeContext())

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

    const result = await dispatchTool.execute({ role: "writer", prompt: "blueprint" }, fakeContext())

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

    const result = await dispatchTool.execute({ role: "writer", prompt: "blueprint" }, fakeContext())

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

    const result = await dispatchTool.execute({ role: "writer", prompt: "blueprint" }, fakeContext())

    expect(result).toContain("writer dispatch failed")
    expect(promptAsyncCount(fake)).toBe(1)
  })

  it("dispatches a delegated writer without pinning a model", async () => {
    writeFileSync(configPath, JSON.stringify({ writer_delegate_agent: "host-writer" }))
    const clock = createFakeClock()
    const fake = createRespondingFake("host wrote it", clock)
    const dispatchTool = createJanusDispatchTool(fake as unknown as PluginInput["client"], { clock })

    const result = await dispatchTool.execute({ role: "writer", prompt: "blueprint" }, fakeContext())

    expect(result).toBe("host wrote it")
    expect(promptAsyncCount(fake)).toBe(1)
    const prompt = lastPromptAsyncCall(fake)
    expect(prompt.input.body.agent).toBe("host-writer")
    expect(prompt.input.body.model).toBeUndefined()
  })

  it("rejects the lite role when lite_enabled=false", async () => {
    // given
    const tmpConfigDir = mkdtempSync(join(tmpdir(), "dispatch-liteoff-"))
    const configPath = join(tmpConfigDir, "config.jsonc")
    writeFileSync(configPath, '{\n  "lite_enabled": false\n}')
    process.env.JANUS_CONFIG = configPath
    const tools = createJanusDispatchTools(createFakeSdk() as unknown as PluginInput["client"])

    try {
      // when
      const result = await tools.janus_dispatch.execute({ role: "lite", prompt: "quick lookup" }, fakeContext())

      // then
      expect(result).toBe("Error: lite is disabled by configuration")
    } finally {
      delete process.env.JANUS_CONFIG
      rmSync(tmpConfigDir, { recursive: true, force: true })
    }
  })

  it("launches coder-lite with the configured agent and model", async () => {
    // given
    const tmpConfigDir = mkdtempSync(join(tmpdir(), "dispatch-cl-"))
    const configPath = join(tmpConfigDir, "config.jsonc")
    writeFileSync(configPath, JSON.stringify({ coder_lite_agent: "custom-lite", coder_lite_model: "custom/glm-flash" }))
    process.env.JANUS_CONFIG = configPath
    const fake = createRespondingFake("done")
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])

    try {
      // when
      const result = await tools.janus_dispatch.execute({ role: "coder-lite", prompt: "rename A to B" }, fakeContext())

      // then
      const body = lastPromptAsyncCall(fake).input.body
      expect(body.agent).toBe("custom-lite")
      expect(body.model).toEqual({ providerID: "custom", modelID: "glm-flash" })
      expect(result).toBe("done")
    } finally {
      delete process.env.JANUS_CONFIG
      rmSync(tmpConfigDir, { recursive: true, force: true })
    }
  })

  it("launches the build role against the host agent without a pinned model", async () => {
    // given
    const fake = createRespondingFake("done")
    const tools = createJanusDispatchTools(fake as unknown as PluginInput["client"])

    // when
    const result = await tools.janus_dispatch.execute({ role: "build", prompt: "refactor X" }, fakeContext())

    // then
    const body = lastPromptAsyncCall(fake).input.body
    expect(body.agent).toBe("build")
    expect(body.model).toBeUndefined()
    expect(result).toBe("done")
  })

  it("uses the production 300000 ms wait budget at the tool boundary", async () => {
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

    await dispatchTool.execute({ role: "analyst", prompt: "analyze evidence" }, fakeContext())

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

    await dispatchTool.execute({ role: "writer", prompt: "draft", return_handle: true }, fakeContext())

    expect(captured[0]!.returnHandle).toBe(true)
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

    const result = await dispatchTool.execute({ role: "writer", prompt: "draft chapter one", return_handle: true }, fakeContext())

    const parsed = parseOutcomeEnvelope(outputText(result))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) throw parsed.error
    expect(parsed.value.status).toBe("completed")
    if (parsed.value.status !== "completed") throw new Error("expected completed envelope")
    expect(parsed.value.role).toBe("writer")
    expect(parsed.value.job_id).toMatch(/^ses_fake_/)
    expect(parsed.value.session_id).toMatch(/^ses_fake_/)
    expect(parsed.value.attempt.index).toBe(0)
    expect(parsed.value.text).toBe("the writer result")
  })

  it("keeps plain text as the default success result without return_handle", async () => {
    const fake = createRespondingFake("plain writer result")
    const dispatchTool = createJanusDispatchTool(fake as unknown as PluginInput["client"])

    const result = await dispatchTool.execute({ role: "writer", prompt: "draft chapter one" }, fakeContext())

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
      { role: "writer", prompt: "draft chapter one", return_handle: true },
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
    expect(asyncs[1]!.input.body.agent).toBe("consultation-writer")
    expect(asyncs[1]!.input.body.parts).toEqual([{ type: "text", text: "apply the review fix to chapter one" }])
    // A continuation job root was created under the caller, with the reuse journaled.
    const creates = fake.calls.filter((c) => (c as { method: string }).method === "create") as Array<{ input: { body: { title: string; parentID: string } } }>
    expect(creates).toHaveLength(2)
    expect(creates[1]!.input.body.title).toBe("[consultation-dispatch:v1] writer")
    expect(creates[1]!.input.body.parentID).toBe("ses_parent")
  })

  it("continues an attempt-child session of a normal job root", async () => {
    // The tool always resolves a single-model chain, so a retry attempt child
    // is constructed directly through the journal (two-model spec).
    const clock = createFakeClock()
    const fake = createFakeSdk()
    const { jobID, attemptSessionID } = await (async () => {
      const created = await createJob(fake, {
        parentID: "ses_parent", directory: "/tmp/project", role: "writer",
        agentName: "consultation-writer", modelChain: ["opencode/claude-sonnet-5-5", "opencode-go/glm-5.3"],
        prompt: "draft chapter one", clock,
      })
      if (!created.ok) throw created.error
      const jobID = created.value.jobID
      const child = await createAttemptSession(fake, { jobID, directory: "/tmp/project", role: "writer" })
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
    expect(creates.at(-1)!.input.body.title).toBe("[consultation-dispatch:v1] writer")
    expect(creates.at(-1)!.input.body.parentID).toBe("ses_parent")
    expect(jobID).toMatch(/^ses_fake_/)
  })

  it("returns a pending envelope carrying the continuation job id and the target session id", async () => {
    const clock = createFakeClock()
    const fake = createFakeSdk()
    fake.setPromptAsyncResult({ data: undefined })
    const tools = createTools(fake, clock)

    const firstResult = await (async () => {
      const launched = tools.janus_dispatch.execute({ role: "writer", prompt: "draft chapter one" }, fakeContext())
      await exhaustBudget(clock)
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
      await exhaustBudget(clock)
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
      { role: "analyst", prompt: "analyze the evidence", return_handle: true },
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
      { session_id: sessionID, prompt: "re-analyze", role: "writer" },
      fakeContext(),
    )
    expect(mismatch).toMatch(/^Error: role writer does not match/)
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

    writeFileSync(configPath, JSON.stringify({ writer_enabled: false }))
    const before = promptAsyncCount(fake)
    const result = await tools.janus_dispatch_continue.execute(
      { session_id: sessionID, prompt: "apply the review fix" },
      fakeContext(),
    )

    expect(result).toBe("Error: writer is disabled by configuration")
    expect(promptAsyncCount(fake)).toBe(before)
  })

  it("rejects untrusted arg fields at the boundary and foreign callers through valid args", async () => {
    const clock = createFakeClock()
    const fake = createRespondingFake("maintenance applied", clock)
    const tools = createTools(fake, clock)
    const { sessionID } = await dispatchWriterWithHandle(fake, tools, "maintenance applied")

    expect(Object.keys(tools.janus_dispatch_continue.args)).toEqual(["session_id", "prompt", "role"])

    // Unknown arg fields are rejected by the strict args schema before any
    // SDK access or context binding is consulted.
    const maliciousArgs = {
      session_id: sessionID, prompt: "apply the review fix", role: "writer" as const,
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
})
