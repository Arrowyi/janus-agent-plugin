import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { createHash } from "node:crypto"
import { readFile } from "node:fs/promises"
import type { Plugin, PluginInput, Config } from "@opencode-ai/plugin"
import { JanusAgentPlugin, createJanusConfigHook } from "./plugin.ts"
import { computeProjectId } from "./agent-registration.ts"
import { resolveAsset } from "./asset-paths.ts"
import { computeNamespace } from "./namespace.ts"

function makeTempHome(): string {
  return mkdtempSync(join(tmpdir(), "plugin-integration-"))
}

describe("createJanusConfigHook", () => {
  const savedEnv: Record<string, string | undefined> = {}
  const envKeys = ["JANUS_CONFIG", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "HOME", "OPENCODE_CONFIG_DIR"]

  beforeEach(() => {
    for (const key of envKeys) savedEnv[key] = process.env[key]
  })

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
  })

  it("registers config.agent.consultant with mode primary and the consultant.md body plus runtime bindings", async () => {
    // given
    const tmpHome = makeTempHome()
    process.env.HOME = tmpHome
    delete process.env.JANUS_CONFIG
    delete process.env.XDG_CONFIG_HOME
    process.env.OPENCODE_CONFIG_DIR = tmpHome
    const config: Config = {}
    const hook = createJanusConfigHook({ id: "proj-123" }, "/tmp/project")

    try {
      // when
      await hook(config)

      // then
      expect(config.agent).toBeDefined()
      const consultant = config.agent?.["consultant"] as { mode: string; prompt: string }
      expect(consultant.mode).toBe("primary")
      expect(consultant.prompt).toContain("# Consultant")
      expect(consultant.prompt).toContain("## Runtime Bindings (injected by opencode-adapter)")
    } finally {
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it("registers design-dir permissions and bindings for the consultant and coder", async () => {
    // given
    const tmpHome = makeTempHome()
    process.env.HOME = tmpHome
    delete process.env.JANUS_CONFIG
    delete process.env.XDG_CONFIG_HOME
    process.env.OPENCODE_CONFIG_DIR = tmpHome
    const projectDir = "/tmp/project"
    const config: Config = {}
    const hook = createJanusConfigHook({ id: "proj-123" }, projectDir)

    try {
      // when
      await hook(config)

      // then
      const designDir = join(tmpHome, ".local/share/janus-agent/design")
      const authorDir = join(tmpHome, ".local/share/janus-agent/author")
      const projectId = computeProjectId(projectDir)
      const consultant = config.agent?.["consultant"] as {
        prompt: string
        permission: Record<string, unknown>
      }
      const coder = config.agent?.["coder"] as {
        prompt: string
        permission: Record<string, unknown>
      }
      const consultantExternal = consultant.permission.external_directory as Record<string, string>
      const coderExternal = coder.permission.external_directory as Record<string, string>

      expect(consultantExternal[`${designDir}/**`]).toBe("allow")
      expect(consultantExternal[`${authorDir}/**`]).toBe("allow")
      expect(coderExternal[`${designDir}/**`]).toBe("allow")
      expect(consultant.prompt).toContain(`Design state dir: \`${designDir}\``)
      expect(consultant.prompt).toContain(`project id: \`${projectId}\``)
      expect(coder.prompt).toContain(`Design record: \`${designDir}/${projectId}\``)
      expect(existsSync(designDir)).toBe(true)
    } finally {
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })


  it("registers the full team: explorer, analyst, critic, arch-critic, and auditor subagents with default models", async () => {
    // given
    const tmpHome = makeTempHome()
    process.env.HOME = tmpHome
    delete process.env.JANUS_CONFIG
    delete process.env.XDG_CONFIG_HOME
    process.env.OPENCODE_CONFIG_DIR = tmpHome
    const config: Config = {}
    const hook = createJanusConfigHook({ id: "proj-123" }, "/tmp/project")

    try {
      // when
      await hook(config)

      // then
      const consultant = config.agent?.["consultant"] as { model: string }
      expect(consultant.model).toBe("opencode-go/glm-5.3")
      const explorer = config.agent?.["explorer"] as { mode: string; model: string }
      expect(explorer.mode).toBe("subagent")
      expect(explorer.model).toBe("opencode-go/deepseek-v4.1-flash")
      const analyst = config.agent?.["analyst"] as { mode: string; model: string }
      expect(analyst.mode).toBe("subagent")
      expect(analyst.model).toBe("opencode-go/qwen3.8-max")
      const critic = config.agent?.["critic"] as { mode: string; model: string }
      expect(critic.mode).toBe("subagent")
      expect(critic.model).toBe("opencode/gemini-3.8-flash")
      expect(config.agent?.["arch-critic"]).toMatchObject({
        mode: "subagent",
        model: "opencode/gemini-3.8-flash",
      })
      expect(config.agent?.["auditor"]).toMatchObject({
        mode: "subagent",
        model: "opencode/gemini-3.8-flash",
      })
    } finally {
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it("registers the writer subagent by default with scoped-write permission over userdoc", async () => {
    // given
    const tmpHome = makeTempHome()
    process.env.HOME = tmpHome
    delete process.env.JANUS_CONFIG
    delete process.env.XDG_CONFIG_HOME
    delete process.env.XDG_DATA_HOME
    process.env.OPENCODE_CONFIG_DIR = tmpHome
    const config: Config = {}
    const hook = createJanusConfigHook({ id: "proj-123" }, "/tmp/project")

    try {
      // when
      await hook(config)

      // then
      const writer = config.agent?.["writer"] as {
        mode: string
        description: string
        steps: number
        permission: Record<string, unknown>
        prompt: string
      }
      expect(writer.mode).toBe("subagent")
      expect(writer.steps).toBe(80)
      expect(writer.description).toContain("sole author of reader-facing prose")
      expect(writer.permission.bash).toBe("deny")
      expect(writer.permission.task).toBe("deny")
      expect(writer.permission.webfetch).toBe("allow")
      expect(writer.permission.websearch).toBe("allow")
      const edit = writer.permission.edit as Record<string, string>
      expect(edit["*"]).toBe("deny")
      expect(edit["userdoc/**"]).toBe("allow")
      const authorDir = join(tmpHome, ".local", "share", "janus-agent", "author")
      const external = writer.permission.external_directory as Record<string, string>
      expect(external[`${authorDir}/**`]).toBe("allow")
      expect(writer.prompt).toContain("Write mode: `scoped`")
      // the author state dir is created at registration
      expect(existsSync(authorDir)).toBe(true)
    } finally {
      delete process.env.XDG_DATA_HOME
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it("scopes the writer permission to writer_docs_roots from the plugin config", async () => {
    // given
    const tmpHome = makeTempHome()
    const tmpConfigDir = mkdtempSync(join(tmpdir(), "plugin-cfg-writerroots-"))
    const configPath = join(tmpConfigDir, "config.jsonc")
    writeFileSync(configPath, '{\n  "writer_docs_roots": ["./docs/guides/", "userdoc"]\n}')
    process.env.HOME = tmpHome
    process.env.JANUS_CONFIG = configPath
    delete process.env.XDG_CONFIG_HOME
    delete process.env.XDG_DATA_HOME
    process.env.OPENCODE_CONFIG_DIR = tmpHome
    const config: Config = {}
    const hook = createJanusConfigHook({ id: "proj-123" }, "/tmp/project")

    try {
      // when
      await hook(config)

      // then
      const writer = config.agent?.["writer"] as { permission: Record<string, unknown> }
      const edit = writer.permission.edit as Record<string, string>
      expect(edit["docs/guides/**"]).toBe("allow")
      expect(edit["userdoc/**"]).toBe("allow")
      // Root allow rules are also anchored to the hook's project directory in
      // absolute form (as supplied and without the leading slash) so the
      // writer's absolute-path tool calls match an allow rule.
      expect(edit["/tmp/project/docs/guides/**"]).toBe("allow")
      expect(edit["/tmp/project/userdoc/**"]).toBe("allow")
      expect(edit["tmp/project/userdoc/**"]).toBe("allow")
    } finally {
      delete process.env.XDG_DATA_HOME
      rmSync(tmpHome, { recursive: true, force: true })
      rmSync(tmpConfigDir, { recursive: true, force: true })
    }
  })

  it("registers a read-only writer when writer_docs_roots is empty", async () => {
    // given
    const tmpHome = makeTempHome()
    const tmpConfigDir = mkdtempSync(join(tmpdir(), "plugin-cfg-writerempty-"))
    const configPath = join(tmpConfigDir, "config.jsonc")
    writeFileSync(configPath, '{\n  "writer_docs_roots": []\n}')
    process.env.HOME = tmpHome
    process.env.JANUS_CONFIG = configPath
    delete process.env.XDG_CONFIG_HOME
    delete process.env.XDG_DATA_HOME
    process.env.OPENCODE_CONFIG_DIR = tmpHome
    const config: Config = {}
    const hook = createJanusConfigHook({ id: "proj-123" }, "/tmp/project")

    try {
      // when
      await hook(config)

      // then
      const writer = config.agent?.["writer"] as {
        permission: Record<string, unknown>
        prompt: string
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
      delete process.env.XDG_DATA_HOME
      rmSync(tmpHome, { recursive: true, force: true })
      rmSync(tmpConfigDir, { recursive: true, force: true })
    }
  })

  it("rejects invalid writer_docs_roots with an error naming the config file", async () => {
    // given
    const tmpHome = makeTempHome()
    const tmpConfigDir = mkdtempSync(join(tmpdir(), "plugin-cfg-writerinvalid-"))
    const configPath = join(tmpConfigDir, "config.jsonc")
    writeFileSync(configPath, '{\n  "writer_docs_roots": ["/abs/docs"]\n}')
    process.env.HOME = tmpHome
    process.env.JANUS_CONFIG = configPath
    delete process.env.XDG_CONFIG_HOME
    process.env.OPENCODE_CONFIG_DIR = tmpHome
    const config: Config = {}
    const hook = createJanusConfigHook({ id: "proj-123" }, "/tmp/project")

    try {
      // when / then
      await expect(hook(config)).rejects.toThrow('invalid writer_docs_roots root "/abs/docs"')
      await expect(hook(config)).rejects.toThrow(configPath)
    } finally {
      rmSync(tmpHome, { recursive: true, force: true })
      rmSync(tmpConfigDir, { recursive: true, force: true })
    }
  })

  it("includes the author brief path in the consultant prompt", async () => {
    // given
    const tmpHome = makeTempHome()
    process.env.HOME = tmpHome
    delete process.env.JANUS_CONFIG
    delete process.env.XDG_CONFIG_HOME
    delete process.env.XDG_DATA_HOME
    process.env.OPENCODE_CONFIG_DIR = tmpHome
    const config: Config = {}
    const projectDirectory = "/tmp/project"
    const hook = createJanusConfigHook({ id: "proj-123" }, projectDirectory)

    try {
      // when
      await hook(config)

      // then
      const consultant = config.agent?.["consultant"] as { prompt: string }
      const authorDir = join(tmpHome, ".local", "share", "janus-agent", "author")
      const projectId = computeProjectId(projectDirectory)
      expect(consultant.prompt).toContain(`Author state dir: \`${authorDir}\``)
      expect(consultant.prompt).toContain(`project id: \`${projectId}\``)
      expect(consultant.prompt).toContain(`${authorDir}/${projectId}/<docId>/brief.md`)
    } finally {
      delete process.env.XDG_DATA_HOME
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })


  it("omits the ask-lite agent when ask_lite_enabled=false", async () => {
    // given
    const tmpHome = makeTempHome()
    const tmpConfigDir = mkdtempSync(join(tmpdir(), "plugin-cfg-liteoff-"))
    const configPath = join(tmpConfigDir, "config.jsonc")
    writeFileSync(configPath, '{\n  "ask_lite_enabled": false\n}')
    process.env.HOME = tmpHome
    process.env.JANUS_CONFIG = configPath
    delete process.env.XDG_CONFIG_HOME
    process.env.OPENCODE_CONFIG_DIR = tmpHome
    const config: Config = {}
    const hook = createJanusConfigHook({ id: "proj-123" }, "/tmp/project")

    try {
      // when
      await hook(config)

      // then
      expect(config.agent?.["ask-lite"]).toBeUndefined()
      const consultant = config.agent?.["consultant"] as { prompt: string }
      expect(consultant.prompt).toContain("ask-lite DISABLED by configuration")
    } finally {
      rmSync(tmpHome, { recursive: true, force: true })
      rmSync(tmpConfigDir, { recursive: true, force: true })
    }
  })


  it("omits coder-lite when coder_lite_enabled=false", async () => {
    // given
    const tmpHome = makeTempHome()
    const tmpConfigDir = mkdtempSync(join(tmpdir(), "plugin-cfg-coderliteoff-"))
    const configPath = join(tmpConfigDir, "config.jsonc")
    writeFileSync(configPath, '{\n  "coder_lite_enabled": false\n}')
    process.env.HOME = tmpHome
    process.env.JANUS_CONFIG = configPath
    delete process.env.XDG_CONFIG_HOME
    delete process.env.XDG_DATA_HOME
    process.env.OPENCODE_CONFIG_DIR = tmpHome
    const config: Config = {}
    const hook = createJanusConfigHook({ id: "proj-123" }, "/tmp/project")

    try {
      // when
      await hook(config)

      // then
      expect(config.agent?.["coder-lite"]).toBeUndefined()
      const coder = config.agent?.["coder"] as { prompt: string }
      expect(coder.prompt).toContain("coder-lite DISABLED by configuration")
    } finally {
      delete process.env.XDG_DATA_HOME
      rmSync(tmpHome, { recursive: true, force: true })
      rmSync(tmpConfigDir, { recursive: true, force: true })
    }
  })


  it("omits the janus agent when janus_enabled=false", async () => {
    // given
    const tmpHome = makeTempHome()
    const tmpConfigDir = mkdtempSync(join(tmpdir(), "plugin-cfg-janusoff-"))
    const configPath = join(tmpConfigDir, "config.jsonc")
    writeFileSync(configPath, '{\n  "janus_enabled": false\n}')
    process.env.HOME = tmpHome
    process.env.JANUS_CONFIG = configPath
    delete process.env.XDG_CONFIG_HOME
    process.env.OPENCODE_CONFIG_DIR = tmpHome
    const config: Config = {}
    const hook = createJanusConfigHook({ id: "proj-123" }, "/tmp/project")

    try {
      // when
      await hook(config)

      // then
      expect(config.agent?.["janus"]).toBeUndefined()
      expect(config.agent?.["consultant"]).toBeDefined()
    } finally {
      rmSync(tmpHome, { recursive: true, force: true })
      rmSync(tmpConfigDir, { recursive: true, force: true })
    }
  })

  it("omits the bundled writer subagent when a delegate agent is configured", async () => {
    // given
    const tmpHome = makeTempHome()
    const tmpConfigDir = mkdtempSync(join(tmpdir(), "plugin-cfg-writerdelegate-"))
    const configPath = join(tmpConfigDir, "config.jsonc")
    writeFileSync(configPath, '{\n  "writer_delegate_agent": "host-writer"}')
    process.env.HOME = tmpHome
    process.env.JANUS_CONFIG = configPath
    delete process.env.XDG_CONFIG_HOME
    process.env.OPENCODE_CONFIG_DIR = tmpHome
    const config: Config = {}
    const hook = createJanusConfigHook({ id: "proj-123" }, "/tmp/project")

    try {
      // when
      await hook(config)

      // then
      expect(config.agent?.["writer"]).toBeUndefined()
    } finally {
      rmSync(tmpHome, { recursive: true, force: true })
      rmSync(tmpConfigDir, { recursive: true, force: true })
    }
  })

  it("omits the writer subagent when writer_enabled=false", async () => {
    // given
    const tmpHome = makeTempHome()
    const tmpConfigDir = mkdtempSync(join(tmpdir(), "plugin-cfg-writeroff-"))
    const configPath = join(tmpConfigDir, "config.jsonc")
    writeFileSync(configPath, '{\n  "writer_enabled": false}')
    process.env.HOME = tmpHome
    process.env.JANUS_CONFIG = configPath
    delete process.env.XDG_CONFIG_HOME
    process.env.OPENCODE_CONFIG_DIR = tmpHome
    const config: Config = {}
    const hook = createJanusConfigHook({ id: "proj-123" }, "/tmp/project")

    try {
      // when
      await hook(config)

      // then
      expect(config.agent?.["writer"]).toBeUndefined()
    } finally {
      rmSync(tmpHome, { recursive: true, force: true })
      rmSync(tmpConfigDir, { recursive: true, force: true })
    }
  })

  it("still registers explorer and analyst when critic_enabled=false", async () => {
    // given
    const tmpHome = makeTempHome()
    const tmpConfigDir = mkdtempSync(join(tmpdir(), "plugin-cfg-critoff2-"))
    const configPath = join(tmpConfigDir, "config.jsonc")
    writeFileSync(configPath, '{\n  "critic_enabled": false\n}')
    process.env.HOME = tmpHome
    process.env.JANUS_CONFIG = configPath
    delete process.env.XDG_CONFIG_HOME
    process.env.OPENCODE_CONFIG_DIR = tmpHome
    const config: Config = {}
    const hook = createJanusConfigHook({ id: "proj-123" }, "/tmp/project")

    try {
      // when
      await hook(config)

      // then
      expect(config.agent?.["critic"]).toBeUndefined()
      expect(config.agent?.["explorer"]).toBeDefined()
      expect(config.agent?.["analyst"]).toBeDefined()
    } finally {
      rmSync(tmpHome, { recursive: true, force: true })
      rmSync(tmpConfigDir, { recursive: true, force: true })
    }
  })

  it("omits the critic subagent when critic_enabled=false", async () => {
    // given
    const tmpHome = makeTempHome()
    const tmpConfigDir = mkdtempSync(join(tmpdir(), "plugin-cfg-critoff-"))
    const configPath = join(tmpConfigDir, "config.jsonc")
    writeFileSync(configPath, '{\n  "critic_enabled": false\n}')
    process.env.HOME = tmpHome
    process.env.JANUS_CONFIG = configPath
    delete process.env.XDG_CONFIG_HOME
    process.env.OPENCODE_CONFIG_DIR = tmpHome
    const config: Config = {}
    const hook = createJanusConfigHook({ id: "proj-123" }, "/tmp/project")

    try {
      // when
      await hook(config)

      // then
      expect(config.agent?.["critic"]).toBeUndefined()
    } finally {
      rmSync(tmpHome, { recursive: true, force: true })
      rmSync(tmpConfigDir, { recursive: true, force: true })
    }
  })



  it("registers config.mcp.janus-memory as local with enabled true and JANUS_NAMESPACE when memory enabled", async () => {
    // given
    const tmpHome = makeTempHome()
    process.env.HOME = tmpHome
    delete process.env.JANUS_CONFIG
    delete process.env.XDG_CONFIG_HOME
    process.env.OPENCODE_CONFIG_DIR = tmpHome
    const config: Config = {}
    const hook = createJanusConfigHook({ id: "proj-123" }, "/tmp/project")

    try {
      // when
      await hook(config)

      // then
      expect(config.mcp).toBeDefined()
      const mcp = config.mcp?.["janus-memory"] as {
        type: string
        command: string[]
        enabled: boolean
        environment: Record<string, string>
      }
      expect(mcp.type).toBe("local")
      expect(mcp.enabled).toBe(true)
      expect(mcp.command).toHaveLength(2)
      expect(mcp.environment.JANUS_NAMESPACE).toBe(computeNamespace("proj-123", "/tmp/project"))
    } finally {
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it("omits the MCP entry when memory_enabled=false", async () => {
    // given
    const tmpHome = makeTempHome()
    const tmpConfigDir = mkdtempSync(join(tmpdir(), "plugin-cfg-memoff-"))
    const configPath = join(tmpConfigDir, "config.jsonc")
    writeFileSync(configPath, '{\n  "memory_enabled": false\n}')
    process.env.HOME = tmpHome
    process.env.JANUS_CONFIG = configPath
    delete process.env.XDG_CONFIG_HOME
    process.env.OPENCODE_CONFIG_DIR = tmpHome
    const config: Config = {}
    const hook = createJanusConfigHook({ id: "proj-123" }, "/tmp/project")

    try {
      // when
      await hook(config)

      // then
      expect(config.mcp?.["janus-memory"]).toBeUndefined()
    } finally {
      rmSync(tmpHome, { recursive: true, force: true })
      rmSync(tmpConfigDir, { recursive: true, force: true })
    }
  })


  it("skill install writes all three SKILL.md files when missing", async () => {
    // given
    const tmpHome = makeTempHome()
    process.env.HOME = tmpHome
    delete process.env.JANUS_CONFIG
    delete process.env.XDG_CONFIG_HOME
    process.env.OPENCODE_CONFIG_DIR = tmpHome
    const skills = ["consultation", "consultation-design", "consultation-doc"] as const
    for (const name of skills) expect(existsSync(join(tmpHome, "skills", name, "SKILL.md"))).toBe(false)
    const config: Config = {}
    const hook = createJanusConfigHook({ id: "proj-123" }, "/tmp/project")

    try {
      // when
      await hook(config)

      // then
      for (const name of skills) {
        const targetFile = join(tmpHome, "skills", name, "SKILL.md")
        expect(existsSync(targetFile)).toBe(true)
        const assetContent = await readFile(resolveAsset(`skills/${name}/SKILL.md`), "utf8")
        expect(readFileSync(targetFile, "utf8")).toBe(assetContent)
      }
    } finally {
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })


  it("installs both slash commands when install_commands is true", async () => {
    // given
    const tmpHome = makeTempHome()
    process.env.HOME = tmpHome
    delete process.env.JANUS_CONFIG
    delete process.env.XDG_CONFIG_HOME
    process.env.OPENCODE_CONFIG_DIR = tmpHome
    const config: Config = {}
    const hook = createJanusConfigHook({ id: "proj-123" }, "/tmp/project")

    try {
      // when
      await hook(config)

      // then
      expect(existsSync(join(tmpHome, "commands", "janus-memory.md"))).toBe(true)
      expect(existsSync(join(tmpHome, "commands", "janus-models.md"))).toBe(true)
    } finally {
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it("installs neither slash command when install_commands is false", async () => {
    // given
    const tmpHome = makeTempHome()
    const janusConfigDir = join(tmpHome, ".config", "janus-agent")
    mkdirSync(janusConfigDir, { recursive: true })
    writeFileSync(join(janusConfigDir, "config.jsonc"), '{\n  "install_commands": false\n}')
    process.env.HOME = tmpHome
    delete process.env.JANUS_CONFIG
    delete process.env.XDG_CONFIG_HOME
    process.env.OPENCODE_CONFIG_DIR = tmpHome
    const config: Config = {}
    const hook = createJanusConfigHook({ id: "proj-123" }, "/tmp/project")

    try {
      // when
      await hook(config)

      // then
      expect(existsSync(join(tmpHome, "commands", "janus-memory.md"))).toBe(false)
      expect(existsSync(join(tmpHome, "commands", "janus-models.md"))).toBe(false)
    } finally {
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it("namespace is oc- plus first 12 hex chars of sha256 of project.id", async () => {
    // given
    const tmpHome = makeTempHome()
    process.env.HOME = tmpHome
    delete process.env.JANUS_CONFIG
    delete process.env.XDG_CONFIG_HOME
    process.env.OPENCODE_CONFIG_DIR = tmpHome
    const config: Config = {}
    const projectId = "namespace-test-id"
    const expectedNs = "oc-" + createHash("sha256").update(projectId).digest("hex").slice(0, 12)
    const hook = createJanusConfigHook({ id: projectId }, "/tmp/project")

    try {
      // when
      await hook(config)

      // then
      const mcp = config.mcp?.["janus-memory"] as {
        environment: Record<string, string>
      }
      expect(mcp.environment.JANUS_NAMESPACE).toBe(expectedNs)
    } finally {
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it("plugin config loads from $JANUS_CONFIG", async () => {
    // given
    const tmpHome = makeTempHome()
    const tmpConfigDir = mkdtempSync(join(tmpdir(), "plugin-cfg-direct-"))
    const configPath = join(tmpConfigDir, "custom.jsonc")
    writeFileSync(configPath, '{\n  "agent_model": "test/model"\n}')
    process.env.HOME = tmpHome
    process.env.JANUS_CONFIG = configPath
    delete process.env.XDG_CONFIG_HOME
    process.env.OPENCODE_CONFIG_DIR = tmpHome
    const config: Config = {}
    const hook = createJanusConfigHook({ id: "proj-123" }, "/tmp/project")

    try {
      // when
      await hook(config)

      // then
      const consultant = config.agent?.["consultant"] as { model?: string }
      expect(consultant.model).toBe("test/model")
    } finally {
      rmSync(tmpHome, { recursive: true, force: true })
      rmSync(tmpConfigDir, { recursive: true, force: true })
    }
  })

  it("plugin config loads from $XDG_CONFIG_HOME/janus-agent/config.jsonc when JANUS_CONFIG is unset", async () => {
    // given
    const xdgHome = mkdtempSync(join(tmpdir(), "plugin-cfg-xdg-int-"))
    const consultationConfigDir = join(xdgHome, "janus-agent")
    mkdirSync(consultationConfigDir, { recursive: true })
    writeFileSync(join(consultationConfigDir, "config.jsonc"), '{\n  "critic_agent": "xdg-critic"\n}')
    const tmpHome = makeTempHome()
    process.env.HOME = tmpHome
    delete process.env.JANUS_CONFIG
    process.env.XDG_CONFIG_HOME = xdgHome
    process.env.OPENCODE_CONFIG_DIR = tmpHome
    const config: Config = {}
    const hook = createJanusConfigHook({ id: "proj-123" }, "/tmp/project")

    try {
      // when
      await hook(config)

      // then
      const consultant = config.agent?.["consultant"] as { prompt: string }
      expect(consultant.prompt).toContain("xdg-critic")
    } finally {
      rmSync(xdgHome, { recursive: true, force: true })
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it("plugin config loads from ~/.config/janus-agent/config.jsonc when no env overrides", async () => {
    // given
    const tmpHome = makeTempHome()
    const consultationConfigDir = join(tmpHome, ".config", "janus-agent")
    mkdirSync(consultationConfigDir, { recursive: true })
    writeFileSync(join(consultationConfigDir, "config.jsonc"), '{\n  "install_skill": false\n}')
    process.env.HOME = tmpHome
    delete process.env.JANUS_CONFIG
    delete process.env.XDG_CONFIG_HOME
    process.env.OPENCODE_CONFIG_DIR = tmpHome
    const targetFile = join(tmpHome, "skills", "consultation", "SKILL.md")
    const config: Config = {}
    const hook = createJanusConfigHook({ id: "proj-123" }, "/tmp/project")

    try {
      // when
      await hook(config)

      // then — install_skill=false means no SKILL.md written
      expect(existsSync(targetFile)).toBe(false)
      expect(existsSync(join(tmpHome, "skills", "consultation-design", "SKILL.md"))).toBe(false)
      // but the agent is still registered
      expect(config.agent?.["consultant"]).toBeDefined()
    } finally {
      rmSync(tmpHome, { recursive: true, force: true })
    }
  })

  it("rejects invalid config with a thrown Error", async () => {
    // given
    const tmpConfigDir = mkdtempSync(join(tmpdir(), "plugin-cfg-invalid-"))
    const configPath = join(tmpConfigDir, "bad.jsonc")
    writeFileSync(configPath, '{\n  "memory_enabled": 42\n}')
    process.env.HOME = makeTempHome()
    process.env.JANUS_CONFIG = configPath
    delete process.env.XDG_CONFIG_HOME
    const config: Config = {}
    const hook = createJanusConfigHook({ id: "proj-123" }, "/tmp/project")

    try {
      // when / then
      await expect(hook(config)).rejects.toThrow()
    } finally {
      rmSync(tmpConfigDir, { recursive: true, force: true })
    }
  })
})

describe("JanusAgentPlugin", () => {
  it("is a function that returns a Promise of hooks with a config property", async () => {
    // given
    const input: PluginInput = {
      project: { id: "wiring-test", worktree: "/wt", time: { created: 0 } },
      directory: "/tmp/project",
      worktree: "/wt",
      experimental_workspace: { register: () => {} },
      serverUrl: new URL("http://localhost:3000"),
      client: undefined as never,
      $: undefined as never,
    }

    // when
    const hooks = await JanusAgentPlugin(input)

    // then
    expect(typeof hooks.config).toBe("function")
  })

  it("registers exactly the four consultation dispatch tools", async () => {
    // given
    const input: PluginInput = {
      project: { id: "wiring-test", worktree: "/wt", time: { created: 0 } },
      directory: "/tmp/project",
      worktree: "/wt",
      experimental_workspace: { register: () => {} },
      serverUrl: new URL("http://localhost:3000"),
      client: undefined as never,
      $: undefined as never,
    }

    // when
    const hooks = await JanusAgentPlugin(input)

    // then
    expect(hooks.tool).toBeDefined()
    expect(Object.keys(hooks.tool ?? {})).toEqual([
      "janus_dispatch",
      "janus_dispatch_wait",
      "janus_dispatch_cancel",
      "janus_dispatch_continue",
    ])
    expect(hooks.tool?.["janus_dispatch"]).toBeDefined()
    expect(hooks.tool?.["janus_dispatch_continue"]).toBeDefined()
  })

  it("is typed as Plugin", () => {
    // then — the export is assignable to Plugin
    const p: Plugin = JanusAgentPlugin
    expect(typeof p).toBe("function")
  })
})
