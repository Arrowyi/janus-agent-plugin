import { describe, expect, it } from "bun:test"
import { existsSync, mkdtempSync, readdirSync, realpathSync, rmSync } from "node:fs"
import { readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  registerConsultantAgent,
  registerConsultationCritic,
  registerExplorer,
  registerAnalyst,
  registerVerifier,
  registerWriter,
  registerCoder,
  registerLite,
  registerCoderLite,
  registerJanus,
  buildRuntimeBindings,
  buildLiteRuntimeBindings,
  buildJanusRuntimeBindings,
  buildLitePermission,
  buildCoderLitePermission,
  buildWriterPermission,
  buildWriterRuntimeBindings,
  computeProjectId,
  resolveAuthorStateDir,
  resolveLiteWorkspaceDir as resolveLiteWorkspaceDirLocal,
  injectRuntimeBindings,
  injectModelPrompt,
  injectCommonPrinciples,
  loadCommonPrinciples,
  resolveModelPrompt,
  normalizeModelKey,
} from "./agent-registration.ts"
import { resolveAsset } from "./asset-paths.ts"
import type { JanusPluginConfig } from "./plugin-config.ts"

function makeConfig(overrides: Partial<JanusPluginConfig> = {}): JanusPluginConfig {
  return {
    install_skill: true,
    install_commands: true,
    memory_enabled: true,
    critic_agent: "consultation-critic",
    critic_enabled: true,
    explorer_agent: "consultation-explorer",
    analyst_agent: "consultation-analyst",
    verifier_agent: "consultation-verifier",
    verifier_enabled: true,
    writer_agent: "consultation-writer",
    writer_enabled: true,
    writer_docs_roots: ["userdoc"],
    coder_agent: "coder",
    coder_enabled: true,
    lite_agent: "lite",
    lite_enabled: true,
    coder_lite_agent: "coder-lite",
    coder_lite_enabled: true,
    build_agent: "build",
    build_enabled: true,
    janus_agent: "janus",
    janus_enabled: true,
    ...overrides,
  }
}

describe("buildRuntimeBindings", () => {
  it("includes the memory MCP server line with tool names when memory is enabled", () => {
    // given
    const config = makeConfig({ memory_enabled: true })

    // when
    const block = buildRuntimeBindings(config, "oc-abcdef123456")

    // then
    expect(block).toContain("## Runtime Bindings (injected by opencode-adapter)")
    expect(block).toContain("janus-memory")
    expect(block).toContain("memory_recall")
    expect(block).toContain("memory_expand")
    expect(block).toContain("memory_prepare")
    expect(block).toContain("memory_commit")
    expect(block).toContain("memory_manage")
  })

  it("includes the namespace line", () => {
    // given
    const config = makeConfig()

    // when
    const block = buildRuntimeBindings(config, "oc-abcdef123456")

    // then
    expect(block).toContain("oc-abcdef123456")
    expect(block).toContain("Memory namespace")
  })

  it("says Memory DISABLED when memory_enabled is false", () => {
    // given
    const config = makeConfig({ memory_enabled: false })

    // when
    const block = buildRuntimeBindings(config, "oc-ns")

    // then
    expect(block).toContain("Memory: DISABLED by configuration (saving and recall are unavailable)")
    expect(block).not.toContain("janus-memory")
  })

  it("includes the critic subagent name and model line when critic is enabled", () => {
    // given
    const config = makeConfig({ critic_model: "openrouter/qwen-max" })

    // when
    const block = buildRuntimeBindings(config, "oc-ns")

    // then
    expect(block).toContain("critic `consultation-critic`")
    expect(block).toContain("openrouter/qwen-max")
  })

  it("reports the default critic model when critic_model is unset", () => {
    // given
    const config = makeConfig()

    // when
    const block = buildRuntimeBindings(config, "oc-ns")

    // then
    expect(block).toContain("opencode/gemini-3.8-flash")
  })

  it("reports the consultant and team role models", () => {
    // given
    const config = makeConfig()

    // when
    const block = buildRuntimeBindings(config, "oc-ns")

    // then
    expect(block).toContain("Consultant model")
    expect(block).toContain("opencode-go/glm-5.3")
    expect(block).toContain("Team subagents")
    expect(block).toContain("consultation-explorer")
    expect(block).toContain("opencode-go/deepseek-v4.1-flash")
    expect(block).toContain("consultation-analyst")
    expect(block).toContain("opencode-go/qwen3.8-max")
  })

  it("reports the default team caps, tier matrix, and cost guard", () => {
    // given
    const config = makeConfig()

    // when
    const block = buildRuntimeBindings(config, "oc-ns")

    // then
    expect(block).toContain("round_cap=3")
    expect(block).toContain("explorer<=5")
    expect(block).toContain("critic_searches<=5")
    expect(block).toContain("fast(e5,a0,c0,v0,w0)")
    expect(block).toContain("standard(e5,a1,c1,v1,w1)")
    expect(block).toContain("deep(e5,a3,c2,v2,w2)")
    expect(block).toContain("~$10 per provider")
  })

  it("reports overridden team caps and cost guard", () => {
    // given
    const config = makeConfig({
      team_caps: { round_cap: 2, explorer_cap: 3, critic_search_cap: 4 },
      cost_guard_provider_usd: 7,
    })

    // when
    const block = buildRuntimeBindings(config, "oc-ns")

    // then
    expect(block).toContain("round_cap=2")
    expect(block).toContain("explorer<=3")
    expect(block).toContain("critic_searches<=4")
    expect(block).toContain("~$7 per provider")
  })

  it("reports overridden tier role caps", () => {
    // given
    const config = makeConfig({
      tier_role_caps: {
        fast: { explorer: 5, analyst: 0, critic: 0, verifier: 0, writer: 0 },
        standard: { explorer: 5, analyst: 2, critic: 1, verifier: 1, writer: 0 },
        deep: { explorer: 5, analyst: 4, critic: 3, verifier: 2, writer: 0 },
      },
    })

    // when
    const block = buildRuntimeBindings(config, "oc-ns")

    // then
    expect(block).toContain("standard(e5,a2,c1,v1,w0)")
    expect(block).toContain("deep(e5,a4,c3,v2,w0)")
  })

  it("says critic DISABLED when critic_enabled is false", () => {
    // given
    const config = makeConfig({ critic_enabled: false })

    // when
    const block = buildRuntimeBindings(config, "oc-ns")

    // then
    expect(block).toContain("critic DISABLED by configuration")
  })

  it("reports writer enabled state in team subagents", () => {
    // given
    const config = makeConfig({ writer_model: "test/writer-model" })

    // when
    const block = buildRuntimeBindings(config, "oc-ns")

    // then
    expect(block).toContain("writer `consultation-writer` (test/writer-model)")
  })

  it("says writer DISABLED when writer_enabled is false", () => {
    // given
    const config = makeConfig({ writer_enabled: false })

    // when
    const block = buildRuntimeBindings(config, "oc-ns")

    // then
    expect(block).toContain("writer DISABLED by configuration")
  })

  it("reports the lite leaf and coder delegate lines with their DISABLED states", () => {
    // given
    const config = makeConfig()

    // when
    const block = buildRuntimeBindings(config, "oc-ns")

    // then
    expect(block).toContain("Economical leaf: `lite` (`opencode-go/deepseek-v4.1-flash`)")
    expect(block).toContain("Coding delegate: `coder` (`opencode-go/glm-5.3`)")

    // given
    const disabled = makeConfig({ lite_enabled: false, coder_enabled: false })

    // when
    const disabledBlock = buildRuntimeBindings(disabled, "oc-ns")

    // then
    expect(disabledBlock).toContain("Economical leaf: lite DISABLED by configuration")
    expect(disabledBlock).toContain("Coding delegate: coder DISABLED by configuration")
  })

  it("reports the scoped writer write mode with the effective roots", () => {
    // given
    const config = makeConfig({ writer_docs_roots: ["./docs/guides/", "userdoc"] })

    // when
    const block = buildRuntimeBindings(config, "oc-ns")

    // then
    expect(block).toContain("Writer write mode: `scoped`")
    expect(block).toContain("`docs/guides`")
    expect(block).toContain("`userdoc`")
    expect(block).toContain("sole author of reader-facing prose")
    expect(block).toContain("you do not edit those roots in scoped mode")
  })

  it("reports the read-only writer fallback when writer_docs_roots is empty", () => {
    // given
    const config = makeConfig({ writer_docs_roots: [] })

    // when
    const block = buildRuntimeBindings(config, "oc-ns")

    // then
    expect(block).toContain("Writer write mode: `read-only`")
    expect(block).toContain("you apply and publish the returned text as the disclosed publisher")
  })

  it("includes the author state dir, project id, and brief path when an author binding is supplied", () => {
    // given
    const config = makeConfig()

    // when
    const block = buildRuntimeBindings(config, "oc-ns", {
      authorStateDir: "/xdg/data/janus-agent/author",
      projectId: "my-project-a1b2c3d4",
    })

    // then
    expect(block).toContain("Author state dir: `/xdg/data/janus-agent/author`")
    expect(block).toContain("project id: `my-project-a1b2c3d4`")
    expect(block).toContain("/xdg/data/janus-agent/author/my-project-a1b2c3d4/<docId>/brief.md")
    expect(block).toContain("the writer reads it and never writes it")
  })

  it("omits the author lines when no author binding is supplied", () => {
    // given
    const config = makeConfig()

    // when
    const block = buildRuntimeBindings(config, "oc-ns")

    // then
    expect(block).not.toContain("Author state dir")
    expect(block.endsWith("Memory namespace: `oc-ns`")).toBe(true)
  })
})

describe("injectRuntimeBindings", () => {
  it("replaces the RUNTIME-BINDINGS placeholder comment when present", () => {
    // given
    const body = "## Runtime Bindings\n\n<!-- RUNTIME-BINDINGS: do not edit. -->\n"
    const block = "## Runtime Bindings (injected)\n- stuff"

    // when
    const result = injectRuntimeBindings(body, block)

    // then
    expect(result).not.toContain("RUNTIME-BINDINGS:")
    expect(result).not.toContain("<!--")
    expect(result).toContain("## Runtime Bindings (injected)")
    expect(result).toContain("- stuff")
  })

  it("appends the block at the end when no placeholder is present", () => {
    // given
    const body = "# Consultant\n\nSome content without placeholder."
    const block = "## Runtime Bindings (injected)\n- stuff"

    // when
    const result = injectRuntimeBindings(body, block)

    // then
    expect(result).toContain("Some content without placeholder.")
    expect(result).toContain("## Runtime Bindings (injected)")
    expect(result.endsWith("## Runtime Bindings (injected)\n- stuff")).toBe(true)
  })
})

describe("injectModelPrompt", () => {
  it("replaces the MODEL-PROMPT placeholder when a block resolves", () => {
    // given
    const body = "# Agent\n\n## Role\n\nstuff\n\n<!-- MODEL-PROMPT: injected by the adapter. -->\n"
    // when
    const result = injectModelPrompt(body, "clamp formatting")
    // then
    expect(result).not.toContain("<!-- MODEL-PROMPT")
    expect(result).toContain("clamp formatting")
    expect(result).toContain("# Agent")
  })

  it("returns the body byte-identical when the block is empty", () => {
    // given
    const body = "# Agent\n\n<!-- MODEL-PROMPT: injected by the adapter. -->\n"
    // when
    const result = injectModelPrompt(body, "")
    // then
    expect(result).toBe(body)
  })

  it("appends a Driving This Model section when no placeholder exists", () => {
    // given
    const body = "# Agent\n\n## Role\n\nstuff"
    // when
    const result = injectModelPrompt(body, "drive carefully")
    // then
    expect(result).toContain("# Agent")
    expect(result).toContain("## Driving This Model")
    expect(result).toContain("drive carefully")
  })
})

describe("loadCommonPrinciples", () => {
  it("reads the shared common principles asset", async () => {
    // given // when
    const block = await loadCommonPrinciples()

    // then
    expect(block).toContain("## Common Operating Principles")
    expect(block).toContain("### File Change Confirmation")
    expect(block).toContain("persistent file change")
    expect(block).toContain("return the proposed file list and reasons to the dispatcher and stop")
  })
})

describe("injectCommonPrinciples", () => {
  it("returns the body byte-identical when the block is empty or whitespace", () => {
    // given
    const body = "# Agent\n\n## Role\n\nstuff\n"

    // when // then
    expect(injectCommonPrinciples(body, "")).toBe(body)
    expect(injectCommonPrinciples(body, "   \n")).toBe(body)
  })

  it("appends the trimmed block after the body", () => {
    // given
    const body = "# Agent\n\n## Role\n\nstuff\n"
    const block = "## Common Operating Principles\n\n### File Change Confirmation\n\ngate text\n"

    // when
    const result = injectCommonPrinciples(body, block)

    // then
    expect(result).toBe(`${body}\n\n## Common Operating Principles\n\n### File Change Confirmation\n\ngate text`)
  })
})

describe("normalizeModelKey", () => {
  it("strips the provider, lowercases, and keeps only alphanumerics", () => {
    // given // when // then
    expect(normalizeModelKey("opencode-go/deepseek-v4.1-flash")).toBe("deepseekv41flash")
    expect(normalizeModelKey("deepseek/deepseek-v4-pro")).toBe("deepseekv4pro")
    expect(normalizeModelKey("opencode-go/deepseek-v4-pro")).toBe("deepseekv4pro")
    expect(normalizeModelKey("opencode/claude-sonnet-5-5")).toBe("claudesonnet55")
    expect(normalizeModelKey("DeepSeek-V4-Pro")).toBe("deepseekv4pro")
  })
})

describe("resolveModelPrompt", () => {
  it("returns the user global map entry for the normalized model key", async () => {
    // given
    const config = makeConfig({ model_prompts: { glm53: "user block" } })

    // when // then
    expect(await resolveModelPrompt(config, "opencode-go/glm-5.3")).toBe("user block")
  })

  it("matches the same block across providers", async () => {
    // given
    const config = makeConfig({ model_prompts: { deepseekv4pro: "shared deepseek block" } })

    // when // then
    expect(await resolveModelPrompt(config, "deepseek/deepseek-v4-pro")).toBe("shared deepseek block")
    expect(await resolveModelPrompt(config, "opencode-go/deepseek-v4-pro")).toBe("shared deepseek block")
  })

  it("returns empty when the user entry is an explicit disable", async () => {
    // given
    const config = makeConfig({ model_prompts: { glm53: "" } })

    // when // then
    expect(await resolveModelPrompt(config, "opencode-go/glm-5.3")).toBe("")
  })

  it("returns empty for a model with no user entry and no shipped block file", async () => {
    // given
    const config = makeConfig()

    // when // then
    expect(await resolveModelPrompt(config, "no-such/model")).toBe("")
  })

  it("loads the shipped block file for a default model with no user entry", async () => {
    // given
    const config = makeConfig()

    // when
    const block = await resolveModelPrompt(config, "opencode-go/glm-5.3")

    // then
    expect(block.startsWith("## Driving GLM-5.3")).toBe(true)
  })

  it("returns empty when the user disables a model that has a shipped block file", async () => {
    // given — an explicit "" wins over the shipped block
    const config = makeConfig({ model_prompts: { deepseekv41flash: "" } })

    // when // then
    expect(await resolveModelPrompt(config, "opencode-go/deepseek-v4.1-flash")).toBe("")
  })

  it("loads the shipped block for the direct-provider DeepSeek Flash id", async () => {
    // given — deepseek/deepseek-flash normalizes to deepseekflash, not deepseekv41flash
    const config = makeConfig()

    // when
    const block = await resolveModelPrompt(config, "deepseek/deepseek-flash")

    // then
    expect(block.startsWith("## Driving DeepSeek V4.1-Flash")).toBe(true)
  })

  it("keeps the direct-provider DeepSeek Flash block in sync with the V4.1-Flash block", async () => {
    // given — the two ids name the same model; the alias file must not drift
    const [alias, canonical] = await Promise.all([
      readFile(resolveAsset("model-prompts/deepseekflash.md"), "utf8"),
      readFile(resolveAsset("model-prompts/deepseekv41flash.md"), "utf8"),
    ])

    // when // then
    expect(alias).toBe(canonical)
  })
})

describe("registerConsultantAgent", () => {
  it("registers config.agent.consultant with mode primary and a prompt containing the consultant.md body", async () => {
    // given
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig()

    // when
    await registerConsultantAgent(config, pluginConfig, "oc-testnamespace")

    // then
    expect(config.agent).toBeDefined()
    const consultant = config.agent?.["consultant"] as { mode: string; prompt: string }
    expect(consultant.mode).toBe("primary")
    expect(consultant.prompt).toContain("# Consultant")
    expect(consultant.prompt).toContain("## Role")
  })

  it("includes the runtime bindings block in the assembled prompt", async () => {
    // given
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig()

    // when
    await registerConsultantAgent(config, pluginConfig, "oc-mynamespace")

    // then
    const consultant = config.agent?.["consultant"] as { prompt: string }
    expect(consultant.prompt).toContain("## Runtime Bindings (injected by opencode-adapter)")
    expect(consultant.prompt).toContain("oc-mynamespace")
  })

  it("sets model when agent_model is configured", async () => {
    // given
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig({ agent_model: "anthropic/claude-sonnet" })

    // when
    await registerConsultantAgent(config, pluginConfig, "oc-ns")

    // then
    const consultant = config.agent?.["consultant"] as { mode: string; model?: string }
    expect(consultant.model).toBe("anthropic/claude-sonnet")
  })

  it("defaults the model to glm-5.3 when agent_model is not configured", async () => {
    // given
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig()

    // when
    await registerConsultantAgent(config, pluginConfig, "oc-ns")

    // then
    const consultant = config.agent?.["consultant"] as { model?: string }
    expect(consultant.model).toBe("opencode-go/glm-5.3")
  })

  it("does NOT clobber a pre-existing user-defined consultant agent entry", async () => {
    // given
    const userPrompt = "This is the user's custom consultant prompt."
    const config: { agent?: Record<string, unknown> } = {
      agent: { consultant: { mode: "primary", prompt: userPrompt } },
    }
    const pluginConfig = makeConfig()

    // when
    await registerConsultantAgent(config, pluginConfig, "oc-ns")

    // then
    const consultant = config.agent?.["consultant"] as { prompt: string }
    expect(consultant.prompt).toBe(userPrompt)
  })

  it("replaces the RUNTIME-BINDINGS placeholder in the real consultant.md asset", async () => {
    // given
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig()

    // when
    await registerConsultantAgent(config, pluginConfig, "oc-ns")

    // then
    const consultant = config.agent?.["consultant"] as { prompt: string }
    expect(consultant.prompt).not.toContain("<!-- RUNTIME-BINDINGS")
    expect(consultant.prompt).toContain("## Runtime Bindings (injected by opencode-adapter)")
  })

  it("includes the author state dir, project id, and brief path when the project directory is supplied", async () => {
    // given
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig()
    const env = { HOME: "/home/test-user" } as NodeJS.ProcessEnv
    const authorDir = "/home/test-user/.local/share/janus-agent/author"
    const projectId = computeProjectId("/tmp/my-project")

    // when
    await registerConsultantAgent(config, pluginConfig, "oc-ns", "/tmp/my-project", env)

    // then
    const consultant = config.agent?.["consultant"] as { prompt: string }
    expect(consultant.prompt).toContain(`Author state dir: \`${authorDir}\``)
    expect(consultant.prompt).toContain(`project id: \`${projectId}\``)
    expect(consultant.prompt).toContain(`${authorDir}/${projectId}/<docId>/brief.md`)
    expect(consultant.prompt).toContain("the writer reads it and never writes it")
    expect(consultant.prompt).toContain("Writer write mode: `scoped`")
  })

  it("omits the author lines when no project directory is supplied", async () => {
    // given
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig()

    // when
    await registerConsultantAgent(config, pluginConfig, "oc-ns")

    // then
    const consultant = config.agent?.["consultant"] as { prompt: string }
    expect(consultant.prompt).not.toContain("Author state dir")
    expect(consultant.prompt).toContain("Writer write mode: `scoped`")
  })
})

describe("registerConsultationCritic", () => {
  it("registers the critic as a subagent with the critic.md body and a read-only permission", async () => {
    // given
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig()

    // when
    await registerConsultationCritic(config, pluginConfig)

    // then
    const critic = config.agent?.["consultation-critic"] as {
      mode: string
      prompt: string
      description: string
      permission: Record<string, unknown>
    }
    expect(critic.mode).toBe("subagent")
    expect(critic.prompt).toContain("# Consultation Critic")
    expect(critic.prompt).toContain("counterEvidence")
    expect(critic.description).toContain("counter-evidence")
    expect(critic.description).toContain("design pre-mortems")
    expect(critic.permission).toMatchObject({ edit: "deny", bash: "deny", task: "deny" })
  })

  it("sets the critic model when critic_model is configured", async () => {
    // given
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig({ critic_model: "anthropic/claude-sonnet-4" })

    // when
    await registerConsultationCritic(config, pluginConfig)

    // then
    const critic = config.agent?.["consultation-critic"] as { model?: string }
    expect(critic.model).toBe("anthropic/claude-sonnet-4")
  })

  it("defaults the critic model to gemini-3.8-flash when critic_model is unset", async () => {
    // given
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig()

    // when
    await registerConsultationCritic(config, pluginConfig)

    // then
    const critic = config.agent?.["consultation-critic"] as { model?: string }
    expect(critic.model).toBe("opencode/gemini-3.8-flash")
  })

  it("uses the configured critic_agent name", async () => {
    // given
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig({ critic_agent: "my-devil" })

    // when
    await registerConsultationCritic(config, pluginConfig)

    // then
    expect(config.agent?.["my-devil"]).toBeDefined()
    expect(config.agent?.["consultation-critic"]).toBeUndefined()
  })

  it("does NOT clobber a pre-existing user-defined critic agent entry", async () => {
    // given
    const userPrompt = "user-defined critic prompt"
    const config: { agent?: Record<string, unknown> } = {
      agent: { "consultation-critic": { mode: "subagent", prompt: userPrompt } },
    }
    const pluginConfig = makeConfig()

    // when
    await registerConsultationCritic(config, pluginConfig)

    // then
    const critic = config.agent?.["consultation-critic"] as { prompt: string }
    expect(critic.prompt).toBe(userPrompt)
  })
})

describe("registerExplorer", () => {
  it("registers the explorer subagent with the explorer.md body and default model", async () => {
    // given
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig()

    // when
    await registerExplorer(config, pluginConfig)

    // then
    const explorer = config.agent?.["consultation-explorer"] as {
      mode: string
      prompt: string
      model: string
      permission: Record<string, unknown>
    }
    expect(explorer.mode).toBe("subagent")
    expect(explorer.prompt).toContain("# Explorer")
    expect(explorer.model).toBe("opencode-go/deepseek-v4.1-flash")
    expect(explorer.permission).toMatchObject({ edit: "deny", bash: "deny", task: "deny" })
  })

  it("overrides the explorer model from explorer_model", async () => {
    // given
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig({ explorer_model: "test/explorer-model" })

    // when
    await registerExplorer(config, pluginConfig)

    // then
    const explorer = config.agent?.["consultation-explorer"] as { model: string }
    expect(explorer.model).toBe("test/explorer-model")
  })
})

describe("registerAnalyst", () => {
  it("registers the analyst subagent with the analyst.md body and default model", async () => {
    // given
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig()

    // when
    await registerAnalyst(config, pluginConfig)

    // then
    const analyst = config.agent?.["consultation-analyst"] as {
      mode: string
      prompt: string
      model: string
      permission: Record<string, unknown>
    }
    expect(analyst.mode).toBe("subagent")
    expect(analyst.prompt).toContain("# Analyst")
    expect(analyst.model).toBe("opencode-go/qwen3.8-max")
    expect(analyst.permission).toMatchObject({ edit: "deny", bash: "deny", task: "deny" })
  })

  it("overrides the analyst model from analyst_model", async () => {
    // given
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig({ analyst_model: "test/analyst-model" })

    // when
    await registerAnalyst(config, pluginConfig)

    // then
    const analyst = config.agent?.["consultation-analyst"] as { model: string }
    expect(analyst.model).toBe("test/analyst-model")
  })
})

describe("registerVerifier", () => {
  it("uses the configured default critic-family model for the verifier", async () => {
    const config: { agent?: Record<string, unknown> } = {}

    await registerVerifier(config, makeConfig())

    expect(config.agent?.["consultation-verifier"]).toMatchObject({
      mode: "subagent",
      model: "opencode/gemini-3.8-flash",
      permission: { edit: "deny", bash: "deny", task: "deny" },
    })
  })
})

describe("buildWriterPermission", () => {
  it("denies edit everywhere except the roots, denies bash and task, allows web lookups", () => {
    // given
    const authorDir = "/xdg/data/janus-agent/author"

    // when
    const permission = buildWriterPermission(["userdoc", "docs/guides"], authorDir)

    // then
    expect(permission.bash).toBe("deny")
    expect(permission.task).toBe("deny")
    expect(permission.webfetch).toBe("allow")
    expect(permission.websearch).toBe("allow")
    const edit = permission.edit as Record<string, string>
    expect(edit["*"]).toBe("deny")
    expect(edit["userdoc/**"]).toBe("allow")
    expect(edit["docs/guides/**"]).toBe("allow")
    // The catch-all must be first so later specific rules win.
    expect(Object.keys(edit)[0]).toBe("*")
    const external = permission.external_directory as Record<string, string>
    expect(external[`${authorDir}/**`]).toBe("allow")
  })

  it("falls back to a flat edit deny when the roots array is empty", () => {
    // given // when
    const permission = buildWriterPermission([], "/xdg/data/janus-agent/author")

    // then
    expect(permission).toEqual({
      edit: "deny",
      bash: "deny",
      task: "deny",
      webfetch: "allow",
      websearch: "allow",
    })
  })

  it("anchors root allow rules to the supplied project directory in absolute form", () => {
    // given
    const authorDir = "/xdg/data/janus-agent/author"

    // when
    const permission = buildWriterPermission(["userdoc"], authorDir, "/tmp/project")

    // then
    const edit = permission.edit as Record<string, string>
    expect(edit["*"]).toBe("deny")
    expect(edit["userdoc/**"]).toBe("allow")
    expect(edit["/tmp/project/userdoc/**"]).toBe("allow")
    expect(edit["tmp/project/userdoc/**"]).toBe("allow")
    // The catch-all must stay first so later specific rules win.
    expect(Object.keys(edit)[0]).toBe("*")
  })

  it("anchors root allow rules to the realpath of the project directory when it exists", () => {
    // given
    const authorDir = "/xdg/data/janus-agent/author"
    const dir = mkdtempSync(join(tmpdir(), "writer-anchor-"))
    const real = realpathSync(dir)

    try {
      // when
      const permission = buildWriterPermission(["userdoc"], authorDir, dir)

      // then
      const edit = permission.edit as Record<string, string>
      expect(edit[`${dir}/userdoc/**`]).toBe("allow")
      expect(edit[`${real}/userdoc/**`]).toBe("allow")
      expect(edit[`${real.replace(/^\//, "")}/userdoc/**`]).toBe("allow")
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe("buildWriterRuntimeBindings", () => {
  it("reports the model, scoped mode, roots, author dir, search budget, and leaf rule", () => {
    // given
    const config = makeConfig({ writer_docs_roots: ["./docs/guides/"] })
    const authorDir = "/xdg/data/janus-agent/author"

    // when
    const block = buildWriterRuntimeBindings(config, authorDir)

    // then
    expect(block).toContain("## Runtime Bindings (injected by opencode-adapter)")
    expect(block).toContain("Writer model: `opencode/claude-sonnet-5-5`")
    expect(block).toContain("Write mode: `scoped`")
    expect(block).toContain("`docs/guides`")
    expect(block).toContain(`Author state dir: \`${authorDir}\``)
    expect(block).toContain("never write the brief")
    expect(block).toContain("Search budget")
    expect(block).toContain("researchRequest")
    expect(block).toContain("You are a leaf")
    expect(block).toContain("no bash, no dispatch (`task: deny`), no memory tools")
    expect(block).toContain("never dispatch explorer")
  })

  it("reports the read-only mode when writer_docs_roots is empty", () => {
    // given
    const config = makeConfig({ writer_docs_roots: [] })

    // when
    const block = buildWriterRuntimeBindings(config, "/xdg/data/janus-agent/author")

    // then
    expect(block).toContain("Write mode: `read-only`")
    expect(block).toContain("no file writes")
    expect(block).toContain("the consultant publishes it")
    expect(block).toContain("the roots array is empty")
  })
})

describe("registerWriter", () => {
  // registerWriter always mkdirs the resolved author state dir — every test
  // in this describe points it at a temp HOME so nothing lands under the
  // real HOME.
  function tempAuthorEnv(): { env: NodeJS.ProcessEnv; authorDir: string; cleanup: () => void } {
    const parent = mkdtempSync(join(tmpdir(), "writer-author-"))
    return {
      env: { HOME: parent } as NodeJS.ProcessEnv,
      authorDir: join(parent, ".local", "share", "janus-agent", "author"),
      cleanup: () => rmSync(parent, { recursive: true, force: true }),
    }
  }

  it("registers the scoped-write author executor with steps 80 and root-scoped edit permission", async () => {
    // given
    const { env, authorDir, cleanup } = tempAuthorEnv()
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig()

    try {
      // when
      await registerWriter(config, pluginConfig, env)

      // then
      const writer = config.agent?.["consultation-writer"] as {
        mode: string
        description: string
        prompt: string
        model: string
        steps: number
        permission: Record<string, unknown>
      }
      expect(writer.mode).toBe("subagent")
      expect(writer.model).toBe("opencode/claude-sonnet-5-5")
      expect(writer.steps).toBe(80)
      expect(writer.description).toContain("sole author of reader-facing prose")
      expect(writer.description).toContain("Scoped-write author executor")
      expect(writer.permission.bash).toBe("deny")
      expect(writer.permission.task).toBe("deny")
      expect(writer.permission.webfetch).toBe("allow")
      expect(writer.permission.websearch).toBe("allow")
      const edit = writer.permission.edit as Record<string, string>
      expect(edit["*"]).toBe("deny")
      expect(edit["userdoc/**"]).toBe("allow")
      const external = writer.permission.external_directory as Record<string, string>
      expect(external[`${authorDir}/**`]).toBe("allow")
      expect(writer.prompt).toContain("# Writer")
      expect(writer.prompt).toContain("## Runtime Bindings (injected by opencode-adapter)")
      expect(writer.prompt).not.toContain("<!-- RUNTIME-BINDINGS")
      expect(existsSync(authorDir)).toBe(true)
    } finally {
      cleanup()
    }
  })

  it("normalizes configured roots into the edit permission", async () => {
    // given
    const { env, cleanup } = tempAuthorEnv()
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig({ writer_docs_roots: ["./docs/guides/"] })

    try {
      // when
      await registerWriter(config, pluginConfig, env)

      // then
      const writer = config.agent?.["consultation-writer"] as { permission: Record<string, unknown> }
      const edit = writer.permission.edit as Record<string, string>
      expect(edit["docs/guides/**"]).toBe("allow")
      expect(edit["userdoc/**"]).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  it("registers a read-only writer when writer_docs_roots is empty", async () => {
    // given
    const { env, cleanup } = tempAuthorEnv()
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig({ writer_docs_roots: [] })

    try {
      // when
      await registerWriter(config, pluginConfig, env)

      // then
      const writer = config.agent?.["consultation-writer"] as {
        prompt: string
        permission: Record<string, unknown>
      }
      expect(writer.permission).toEqual({
        edit: "deny",
        bash: "deny",
        task: "deny",
        webfetch: "allow",
        websearch: "allow",
      })
      expect(writer.prompt).toContain("Write mode: `read-only`")
    } finally {
      cleanup()
    }
  })

  it("does not register the bundled writer when a delegate agent is configured", async () => {
    // given
    const { env, cleanup } = tempAuthorEnv()
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig({ writer_delegate_agent: "host-writer" })

    try {
      // when
      await registerWriter(config, pluginConfig, env)

      // then
      expect(config.agent?.["consultation-writer"]).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  it("does NOT clobber a pre-existing user-defined writer agent entry", async () => {
    // given
    const { env, cleanup } = tempAuthorEnv()
    const userPrompt = "user-defined writer prompt"
    const config: { agent?: Record<string, unknown> } = {
      agent: { "consultation-writer": { mode: "subagent", prompt: userPrompt } },
    }
    const pluginConfig = makeConfig()

    try {
      // when
      await registerWriter(config, pluginConfig, env)

      // then
      const writer = config.agent?.["consultation-writer"] as { prompt: string }
      expect(writer.prompt).toBe(userPrompt)
    } finally {
      cleanup()
    }
  })

  it("reports the delegate in runtime bindings when configured", () => {
    // given
    const config = makeConfig({ writer_delegate_agent: "host-writer" })

    // when
    const block = buildRuntimeBindings(config, "oc-ns")

    // then
    expect(block).toContain("writer delegated to `host-writer`")
  })

  it("reports the writer model without a fallback in runtime bindings", () => {
    // given
    const config = makeConfig()

    // when
    const block = buildRuntimeBindings(config, "oc-ns")

    // then
    expect(block).toContain("writer `consultation-writer` (opencode/claude-sonnet-5-5)")
  })
})

describe("resolveLiteWorkspaceDir", () => {
  it("defaults under XDG data home", () => {
    // given
    const config = makeConfig()
    const env = { HOME: "/home/test-user", XDG_DATA_HOME: "/xdg/data" } as NodeJS.ProcessEnv

    // when
    const dir = resolveLiteWorkspaceDirLocal(config, env)

    // then
    expect(dir).toBe("/xdg/data/janus-agent/lite")
  })

  it("falls back to HOME/.local/share when XDG_DATA_HOME is unset", () => {
    // given
    const config = makeConfig()
    const env = { HOME: "/home/test-user" } as NodeJS.ProcessEnv

    // when
    const dir = resolveLiteWorkspaceDirLocal(config, env)

    // then
    expect(dir).toBe("/home/test-user/.local/share/janus-agent/lite")
  })

  it("honors lite_workspace_dir when configured", () => {
    // given
    const config = makeConfig({ lite_workspace_dir: "/custom/lite-ws" })

    // when
    const dir = resolveLiteWorkspaceDirLocal(config, { HOME: "/home/test-user" } as NodeJS.ProcessEnv)

    // then
    expect(dir).toBe("/custom/lite-ws")
  })
})

describe("resolveAuthorStateDir", () => {
  it("defaults under XDG data home with the janus-agent/author suffix", () => {
    // given
    const env = { HOME: "/home/test-user", XDG_DATA_HOME: "/xdg/data" } as NodeJS.ProcessEnv

    // when
    const dir = resolveAuthorStateDir(env)

    // then
    expect(dir).toBe("/xdg/data/janus-agent/author")
  })

  it("falls back to HOME/.local/share when XDG_DATA_HOME is unset", () => {
    // given
    const env = { HOME: "/home/test-user" } as NodeJS.ProcessEnv

    // when
    const dir = resolveAuthorStateDir(env)

    // then
    expect(dir).toBe("/home/test-user/.local/share/janus-agent/author")
  })
})

describe("computeProjectId", () => {
  it("is stable for the same directory and shaped as basename-<8 hex>", () => {
    // given // when
    const first = computeProjectId("/tmp/project")
    const second = computeProjectId("/tmp/project")

    // then
    expect(first).toBe(second)
    expect(first).toMatch(/^[a-z0-9-]+-[0-9a-f]{8}$/)
    expect(first.startsWith("project-")).toBe(true)
  })

  it("sanitizes the basename and distinguishes same-named projects by hash", () => {
    // given // when
    const a = computeProjectId("/work/My Project")
    const b = computeProjectId("/elsewhere/My Project")

    // then
    expect(a.startsWith("my-project-")).toBe(true)
    expect(a).not.toBe(b)
  })
})

describe("buildLitePermission", () => {
  it("allows reads and its own workspace, asks for every other write and non-readonly bash, denies dispatch", () => {
    // given
    const workspace = "/xdg/data/janus-agent/lite"

    // when
    const permission = buildLitePermission(workspace)

    // then
    expect(permission.webfetch).toBe("allow")
    expect(permission.websearch).toBe("allow")
    expect(permission.task).toBe("deny")
    const edit = permission.edit as Record<string, string>
    expect(edit["*"]).toBe("ask")
    expect(edit[`${workspace}/**`]).toBe("allow")
    const bash = permission.bash as Record<string, string>
    expect(bash["*"]).toBe("ask")
    expect(bash["cat *"]).toBe("allow")
    expect(bash["git status"]).toBe("allow")
    expect(bash["git log *"]).toBe("allow")
    expect(bash["mkdir *"]).toBeUndefined()
    expect(bash["find *"]).toBeUndefined()
    expect(bash["curl *"]).toBeUndefined()
    const external = permission.external_directory as Record<string, string>
    expect(external[`${workspace}/**`]).toBe("allow")
  })
})

describe("buildLiteRuntimeBindings", () => {
  it("reports memory, own model, escalation targets, workspace, namespace, and leaf rule", () => {
    // given
    const config = makeConfig()
    const workspace = "/xdg/data/janus-agent/lite"

    // when
    const block = buildLiteRuntimeBindings(config, workspace, "oc-ns")

    // then
    expect(block).toContain("## Runtime Bindings (injected by opencode-adapter)")
    expect(block).toContain("janus-memory")
    expect(block).toContain("Lite model: `opencode-go/deepseek-v4.1-flash`")
    expect(block).toContain("Consultant:")
    expect(block).toContain("Coder:")
    expect(block).toContain("Janus:")
    expect(block).toContain("You are a leaf: do not dispatch another agent")
    expect(block).toContain(`Your writable workspace: \`${workspace}\``)
    expect(block).toContain("oc-ns")
    expect(block).not.toContain("Mechanical coding lane")
  })

  it("says Memory DISABLED when memory_enabled is false", () => {
    // given
    const config = makeConfig({ memory_enabled: false })

    // when
    const block = buildLiteRuntimeBindings(config, "/ws", "oc-ns")

    // then
    expect(block).toContain("Memory: DISABLED by configuration (saving and recall are unavailable)")
  })
})

describe("registerLite", () => {
  // registerLite always mkdirs its resolved workspace — every test in this
  // describe must point it at a temp dir so nothing lands under the real HOME.
  function tempWorkspaceConfig(overrides: Partial<JanusPluginConfig> = {}): { pluginConfig: JanusPluginConfig; cleanup: () => void } {
    const workspaceParent = mkdtempSync(join(tmpdir(), "lite-ws-"))
    return {
      pluginConfig: makeConfig({ lite_workspace_dir: join(workspaceParent, "lite"), ...overrides }),
      cleanup: () => rmSync(workspaceParent, { recursive: true, force: true }),
    }
  }

  it("registers mode all with the lite.md body, injected bindings, and patterned permission", async () => {
    // given — temp workspace so the test never creates anything under the real HOME
    const workspaceParent = mkdtempSync(join(tmpdir(), "lite-ws-"))
    const workspace = join(workspaceParent, "lite")
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig({ lite_workspace_dir: workspace })

    try {
      // when
      await registerLite(config, pluginConfig, "oc-testns")

      // then
      const lite = config.agent?.["lite"] as {
        mode: string
        description: string
        prompt: string
        model: string
        permission: Record<string, unknown>
      }
      expect(lite.mode).toBe("all")
      expect(lite.model).toBe("opencode-go/deepseek-v4.1-flash")
      expect(lite.description).toContain("Economical quick-answer entry")
      expect(lite.prompt).toContain("# Lite")
      // The default model resolves its shipped slug block, which replaces
      // the placeholder.
      expect(lite.prompt).toContain("## Driving DeepSeek V4.1-Flash")
      expect(lite.prompt).not.toContain("<!-- MODEL-PROMPT")
      expect(lite.prompt).toContain("## Runtime Bindings (injected by opencode-adapter)")
      expect(lite.prompt).toContain("oc-testns")
      expect(lite.prompt).toContain(workspace)
      expect(lite.prompt).not.toContain("<!-- RUNTIME-BINDINGS")
      expect(lite.permission.webfetch).toBe("allow")
      expect(lite.permission.task).toBe("deny")
      const edit = lite.permission.edit as Record<string, string>
      expect(edit[`${workspace}/**`]).toBe("allow")
    } finally {
      rmSync(workspaceParent, { recursive: true, force: true })
    }
  })

  it("skips the default model block when the model is swapped and no user block exists", async () => {
    // given — a swapped model with no user model-prompt entry
    const workspaceParent = mkdtempSync(join(tmpdir(), "lite-ws-"))
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig({
      lite_workspace_dir: join(workspaceParent, "lite"),
      lite_model: "my-provider/other-model",
    })

    try {
      // when
      await registerLite(config, pluginConfig, "oc-ns")

      // then
      const lite = config.agent?.["lite"] as { prompt: string }
      expect(lite.prompt).toContain("<!-- MODEL-PROMPT")
      expect(lite.prompt).not.toContain("Driving DeepSeek V4.1-Flash")
    } finally {
      rmSync(workspaceParent, { recursive: true, force: true })
    }
  })

  it("injects the user model block over the shipped block", async () => {
    // given
    const workspaceParent = mkdtempSync(join(tmpdir(), "lite-ws-"))
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig({
      lite_workspace_dir: join(workspaceParent, "lite"),
      model_prompts: { deepseekv41flash: "user flash block" },
    })

    try {
      // when
      await registerLite(config, pluginConfig, "oc-ns")

      // then
      const lite = config.agent?.["lite"] as { prompt: string }
      expect(lite.prompt).toContain("user flash block")
      expect(lite.prompt).not.toContain("Driving DeepSeek V4.1-Flash")
      expect(lite.prompt).not.toContain("<!-- MODEL-PROMPT")
    } finally {
      rmSync(workspaceParent, { recursive: true, force: true })
    }
  })

  it("creates the workspace directory under the resolved data home", async () => {
    // given
    const workspaceParent = mkdtempSync(join(tmpdir(), "lite-ws-"))
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig({ lite_workspace_dir: join(workspaceParent, "lite") })

    // when
    await registerLite(config, pluginConfig, "oc-ns")

    // then
    expect(existsSync(join(workspaceParent, "lite"))).toBe(true)
    rmSync(workspaceParent, { recursive: true, force: true })
  })

  it("overrides the model from lite_model", async () => {
    // given
    const { pluginConfig, cleanup } = tempWorkspaceConfig({ lite_model: "test/lite-m" })
    const config: { agent?: Record<string, unknown> } = {}

    try {
      // when
      await registerLite(config, pluginConfig, "oc-ns")

      // then
      const lite = config.agent?.["lite"] as { model: string }
      expect(lite.model).toBe("test/lite-m")
    } finally {
      cleanup()
    }
  })

  it("uses the configured lite_agent name", async () => {
    // given
    const { pluginConfig, cleanup } = tempWorkspaceConfig({ lite_agent: "my-lite" })
    const config: { agent?: Record<string, unknown> } = {}

    try {
      // when
      await registerLite(config, pluginConfig, "oc-ns")

      // then
      expect(config.agent?.["my-lite"]).toBeDefined()
      expect(config.agent?.["lite"]).toBeUndefined()
    } finally {
      cleanup()
    }
  })

  it("does NOT clobber a pre-existing user-defined lite agent entry", async () => {
    // given
    const userPrompt = "user-defined lite prompt"
    const config: { agent?: Record<string, unknown> } = {
      agent: { lite: { mode: "all", prompt: userPrompt } },
    }
    const { pluginConfig, cleanup } = tempWorkspaceConfig()

    try {
      // when
      await registerLite(config, pluginConfig, "oc-ns")

      // then
      const lite = config.agent?.["lite"] as { prompt: string }
      expect(lite.prompt).toBe(userPrompt)
    } finally {
      cleanup()
    }
  })
})

describe("registerCoder", () => {
  it("registers mode all with the coder.md body, model block, and runtime bindings", async () => {
    // given
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig()

    // when
    await registerCoder(config, pluginConfig)

    // then
    const coder = config.agent?.["coder"] as {
      mode: string
      description: string
      prompt: string
      model: string
      permission: Record<string, unknown>
    }
    expect(coder.mode).toBe("all")
    expect(coder.model).toBe("opencode-go/glm-5.3")
    expect(coder.description).toContain("Coding entry point")
    expect(coder.prompt).toContain("# Coder")
    expect(coder.prompt).toContain("Task triage")
    expect(coder.prompt).toContain("## Dispatched mode")
    expect(coder.prompt).toContain("## Driving GLM-5.3")
    expect(coder.prompt).toContain("## Runtime Bindings (injected by opencode-adapter)")
    expect(coder.prompt).toContain("coder-lite")
    expect(coder.prompt).not.toContain("janus-memory")
  })

  it("overrides the coder model from coder_model", async () => {
    // given
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig({ coder_model: "test/coder-model" })

    // when
    await registerCoder(config, pluginConfig)

    // then
    const coder = config.agent?.["coder"] as { model: string }
    expect(coder.model).toBe("test/coder-model")
  })
})

describe("buildCoderLitePermission", () => {
  it("allows workspace edits, asks for external, denies further dispatch", () => {
    // given // when
    const permission = buildCoderLitePermission()

    // then
    const edit = permission.edit as Record<string, string>
    expect(edit["*"]).toBe("allow")
    expect(edit["/*"]).toBe("ask")
    expect(edit).toEqual({ "*": "allow", "/*": "ask" })
    const bash = permission.bash as Record<string, string>
    expect(bash["*"]).toBe("ask")
    expect(bash["cat *"]).toBe("allow")
    expect(permission.webfetch).toBe("allow")
    expect(permission.websearch).toBe("allow")
    expect(permission.task).toBe("deny")
  })
})

describe("registerCoderLite", () => {
  it("registers a leaf subagent with steps 50 and the role body", async () => {
    // given
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig()

    // when
    await registerCoderLite(config, pluginConfig)

    // then
    const lite = config.agent?.["coder-lite"] as {
      mode: string
      description: string
      prompt: string
      model: string
      steps: number
      permission: Record<string, unknown>
    }
    expect(lite.mode).toBe("subagent")
    expect(lite.model).toBe("opencode-go/glm-5.3-flash")
    expect(lite.steps).toBe(50)
    expect(lite.description).toContain("mechanical coding")
    expect(lite.prompt).toContain("# Coder-Lite")
    expect(lite.prompt).toContain("Report-Up discipline")
    // The default model resolves its shipped slug block, which replaces the
    // placeholder.
    expect(lite.prompt).toContain("## Driving GLM-5.3-Flash")
    expect(lite.prompt).not.toContain("<!-- MODEL-PROMPT")
    expect(lite.permission.task).toBe("deny")
  })

  it("assembles the raw asset plus only the common principles block when the model is swapped and no user block exists", async () => {
    // given
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig({ coder_lite_model: "my-provider/other-model" })

    // when
    await registerCoderLite(config, pluginConfig)

    // then
    const lite = config.agent?.["coder-lite"] as { prompt: string }
    const source = await readFile(resolveAsset("agents/coder-lite.md"), "utf8")
    const common = await loadCommonPrinciples()
    expect(lite.prompt).toBe(`${source}\n\n${common.trim()}`)
  })

  it("injects the user model block over the shipped block", async () => {
    // given
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig({
      model_prompts: { glm53flash: "user glm block" },
    })

    // when
    await registerCoderLite(config, pluginConfig)

    // then
    const lite = config.agent?.["coder-lite"] as { prompt: string }
    expect(lite.prompt).toContain("user glm block")
    expect(lite.prompt).not.toContain("Driving GLM-5.3-Flash")
    expect(lite.prompt).not.toContain("<!-- MODEL-PROMPT")
  })

  it("overrides the model from coder_lite_model", async () => {
    // given
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig({ coder_lite_model: "test/glm-flash" })

    // when
    await registerCoderLite(config, pluginConfig)

    // then
    const lite = config.agent?.["coder-lite"] as { model: string }
    expect(lite.model).toBe("test/glm-flash")
  })

  it("uses the configured coder_lite_agent name and never clobbers", async () => {
    // given
    const userPrompt = "user-defined coder-lite prompt"
    const config: { agent?: Record<string, unknown> } = {
      agent: { "coder-lite": { mode: "subagent", prompt: userPrompt } },
    }
    const pluginConfig = makeConfig()

    // when
    await registerCoderLite(config, pluginConfig)

    // then
    const lite = config.agent?.["coder-lite"] as { prompt: string }
    expect(lite.prompt).toBe(userPrompt)
  })
})

describe("buildJanusRuntimeBindings", () => {
  it("reports own model, consultant/coder/lite/explorer routes, and job-tool discipline, with no memory line", () => {
    // given
    const config = makeConfig()

    // when
    const block = buildJanusRuntimeBindings(config)

    // then
    expect(block).toContain("## Runtime Bindings (injected by opencode-adapter)")
    expect(block).toContain("Janus model: `opencode-go/glm-5.3`")
    expect(block).toContain("`consultant` (agent `consultant`, `opencode-go/glm-5.3`)")
    expect(block).toContain("`coder` (agent `coder`, `opencode-go/glm-5.3`)")
    expect(block).toContain("`lite` (agent `lite`, `opencode-go/deepseek-v4.1-flash`)")
    expect(block).toContain("`explorer` (agent `consultation-explorer`")
    expect(block).toContain("bounded evidence gathering")
    expect(block).toContain("janus_dispatch_wait")
    expect(block).not.toContain("`build` (agent")
    expect(block).not.toContain("janus-memory")
    expect(block).not.toContain("Memory namespace")
  })

  it("reports the DISABLED lite variant", () => {
    // given
    const config = makeConfig({ lite_enabled: false })

    // when
    const block = buildJanusRuntimeBindings(config)

    // then
    expect(block).toContain("lite DISABLED by configuration")
  })
})

describe("registerJanus", () => {
  it("registers mode all with the janus.md body, injected model block and bindings, no memory", async () => {
    // given
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig()

    // when
    await registerJanus(config, pluginConfig)

    // then
    const janus = config.agent?.["janus"] as {
      mode: string
      description: string
      prompt: string
      model: string
      permission: Record<string, unknown>
    }
    expect(janus.mode).toBe("all")
    expect(janus.model).toBe("opencode-go/glm-5.3")
    expect(janus.description).toContain("Daily-driver primary")
    expect(janus.prompt).toContain("# Janus")
    expect(janus.prompt).toContain("## Routing")
    expect(janus.prompt).toContain("## General work")
    // The default model resolves its shipped slug block, replacing the placeholder.
    expect(janus.prompt).toContain("## Driving GLM-5.3")
    expect(janus.prompt).not.toContain("<!-- MODEL-PROMPT")
    expect(janus.prompt).toContain("## Runtime Bindings (injected by opencode-adapter)")
    expect(janus.prompt).not.toContain("<!-- RUNTIME-BINDINGS")
    expect(janus.prompt).not.toContain("janus-memory")
  })

  it("overrides the model from janus_model", async () => {
    // given
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig({ janus_model: "test/janus-m" })

    // when
    await registerJanus(config, pluginConfig)

    // then
    const janus = config.agent?.["janus"] as { model: string }
    expect(janus.model).toBe("test/janus-m")
  })

  it("uses the configured janus_agent name and never clobbers a pre-existing entry", async () => {
    // given
    const config: { agent?: Record<string, unknown> } = {
      agent: { janus: { mode: "all", prompt: "user-defined janus prompt" } },
    }
    const pluginConfig = makeConfig()

    // when
    await registerJanus(config, pluginConfig)

    // then
    const janus = config.agent?.["janus"] as { prompt: string }
    expect(janus.prompt).toBe("user-defined janus prompt")
  })

  it("keeps the asset byte-identical when the model is swapped and no user block exists", async () => {
    // given
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig({ janus_model: "my-provider/other-model" })

    // when
    await registerJanus(config, pluginConfig)

    // then
    const janus = config.agent?.["janus"] as { prompt: string }
    expect(janus.prompt).toContain("<!-- MODEL-PROMPT")
    expect(janus.prompt).not.toContain("Driving GLM-5.3")
  })
})

describe("common operating principles injection", () => {
  it("injects the common principles block into every plugin-owned agent prompt", async () => {
    // given — temp lite workspace so registerLite never creates anything
    // under the real HOME
    const workspaceParent = mkdtempSync(join(tmpdir(), "lite-ws-"))
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig({ lite_workspace_dir: join(workspaceParent, "lite") })

    try {
      // when — register the full ten-agent family into one config
      await registerJanus(config, pluginConfig)
      await registerConsultantAgent(config, pluginConfig, "oc-ns")
      await registerCoder(config, pluginConfig)
      await registerCoderLite(config, pluginConfig)
      await registerLite(config, pluginConfig, "oc-ns")
      await registerExplorer(config, pluginConfig)
      await registerAnalyst(config, pluginConfig)
      await registerConsultationCritic(config, pluginConfig)
      await registerVerifier(config, pluginConfig)
      // Temp HOME keeps the writer's author state dir off the real HOME.
      await registerWriter(config, pluginConfig, { HOME: workspaceParent } as NodeJS.ProcessEnv)

      // then
      expect(Object.keys(config.agent ?? {}).sort()).toEqual([
        "coder",
        "coder-lite",
        "consultant",
        "consultation-analyst",
        "consultation-critic",
        "consultation-explorer",
        "consultation-verifier",
        "consultation-writer",
        "janus",
        "lite",
      ])
      for (const entry of Object.values(config.agent ?? {})) {
        const prompt = (entry as { prompt: string }).prompt
        expect(prompt).toContain("## Common Operating Principles")
        expect(prompt).toContain("### File Change Confirmation")
      }
    } finally {
      rmSync(workspaceParent, { recursive: true, force: true })
    }
  })
})

describe("existing agents carry the inert MODEL-PROMPT placeholder", () => {
  it("every plugin-owned agent asset contains the placeholder", async () => {
    // given
    const assets = [
      "agents/consultant.md",
      "agents/explorer.md",
      "agents/analyst.md",
      "agents/consultation-critic.md",
      "agents/consultation-verifier.md",
      "agents/writer.md",
      "agents/janus.md",
      "agents/coder.md",
      "agents/lite.md",
      "agents/coder-lite.md",
    ]

    // when // then
    for (const asset of assets) {
      const source = await readFile(resolveAsset(asset), "utf8")
      expect(source).toContain("<!-- MODEL-PROMPT")
    }
  })

  it("assembles consultant byte-stably when no model block resolves (placeholder stays inert)", async () => {
    // given — a model with neither a user entry nor a shipped slug file
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig({ agent_model: "my-provider/no-block-model" })

    // when
    await registerConsultantAgent(config, pluginConfig, "oc-ns")

    // then
    const consultant = config.agent?.["consultant"] as { prompt: string }
    expect(consultant.prompt).toContain("<!-- MODEL-PROMPT")
    expect(consultant.prompt).toContain("## Runtime Bindings (injected by opencode-adapter)")
  })

  it("injects a user model block into the consultant and still injects runtime bindings", async () => {
    // given
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig({
      agent_model: "my-provider/consultant-m",
      model_prompts: { consultantm: "drive the consultant carefully" },
    })

    // when
    await registerConsultantAgent(config, pluginConfig, "oc-ns")

    // then
    const consultant = config.agent?.["consultant"] as { prompt: string }
    expect(consultant.prompt).not.toContain("<!-- MODEL-PROMPT")
    expect(consultant.prompt).toContain("drive the consultant carefully")
    expect(consultant.prompt).toContain("## Runtime Bindings (injected by opencode-adapter)")
  })

  it("injects a user model block into a read-only specialist", async () => {
    // given
    const config: { agent?: Record<string, unknown> } = {}
    const pluginConfig = makeConfig({
      critic_model: "my/critic-m",
      model_prompts: { criticm: "challenge aggressively" },
    })

    // when
    await registerConsultationCritic(config, pluginConfig)

    // then
    const critic = config.agent?.["consultation-critic"] as { prompt: string }
    expect(critic.prompt).toContain("challenge aggressively")
    expect(critic.prompt).not.toContain("<!-- MODEL-PROMPT")
  })
})

describe("model-prompt blocks are model-property only", () => {
  it("contains no role name, role rule, or price/pool positioning", async () => {
    // given
    const dir = resolveAsset("model-prompts")
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"))
    expect(files.length).toBeGreaterThan(0)
    const forbidden = [
      /report[- ]up/i,
      /stop-and-report/i,
      /step cap/i,
      /doubly binding/i,
      /approved outline/i,
      /evidence packet/i,
      /answer first/i,
      /answer format/i,
      /best for/i,
      /provided source material/i,
      /one question per reply/i,
      /source-intent/i,
      /evidence interpretation/i,
      /mechanism analysis/i,
      /trade-off resolution/i,
      /critique,? verification/i,
      /\bcheap\b/i,
      /\bat flash cost\b/i,
      /cost-sensitive/i,
      /\bprice\b/i,
      /\bbudget\b/i,
      /\bsubscription\b/i,
      /\bpool\b/i,
      /\bdelegate\b/i,
      /\b(writer|critic|verifier|analyst|explorer|consultant|janus)\b/i,
      // runtime/operator controls the agent cannot set — keep them out of the prompt
      /thinking[_ -]?level/i,
      /reasoning[_ -]?effort/i,
      /thinking[_ -]?budget/i,
      /\btemperature\b/i,
      /\btop[_-]?p\b/i,
      /\bmax[_-]?tokens\b/i,
      /\bxhigh\b/i,
    ]

    // when // then
    for (const file of files) {
      const source = await readFile(join(dir, file), "utf8")
      for (const pattern of forbidden) {
        expect(source).not.toMatch(pattern)
      }
    }
  })

  it("each block carries a model profile and agent-actionable operating notes", async () => {
    // given
    const dir = resolveAsset("model-prompts")
    const files = readdirSync(dir).filter((f) => f.endsWith(".md"))

    // when // then
    for (const file of files) {
      const source = await readFile(join(dir, file), "utf8")
      expect(source).toMatch(/^## Driving /m)
      expect(source).toContain("Profile")
      expect(source).toContain("Operating notes:")
    }
  })

  it("coder prompt encodes adaptive process weight and the design gate", async () => {
    // given
    const source = await readFile(resolveAsset("agents/coder.md"), "utf8")

    // when // then
    expect(source).toContain("Task triage")
    expect(source).toContain("L0 — Direct")
    expect(source).toContain("L1 — Brief plan")
    expect(source).toContain("L2 — Design + plan")
    expect(source).toContain("L3 — Quality gate")
    expect(source).toContain("Design gate — how to ask")
    expect(source).toContain("Do not use a heavyweight process for a simple task")
    expect(source).toContain("Do not skip design for a complex one")
    expect(source).toContain("## Working with a design record")
    expect(source).toContain("the gate shrinks to the implementation details")
    expect(source).toContain("Approving the plan means confirming the files it lists")
    expect(source).toContain("compare the diff with `design.md`")
    expect(source).toContain("one-way-door decision")
    expect(source).toContain("Deleting that `plan.md` after folding is the one persistent-file deletion that needs no confirmation")
    expect(source).toContain("Host subagents are allowed for exploration and review")
  })

  it("coder prompt overrides installed skill workflow at P0", async () => {
    // given
    const source = await readFile(resolveAsset("agents/coder.md"), "utf8")

    // when // then — skills are advisory and never own commits, plan files, or dispatch
    expect(source).toContain("### P0 overrides (these win over any skill)")
    expect(source).toContain("advisory procedure, not authority")
    expect(source).toContain("Never execute a skill's `git commit`")
    expect(source).toContain("`git push`")
    expect(source).toContain("design-record path")
    expect(source).toContain("`design/<projectId>/<designId>/plan.md`")
    expect(source).toContain("`design/<projectId>/<planId>/plan.md` when there is no design")
    expect(source).toContain("list it for confirmation before writing")
    expect(source).toContain("`subagent-driven-development`")
    expect(source).toContain("skip brainstorming's spec/design conversation")
    expect(source).toContain("the design record is the approved spec")
  })

  it("lite and janus prompts encode the entry/leaf boundaries", async () => {
    // given
    const lite = await readFile(resolveAsset("agents/lite.md"), "utf8")
    const janus = await readFile(resolveAsset("agents/janus.md"), "utf8")

    // when // then
    expect(lite).toContain("You are a leaf: you never dispatch another agent.")
    expect(lite).toContain("escalate to `consultant`")
    expect(lite).toContain("escalate to `coder`")
    expect(lite).toContain("personal plans, system design, or durable documents")
    expect(janus).toContain("## Routing")
    expect(janus).toContain("`coder`")
    expect(janus).toContain("A 1-2 tool-call task you can do yourself")
    // The inline small-edit carve-out must never swallow the document lane.
    expect(janus).toContain("except document tasks")
    expect(janus).toContain("never an edit to a document file")
    expect(janus).toContain("Do not run your own design gate")
    expect(janus).toContain("`consultant` (`design` mode)")
    expect(janus).toContain("An implementation plan for a codebase -> `coder`")
    expect(janus).toContain("Reading, summarizing, or explaining an existing document")
    expect(janus).toContain("The dispatch tool still exposes `coder-lite` and `build`")
    expect(lite).toContain("read-only document Q&A")
  })

  it("consultant prompt has a dispatched-mode guard and does not implement code", async () => {
    // given
    const source = await readFile(resolveAsset("agents/consultant.md"), "utf8")

    // when // then
    expect(source).toContain("## Dispatched mode")
    expect(source).toContain("Do not auto-save memory")
    expect(source).not.toContain("do the coding yourself")
  })

  it("role assets do not hard-code model names or benchmark tokens", async () => {
    // given — role positioning lives here; model properties live in model-prompts
    const roleAssets = [
      "agents/consultant.md",
      "agents/explorer.md",
      "agents/analyst.md",
      "agents/consultation-critic.md",
      "agents/consultation-verifier.md",
      "agents/writer.md",
      "agents/janus.md",
      "agents/coder.md",
      "agents/lite.md",
      "agents/coder-lite.md",
      "skills/consultation/SKILL.md",
    ]
    const modelTokens = /(GLM-|DeepSeek|Gemini|Qwen|Claude|Sonnet|Haiku|Kimi|MiMo|Terminal-Bench|GPQA|HLE|IFBench|ARC-AGI|SkillsBench|DeepSWE)/i

    // when // then
    for (const asset of roleAssets) {
      const source = await readFile(resolveAsset(asset), "utf8")
      expect(source).not.toMatch(modelTokens)
    }
  })
})
