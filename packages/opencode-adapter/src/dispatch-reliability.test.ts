import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import type { PluginInput, ToolContext } from "@opencode-ai/plugin"
import { createJanusDispatchTool } from "./dispatch-tool.ts"
import { createFakeClock, createFakeSdk, type FakeSdk } from "./dispatch-test-fixtures.ts"
import { PRODUCTION_WAIT_BUDGET_MS, parseOutcomeEnvelope, type Clock, type DispatchEnvelope, type SdkAssistantMessage, type SdkMessageWithParts, type SdkTextPart } from "./dispatch-contract.ts"

describe("consultation dispatch reliability", () => {
  let directory: string
  let previousConfig: string | undefined

  beforeEach(() => {
    previousConfig = process.env.JANUS_CONFIG
    directory = mkdtempSync(join(tmpdir(), "consultation-dispatch-reliability-"))
    process.env.JANUS_CONFIG = join(directory, "config.jsonc")
    writeFileSync(process.env.JANUS_CONFIG, "{}")
  })

  afterEach(() => {
    if (previousConfig === undefined) delete process.env.JANUS_CONFIG
    else process.env.JANUS_CONFIG = previousConfig
    rmSync(directory, { recursive: true, force: true })
  })

  const context: ToolContext = {
    sessionID: "ses_parent",
    messageID: "msg_parent",
    agent: "consultant",
    directory: "/tmp/project",
    worktree: "/tmp/project",
    abort: new AbortController().signal,
    metadata: () => {},
    ask: async () => {},
  }

  function textPart(text: string): SdkTextPart {
    return { type: "text", text }
  }

  function completedAssistantMessage(requestMessageID: string, parts: SdkTextPart[], overrides: Partial<SdkAssistantMessage> = {}): SdkMessageWithParts {
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
      parts,
    }
  }

  function createRespondingFake(responseText: string, clock = createFakeClock()): FakeSdk {
    const fake = createFakeSdk()
    const base = fake.session.promptAsync.bind(fake.session)
    fake.session.promptAsync = async (input) => {
      const result = await base(input)
      const requestMessageID = input.body.messageID!
      const sessionID = input.path.id
      fake.seedMessages(sessionID, [completedAssistantMessage(requestMessageID, [{ type: "text", text: responseText }], { sessionID, id: `msg-reply-${sessionID}` })])
      return result
    }
    return fake
  }

  function promptAsyncCount(fake: FakeSdk): number {
    return fake.calls.filter((c) => (c as { method: string }).method === "promptAsync").length
  }

  function abortCount(fake: FakeSdk): number {
    return fake.calls.filter((c) => (c as { method: string }).method === "abort").length
  }

  function fakeSession(parts: SdkTextPart[]) {
    const clock = createFakeClock()
    const fake = createFakeSdk()
    const base = fake.session.promptAsync.bind(fake.session)
    fake.session.promptAsync = async (input) => {
      const result = await base(input)
      const requestMessageID = input.body.messageID!
      const sessionID = input.path.id
      fake.seedMessages(sessionID, [completedAssistantMessage(requestMessageID, parts, { sessionID, id: `msg-reply-${sessionID}` })])
      return result
    }
    const dispatch = createJanusDispatchTool(fake as unknown as PluginInput["client"], { clock })
    return { dispatch, fake }
  }

  function parseEnvelope(json: string): DispatchEnvelope {
    const parsed = parseOutcomeEnvelope(json)
    if (!parsed.ok) throw new Error(`expected envelope: ${parsed.error.message}`)
    return parsed.value as DispatchEnvelope
  }

  function promptAsyncCalls(fake: FakeSdk): Array<{ input: { body: { agent?: string; model?: { providerID: string; modelID: string }; parts: SdkTextPart[]; messageID?: string } } }> {
    return fake.calls.filter((c): c is { method: "promptAsync"; input: { body: { agent?: string; model?: { providerID: string; modelID: string }; parts: SdkTextPart[]; messageID?: string } } } => {
      return typeof c === "object" && c !== null && (c as { method: string }).method === "promptAsync"
    })
  }

  /** Advance the fake clock until the observed promise settles so a pending
   * observation expires deterministically instead of sleeping forever. Each
   * step yields a real macrotask so the observation chain keeps pace with the
   * clock — a bare `await Promise.resolve()` starves the chain and can leave
   * the observation a few cycles short when the loop ends, hanging the awaited
   * promise forever because nothing advances the clock again. The
   * settle-driven condition plus the bounded cap turns a stalled chain into a
   * visible hang instead of a margin-guessing flake. */
  async function advanceClockTo(clock: Clock & { advance(ms: number): void }, observed: Promise<unknown>): Promise<void> {
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

  for (const scenario of [
    { role: "consultant-critic", config: { consultant_critic_enabled: false } },
    { role: "consultant-auditor", config: { consultant_auditor_enabled: false } },
    { role: "author-writer", config: { author_writer_enabled: false } },
    { role: "author-reviewer", config: { author_reviewer_enabled: false } },
  ] as const) {
    it(`rejects a disabled ${scenario.role} before creating a child session`, async () => {
      writeFileSync(process.env.JANUS_CONFIG ?? "", JSON.stringify(scenario.config))
      const { dispatch, fake } = fakeSession([{ type: "text", text: "should not run" }])

      const result = await dispatch.execute({ role: scenario.role, prompt: "check" }, context)

      expect(result).toBe(`Error: ${scenario.role} is disabled by configuration`)
      expect(promptAsyncCount(fake)).toBe(0)
    })
  }

  it("uses an explicitly delegated writer even when the bundled writer is disabled", async () => {
    writeFileSync(process.env.JANUS_CONFIG ?? "", JSON.stringify({
      author_writer_enabled: false,
      writer_delegate_agent: "host-writer",
    }))
    const fake = createRespondingFake("usable manuscript")
    const tool = createJanusDispatchTool(fake as unknown as PluginInput["client"], { clock: createFakeClock() })

    const result = await tool.execute({ role: "author-writer", prompt: "draft" }, context)

    expect(result).toBe("usable manuscript")
    const calls = fake.calls.filter((c) => (c as { method: string }).method === "promptAsync")
    expect(calls.some((c) => (c as { input: { body: { agent?: string } } }).input.body.agent === "host-writer")).toBe(true)
  })

  for (const scenario of [
    { name: "no parts", parts: [] as SdkTextPart[] },
    { name: "blank text", parts: [{ type: "text", text: "   \n " }] },
    { name: "only non-text parts", parts: [{ type: "reasoning", text: "hidden" } as unknown as SdkTextPart] },
  ]) {
    it(`reports ${scenario.name} as unknown specialist output`, async () => {
      const { dispatch, fake } = fakeSession(scenario.parts as SdkTextPart[])

      const result = (await dispatch.execute({ role: "consultant-analyst", prompt: "analyze evidence" }, context)) as string

      const envelope = parseEnvelope(result)
      expect(envelope.status).toBe("unknown")
      expect(promptAsyncCalls(fake)).toHaveLength(1)
      expect(fake.calls.filter((c) => (c as { method: string }).method === "abort")).toHaveLength(0)
    })
  }

  it("preserves usable text from a completed child", async () => {
    const { dispatch } = fakeSession([{ type: "text", text: "finding with source" }])

    const result = await dispatch.execute({ role: "consultant-analyst", prompt: "analyze evidence" }, context)

    expect(result).toBe("finding with source")
  })

  it("returns a nonterminal envelope and zero aborts when the soft window expires", async () => {
    const clock = createFakeClock()
    const fake = createFakeSdk()
    fake.setPromptAsyncResult({ data: undefined })
    const dispatch = createJanusDispatchTool(fake as unknown as PluginInput["client"], { clock })

    const promise = dispatch.execute({ role: "consultant-analyst", prompt: "analyze evidence" }, context)
    await advanceClockTo(clock, promise)
    const result = (await promise) as string

    const envelope = parseEnvelope(result)
    expect(envelope.status).toMatch(/pending|unknown/)
    expect(envelope.job_id).toMatch(/^ses_fake_/)
    expect(envelope.next).toBe("janus_dispatch_wait")
    expect(abortCount(fake)).toBe(0)
    expect(promptAsyncCount(fake)).toBe(1)
  })
})
