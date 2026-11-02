import { describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"

import {
  COST_GUARD_USD_DEFAULT,
  JanusPluginConfigSchema,
  TEAM_CAPS_DEFAULTS,
  TIER_ROLE_CAPS_DEFAULTS,
  loadPluginConfig,
  normalizeWriterDocsRoots,
  resolveCostGuardUsd,
  resolveRoleModel,
  resolveRoleModelChain,
  resolveTeamCaps,
  resolveTierRoleCaps,
  stripJsonc,
  type JanusPluginConfig,
} from "./plugin-config.ts"

// Typed as the schema *input*: parse is the boundary, so partial tier matrices
// without `writer` are expressible and defaulted by parse.
function config(overrides: z.input<typeof JanusPluginConfigSchema> = {}): JanusPluginConfig {
  return JanusPluginConfigSchema.parse(overrides)
}

describe("removed legacy config keys are rejected", () => {
  it("rejects an old top-level key", () => {
    expect(() => JanusPluginConfigSchema.parse({ ask_lite_enabled: false })).toThrow()
  })

  it("rejects old role and mode keys inside mode_models and tier_models", () => {
    expect(() => JanusPluginConfigSchema.parse({ mode_models: { roadmap: { analyst: "x" } } })).toThrow()
    expect(() => JanusPluginConfigSchema.parse({ tier_models: { deep: { lite: "x" } } })).toThrow()
  })

  it("rejects an old tier_role_caps key", () => {
    expect(() =>
      JanusPluginConfigSchema.parse({ tier_role_caps: { fast: { explorer: 5 }, standard: {}, deep: {} } }),
    ).toThrow()
  })

  it("accepts a $schema key", () => {
    const cfg = config({ $schema: "https://example.com/schema.json" })
    expect(cfg.$schema).toBe("https://example.com/schema.json")
  })
})

describe("resolveTeamCaps", () => {
  it("returns defaults when team_caps is unset", () => {
    // given // when // then
    expect(resolveTeamCaps(config())).toEqual(TEAM_CAPS_DEFAULTS)
  })

  it("overrides individual caps", () => {
    // given
    const cfg = config({ team_caps: { round_cap: 2, explorer_cap: 8, critic_search_cap: 6 } })

    // when // then
    expect(resolveTeamCaps(cfg)).toEqual({ round_cap: 2, explorer_cap: 8, critic_search_cap: 6 })
  })
})

describe("resolveTierRoleCaps", () => {
  it("returns defaults when tier_role_caps is unset", () => {
    // given // when // then
    expect(resolveTierRoleCaps(config())).toEqual(TIER_ROLE_CAPS_DEFAULTS)
  })

  it("overrides individual tiers", () => {
    // given
    const cfg = config({
      tier_role_caps: {
        fast: { common_explorer: 5, consultant_analyst: 0, consultant_critic: 0, consultant_auditor: 0 },
        standard: { common_explorer: 5, consultant_analyst: 2, consultant_critic: 1, consultant_auditor: 1 },
        deep: { common_explorer: 5, consultant_analyst: 3, consultant_critic: 2, consultant_auditor: 2 },
      },
    })

    // when // then
    expect(resolveTierRoleCaps(cfg).standard).toEqual({ common_explorer: 5, consultant_analyst: 2, consultant_critic: 1, coder_reviewer: 0, consultant_auditor: 1, author_writer: 0 })
  })
})

describe("resolveCostGuardUsd", () => {
  it("returns the default when unset and the override when set", () => {
    // given // when // then
    expect(resolveCostGuardUsd(config())).toBe(COST_GUARD_USD_DEFAULT)
    expect(resolveCostGuardUsd(config({ cost_guard_provider_usd: 7 }))).toBe(7)
  })
})

describe("JanusPluginConfigSchema", () => {
  it("rejects negative role caps and non-positive caps", () => {
    // given // when // then
    expect(() => config({ tier_role_caps: { fast: { common_explorer: -1, consultant_analyst: 0, consultant_critic: 0, consultant_auditor: 0 }, standard: { common_explorer: 5, consultant_analyst: 1, consultant_critic: 1, consultant_auditor: 1 }, deep: { common_explorer: 5, consultant_analyst: 3, consultant_critic: 2, consultant_auditor: 2 } } })).toThrow()
    expect(() => config({ team_caps: { round_cap: 0, explorer_cap: 5, critic_search_cap: 5 } })).toThrow()
  })
})

describe("model defaults sync (decision 20)", () => {
  it("resolves the synced defaults per role", () => {
    // given // when // then
    expect(resolveRoleModel(config(), "consultant")).toBe("opencode-go/gemini-4-argon")
    expect(resolveRoleModel(config(), "consultant-critic")).toBe("opencode/claude-sonnet-5-5")
    expect(resolveRoleModel(config(), "consultant-auditor")).toBe("opencode-go/grok-4.7")
    expect(resolveRoleModel(config(), "author-writer")).toBe("opencode/claude-sonnet-5-5")
  })

  it("collapses every role to a single-model chain", () => {
    // given // when // then
    expect(resolveRoleModelChain(config(), "author-writer")).toEqual(["opencode/claude-sonnet-5-5"])
    expect(resolveRoleModelChain(config(), "consultant-critic")).toEqual(["opencode/claude-sonnet-5-5"])
    expect(resolveRoleModelChain(config(), "common-explorer")).toEqual(["opencode-go/deepseek-v4.1-flash"])
  })
})

describe("author-writer role configuration", () => {
  it("defaults the packaged author-writer role", () => {
    // given // when
    const cfg = config()

    // then
    expect(cfg.author_writer_agent).toBe("author-writer")
    expect(cfg.author_writer_enabled).toBe(true)
    expect(resolveRoleModel(cfg, "author-writer")).toBe("opencode/claude-sonnet-5-5")
    expect(resolveRoleModelChain(cfg, "author-writer")).toEqual(["opencode/claude-sonnet-5-5"])
    expect(cfg.writer_delegate_agent).toBeUndefined()
    expect(cfg.writer_delegate_model).toBeUndefined()
    expect(resolveTierRoleCaps(cfg).standard.author_writer).toBe(1)
    expect(resolveTierRoleCaps(cfg).deep.author_writer).toBe(2)
  })

  it("overrides the writer model when author_writer_model is set", () => {
    // given
    const cfg = config({ author_writer_model: "anthropic/claude-opus-4-6" })

    // when // then
    expect(resolveRoleModel(cfg, "author-writer")).toBe("anthropic/claude-opus-4-6")
    expect(resolveRoleModelChain(cfg, "author-writer")).toEqual(["anthropic/claude-opus-4-6"])
  })

  it("keeps non-writer roles on a single-model chain", () => {
    // given // when // then
    expect(resolveRoleModelChain(config(), "consultant-critic")).toEqual(["opencode/claude-sonnet-5-5"])
    expect(resolveRoleModelChain(config(), "common-explorer")).toEqual(["opencode-go/deepseek-v4.1-flash"])
  })

  it("accepts writer delegate fields", () => {
    // given
    const cfg = config({ writer_delegate_agent: "host-writer", writer_delegate_model: "p/m" })

    // when // then
    expect(cfg.writer_delegate_agent).toBe("host-writer")
    expect(cfg.writer_delegate_model).toBe("p/m")
  })

  it("defaults writer_docs_roots to [\"userdoc\"] and accepts custom roots and an empty array", () => {
    // given // when
    const defaults = config()
    const custom = config({ writer_docs_roots: ["docs/guides", "userdoc"] })
    const empty = config({ writer_docs_roots: [] })

    // then
    expect(defaults.writer_docs_roots).toEqual(["userdoc"])
    expect(custom.writer_docs_roots).toEqual(["docs/guides", "userdoc"])
    expect(empty.writer_docs_roots).toEqual([])
  })

  it("rejects an empty root string at the schema level; whitespace-only is the normalizer's job", () => {
    // given // when // then
    expect(() => config({ writer_docs_roots: [""] })).toThrow()
    // min(1) counts characters, so "  " passes the schema and is rejected
    // by normalizeWriterDocsRoots (trim -> empty) at config load instead.
    expect(() => normalizeWriterDocsRoots(["userdoc", "  "])).toThrow('invalid writer_docs_roots root "  "')
  })

  it("defaults writer to 0 when a tier matrix omits it", () => {
    // given
    const cfg = config({
      tier_role_caps: {
        fast: { common_explorer: 1, consultant_analyst: 0, consultant_critic: 0, consultant_auditor: 0 },
        standard: { common_explorer: 2, consultant_analyst: 1, consultant_critic: 1, consultant_auditor: 1 },
        deep: { common_explorer: 3, consultant_analyst: 2, consultant_critic: 2, consultant_auditor: 1 },
      },
    })

    // when // then
    expect(resolveTierRoleCaps(cfg).standard.author_writer).toBe(0)
    expect(resolveTierRoleCaps(cfg).fast.author_writer).toBe(0)
    expect(resolveTierRoleCaps(cfg).deep.author_writer).toBe(0)
  })
})

describe("normalizeWriterDocsRoots", () => {
  it("normalizes leading ./ and trailing / and keeps nested relative paths", () => {
    // given // when // then
    expect(normalizeWriterDocsRoots(["./userdoc/"])).toEqual(["userdoc"])
    expect(normalizeWriterDocsRoots(["  ./docs/guides///  "])).toEqual(["docs/guides"])
    expect(normalizeWriterDocsRoots(["docs/guides"])).toEqual(["docs/guides"])
    expect(normalizeWriterDocsRoots([])).toEqual([])
  })

  it("rejects absolute POSIX and Windows-style paths", () => {
    // given // when // then
    expect(() => normalizeWriterDocsRoots(["/abs/root"])).toThrow('invalid writer_docs_roots root "/abs/root"')
    expect(() => normalizeWriterDocsRoots(["C:\\Users\\doc"])).toThrow('invalid writer_docs_roots root "C:\\Users\\doc"')
    expect(() => normalizeWriterDocsRoots(["C:/Users/doc"])).toThrow('invalid writer_docs_roots root "C:/Users/doc"')
  })

  it("rejects ~ shortcuts and any .. segment", () => {
    // given // when // then
    expect(() => normalizeWriterDocsRoots(["~"])).toThrow('invalid writer_docs_roots root "~"')
    expect(() => normalizeWriterDocsRoots(["~/docs"])).toThrow('invalid writer_docs_roots root "~/docs"')
    expect(() => normalizeWriterDocsRoots([".."])).toThrow('invalid writer_docs_roots root ".."')
    expect(() => normalizeWriterDocsRoots(["docs/../userdoc"])).toThrow('invalid writer_docs_roots root "docs/../userdoc"')
  })

  it("rejects roots that normalize to . or empty (the whole project)", () => {
    // given // when // then
    expect(() => normalizeWriterDocsRoots(["."])).toThrow('invalid writer_docs_roots root "."')
    expect(() => normalizeWriterDocsRoots(["./"])).toThrow('invalid writer_docs_roots root "./"')
    expect(() => normalizeWriterDocsRoots([""])).toThrow('invalid writer_docs_roots root ""')
  })

  it("names the invalid root when one of several roots is bad", () => {
    // given // when // then
    expect(() => normalizeWriterDocsRoots(["userdoc", "/etc"])).toThrow('invalid writer_docs_roots root "/etc"')
  })
})

describe("loadPluginConfig validates writer_docs_roots", () => {
  it("rejects an invalid root with an Error that names the config file", async () => {
    // given
    const tmpConfigDir = mkdtempSync(join(tmpdir(), "writer-roots-invalid-"))
    const configPath = join(tmpConfigDir, "config.jsonc")
    writeFileSync(configPath, '{\n  "writer_docs_roots": ["/abs/docs"]\n}')

    try {
      // when // then
      await expect(loadPluginConfig({ JANUS_CONFIG: configPath })).rejects.toThrow(
        `janus-agent config: invalid writer_docs_roots root "/abs/docs"`,
      )
      await expect(loadPluginConfig({ JANUS_CONFIG: configPath })).rejects.toThrow(configPath)
    } finally {
      rmSync(tmpConfigDir, { recursive: true, force: true })
    }
  })

  it("accepts an empty writer_docs_roots array (read-only fallback)", async () => {
    // given
    const tmpConfigDir = mkdtempSync(join(tmpdir(), "writer-roots-empty-"))
    const configPath = join(tmpConfigDir, "config.jsonc")
    writeFileSync(configPath, '{\n  "writer_docs_roots": []\n}')

    try {
      // when
      const cfg = await loadPluginConfig({ JANUS_CONFIG: configPath })

      // then
      expect(cfg.writer_docs_roots).toEqual([])
    } finally {
      rmSync(tmpConfigDir, { recursive: true, force: true })
    }
  })
})

describe("simple, coder, and coder-lite role configuration", () => {
  it("defaults the simple and coder roles and resolves their models", () => {
    // given
    const cfg = config()

    // when // then
    expect(cfg.simple_agent).toBe("simple")
    expect(cfg.simple_enabled).toBe(true)
    expect(cfg.simple_model).toBeUndefined()
    expect(cfg.simple_workspace_dir).toBeUndefined()
    expect(resolveRoleModel(cfg, "simple")).toBe("opencode-go/deepseek-v4.1-flash")
    expect(resolveRoleModelChain(cfg, "simple")).toEqual(["opencode-go/deepseek-v4.1-flash"])
    expect(cfg.coder_agent).toBe("coder")
    expect(cfg.coder_enabled).toBe(true)
    expect(resolveRoleModel(cfg, "coder")).toBe("opencode-go/glm-5.3")
    expect(cfg.coder_lite_agent).toBe("coder-lite")
    expect(cfg.coder_lite_enabled).toBe(true)
    expect(resolveRoleModel(cfg, "coder-lite")).toBe("opencode-go/glm-5.3-flash")
  })

  it("overrides the simple and coder models", () => {
    // given
    const cfg = config({ simple_model: "test/simple-model", coder_model: "test/coder-model", coder_lite_model: "test/glm-flash" })

    // when // then
    expect(resolveRoleModel(cfg, "simple")).toBe("test/simple-model")
    expect(resolveRoleModel(cfg, "coder")).toBe("test/coder-model")
    expect(resolveRoleModel(cfg, "coder-lite")).toBe("test/glm-flash")
  })

  it("accepts a relocated simple workspace dir", () => {
    // given
    const cfg = config({ simple_workspace_dir: "/abs/simple-workspace" })

    // when // then
    expect(cfg.simple_workspace_dir).toBe("/abs/simple-workspace")
  })

  it("rejects an empty simple_workspace_dir instead of widening edit permission to all absolute paths", () => {
    // given // when // then
    expect(() => config({ simple_workspace_dir: "" })).toThrow()
  })

})

describe("coder-lite and coder-reviewer role configuration", () => {
  it("defaults the coder-lite lane and the coder-reviewer", () => {
    // given
    const cfg = config()

    // when // then
    expect(resolveRoleModel(cfg, "coder-lite")).toBe("opencode-go/glm-5.3-flash")
    expect(cfg.coder_reviewer_agent).toBe("coder-reviewer")
    expect(cfg.coder_reviewer_enabled).toBe(true)
    expect(resolveRoleModel(cfg, "coder-reviewer")).toBe("opencode/claude-sonnet-5-5")
  })

  it("overrides coder-lite and coder-reviewer from config", () => {
    // given
    const cfg = config({ coder_lite_model: "test/glm-flash", coder_reviewer_agent: "my-reviewer", coder_reviewer_model: "test/reviewer" })

    // when // then
    expect(resolveRoleModel(cfg, "coder-lite")).toBe("test/glm-flash")
    expect(cfg.coder_reviewer_agent).toBe("my-reviewer")
    expect(resolveRoleModel(cfg, "coder-reviewer")).toBe("test/reviewer")
  })
})

describe("janus role configuration", () => {
  it("defaults the janus role and resolves its model to glm-5.3-flash", () => {
    // given
    const cfg = config()

    // when // then
    expect(cfg.janus_agent).toBe("janus")
    expect(cfg.janus_enabled).toBe(true)
    expect(cfg.janus_model).toBeUndefined()
    expect(resolveRoleModel(cfg, "janus")).toBe("opencode-go/glm-5.3-flash")
    expect(resolveRoleModelChain(cfg, "janus")).toEqual(["opencode-go/glm-5.3-flash"])
  })

  it("overrides the janus model when janus_model is set", () => {
    // given
    const cfg = config({ janus_model: "test/janus-model" })

    // when // then
    expect(resolveRoleModel(cfg, "janus")).toBe("test/janus-model")
  })

  it("defaults the janus role when its keys are unset", () => {
    // given
    const cfg = config({ consultant_model: "opencode-go/glm-5.3" })

    // when // then
    expect(cfg.janus_agent).toBe("janus")
    expect(cfg.janus_enabled).toBe(true)
  })
})

describe("model-prompt config surface (v2)", () => {
  it("parses the global model-keyed prompt map", () => {
    // given
    const cfg = config({ model_prompts: { "opencode-go/glm-5.3": "x" } })

    // when // then
    expect(cfg.model_prompts?.["opencode-go/glm-5.3"]).toBe("x")
  })

  it("accepts an explicit empty string as a disable marker", () => {
    // given
    const cfg = config({ model_prompts: { "opencode-go/deepseek-v4.1-flash": "" } })

    // when // then
    expect(cfg.model_prompts?.["opencode-go/deepseek-v4.1-flash"]).toBe("")
  })

})

describe("stripJsonc", () => {
  it("strips line and block comments so JSON.parse succeeds", () => {
    // given
    const input = '{\n  // line note\n  "a": 1,\n  /* block\n     note */\n  "b": [1, 2]\n}'

    // when
    const parsed = JSON.parse(stripJsonc(input))

    // then
    expect(parsed).toEqual({ a: 1, b: [1, 2] })
  })

  it("strips trailing commas in objects and arrays", () => {
    // given
    const input = '{"a": [1, 2,], "b": {"c": 3,},}'

    // when
    const parsed = JSON.parse(stripJsonc(input))

    // then
    expect(parsed).toEqual({ a: [1, 2], b: { c: 3 } })
  })

  it("catches a trailing comma separated from the closing brace by a comment", () => {
    // given
    const input = '{\n  "a": 1, // why\n}'

    // when
    const parsed = JSON.parse(stripJsonc(input))

    // then
    expect(parsed).toEqual({ a: 1 })
  })

  it("preserves comment-like and comma-like sequences inside strings", () => {
    // given — raw text: {"u": "http://a//b", "c": "/* not a comment */",
    // "q": "she said \" // hi", "p": "C:\\", "t": "[1,]"}
    const input = '{"u": "http://a//b", "c": "/* not a comment */", "q": "she said \\" // hi", "p": "C:\\\\", "t": "[1,]"}'

    // when // then
    expect(stripJsonc(input)).toBe(input)
    expect(JSON.parse(input)).toEqual({ u: "http://a//b", c: "/* not a comment */", q: 'she said " // hi', p: "C:\\", t: "[1,]" })
  })
})

describe("resolveRoleModel precedence", () => {
  it("applies mode > tier > scalar > default", () => {
    const cfg = config({
      consultant_analyst_model: "scalar/model",
      tier_models: { deep: { "consultant-analyst": "tier/model" } },
      mode_models: { research: { "consultant-analyst": "mode/model" } },
    })
    expect(resolveRoleModel(cfg, "consultant-analyst")).toBe("scalar/model")
    expect(resolveRoleModel(cfg, "consultant-analyst", { tier: "deep" })).toBe("tier/model")
    expect(resolveRoleModel(cfg, "consultant-analyst", { mode: "research", tier: "deep" })).toBe("mode/model")
    expect(resolveRoleModel(cfg, "author-writer")).toBe("opencode/claude-sonnet-5-5")
  })

  it("applies the shipped deep-tier coder uplift when the user configures nothing", () => {
    const cfg = config()
    expect(resolveRoleModel(cfg, "coder")).toBe("opencode-go/glm-5.3")
    expect(resolveRoleModel(cfg, "coder", { tier: "deep" })).toBe("opencode-go/kimi-k3.1-pro")
    expect(resolveRoleModel(cfg, "coder", { tier: "standard" })).toBe("opencode-go/glm-5.3")
  })

  it("lets an explicit user model beat the shipped deep-tier default", () => {
    const cfg = config({ coder_model: "scalar/coder" })
    expect(resolveRoleModel(cfg, "coder", { tier: "deep" })).toBe("scalar/coder")
  })
})

describe("architect and author team entries", () => {
  it("defaults the architect and author entries", () => {
    const cfg = config()
    expect(cfg.architect_agent).toBe("architect")
    expect(cfg.architect_enabled).toBe(true)
    expect(resolveRoleModel(cfg, "architect")).toBe("opencode-go/gemini-4-argon")
    expect(cfg.author_agent).toBe("author")
    expect(cfg.author_enabled).toBe(true)
    expect(resolveRoleModel(cfg, "author")).toBe("opencode-go/gemini-4-argon")
  })

  it("inherits an explicitly configured consultant model before falling back to defaults", () => {
    const cfg = config({ consultant_model: "custom/consultant" })
    expect(resolveRoleModel(cfg, "architect")).toBe("custom/consultant")
    expect(resolveRoleModel(cfg, "author")).toBe("custom/consultant")
  })

  it("lets explicit architect and author models win over the consultant fallback", () => {
    const cfg = config({
      consultant_model: "custom/consultant",
      architect_model: "custom/architect",
      author_model: "custom/author",
    })
    expect(resolveRoleModel(cfg, "architect")).toBe("custom/architect")
    expect(resolveRoleModel(cfg, "author")).toBe("custom/author")
  })
})
