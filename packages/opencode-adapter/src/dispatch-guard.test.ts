import { describe, expect, it } from "bun:test"

import { JanusPluginConfigSchema, MODEL_DEFAULTS, resolveRoleModelChain, type ModelRole } from "./plugin-config.ts"
import { resolveModelFamily, readCallerContextTokens, CONTEXT_WATERMARK_TOKENS, CODER_HARD_CEILING_TOKENS, CALLER_CONTEXT_MESSAGES_LIMIT } from "./dispatch-guard.ts"
import { createFakeSdk, type FakeSdk } from "./dispatch-test-fixtures.ts"
import type { DispatchSdk, SdkAssistantMessage, SdkMessageWithParts } from "./dispatch-contract.ts"

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
