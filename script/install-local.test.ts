import { describe, expect, test } from "bun:test"
import { REQUIRED_INSTALLED_FILES, keysShimContent, resolveInstallRoot } from "./install-local.ts"

describe("resolveInstallRoot", () => {
  test("uses JANUS_INSTALL_DIR when present", () => {
    const env: NodeJS.ProcessEnv = {
      JANUS_INSTALL_DIR: "/tmp/stage/janus-agent-plugin",
    }

    const root = resolveInstallRoot(env)

    expect(root).toBe("/tmp/stage/janus-agent-plugin")
  })

  test("falls back to XDG_DATA_HOME when JANUS_INSTALL_DIR is absent", () => {
    const env: NodeJS.ProcessEnv = {
      XDG_DATA_HOME: "/tmp/xdg-data",
    }

    const root = resolveInstallRoot(env)

    expect(root).toBe("/tmp/xdg-data/janus-agent-plugin")
  })

  test("falls back to HOME/.local/share when no XDG override is set", () => {
    const env: NodeJS.ProcessEnv = {
      HOME: "/home/dev",
    }

    const root = resolveInstallRoot(env)

    expect(root).toBe("/home/dev/.local/share/janus-agent-plugin")
  })
})

describe("REQUIRED_INSTALLED_FILES", () => {
  test("requires the packaged writer agent asset", () => {
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/agents/author-writer.md")
  })

  test("requires the packaged reviewer agent asset and the user-facing-style fragment", () => {
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/agents/author-reviewer.md")
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/principles/user-facing-style.md")
  })

  test("requires both shared common principle assets", () => {
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/principles/common-base.md")
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/principles/common-write.md")
  })

  test("requires the reasoning-failure fragment", () => {
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/principles/reasoning-failures.md")
  })

  test("requires the shared prompt fragments", () => {
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/principles/research-leaf.md")
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/principles/dispatch-hub.md")
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/principles/mode-routing.md")
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/principles/claim-types.md")
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/principles/source-criteria.md")
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/principles/channel-policy.md")
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/principles/engineering-principles.md")
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/principles/user-facing-style.md")
  })

  test("requires the janus-models and janus-handoff command assets", () => {
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/commands/janus-models.md")
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/commands/janus-handoff.md")
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/commands/janus-config.md")
  })

  test("requires the bundled janus-keys CLI and its shim", () => {
    expect(REQUIRED_INSTALLED_FILES).toContain("dist/janus-keys.js")
    expect(REQUIRED_INSTALLED_FILES).toContain("bin/janus-keys")
    expect(keysShimContent("/opt/janus")).toBe('#!/bin/sh\nexec bun "/opt/janus/dist/janus-keys.js" "$@"\n')
  })

  test("requires the bundled entry points, role assets, protocols, and three skills", () => {
    expect(REQUIRED_INSTALLED_FILES).toContain("dist/index.js")
    expect(REQUIRED_INSTALLED_FILES).toContain("dist/memory-mcp-server.js")
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/agents/consultant.md")
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/agents/coder-reviewer.md")
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/agents/consultant-auditor.md")
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/agents/consultant-critic.md")
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/protocols/counter_evidence.md")
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/protocols/code_plan_review.md")
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/skills/consultation/SKILL.md")
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/skills/consultation-design/SKILL.md")
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/skills/consultation-doc/SKILL.md")
  })

  test("requires the coder, simple, and coder-lite agents and the shipped model-prompt library", () => {
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/agents/coder.md")
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/agents/simple.md")
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/agents/coder-lite.md")
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/model-prompts/claudesonnet55.md")
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/model-prompts/gemini38flash.md")
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/model-prompts/gemini4argon.md")
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/model-prompts/deepseekflash.md")
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/model-prompts/deepseekv41flash.md")
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/model-prompts/glm53flash.md")
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/model-prompts/glm53.md")
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/model-prompts/grok47.md")
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/model-prompts/kimik31pro.md")
    expect(REQUIRED_INSTALLED_FILES).toContain("assets/model-prompts/qwen38max.md")
  })
})
