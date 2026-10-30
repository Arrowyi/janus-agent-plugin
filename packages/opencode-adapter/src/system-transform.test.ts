import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { createSystemTransformHook } from "./plugin.ts"

function model(providerID: string, id: string) {
  return { providerID, id }
}

describe("experimental.chat.system.transform", () => {
  let tmpDir: string
  let configPath: string
  let env: NodeJS.ProcessEnv

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "janus-system-transform-"))
    configPath = join(tmpDir, "config.jsonc")
    env = { JANUS_CONFIG: configPath }
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("appends the shipped block for the model actually serving the turn", async () => {
    writeFileSync(configPath, "{}")
    const output = { system: ["base"] }

    await createSystemTransformHook(env)(
      { model: model("opencode-go", "deepseek-v4.1-flash") },
      output,
    )

    expect(output.system).toHaveLength(2)
    expect(output.system[1]).toContain("## Driving DeepSeek V4.1-Flash")
  })

  it("uses a user override for the normalized model key", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({ model_prompts: { deepseekv41flash: "user flash block" } }),
    )
    const output = { system: [] as string[] }

    await createSystemTransformHook(env)(
      { model: model("opencode-go", "deepseek-v4.1-flash") },
      output,
    )

    expect(output.system).toEqual(["user flash block"])
  })

  it("adds nothing when the user disables the block", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({ model_prompts: { deepseekv41flash: "" } }),
    )
    const output = { system: ["base"] }

    await createSystemTransformHook(env)(
      { model: model("opencode-go", "deepseek-v4.1-flash") },
      output,
    )

    expect(output.system).toEqual(["base"])
  })

  it("adds nothing for a model with no shipped or user block", async () => {
    writeFileSync(configPath, "{}")
    const output = { system: ["base"] }

    await createSystemTransformHook(env)(
      { model: model("custom", "unknown-model") },
      output,
    )

    expect(output.system).toEqual(["base"])
  })
})
