import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { existsSync } from "node:fs"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { LEAF_DISPATCH_DENY } from "./agent-registration.ts"
import { CONFIG_TOOL_NAME, createJanusConfigTool, runConfigAction } from "./config-tool.ts"

let dir: string
let configPath: string
let env: NodeJS.ProcessEnv

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "janus-config-tool-"))
  configPath = join(dir, "config.jsonc")
  env = { JANUS_CONFIG: configPath }
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("janus_config tool", () => {
  test("is denied to every leaf role", () => {
    expect(LEAF_DISPATCH_DENY).toMatchObject({ [CONFIG_TOOL_NAME]: "deny" })
  })

  test("defines a tool with the action argument", () => {
    const definition = createJanusConfigTool({ env })
    expect(definition.description).toContain("apply")
    expect(Object.keys(definition.args)).toEqual(["action", "key", "value", "apply"])
  })

  test("catalog overview lists the path and every group", async () => {
    const out = await runConfigAction({ action: "catalog" }, env)
    expect(out).toContain(configPath)
    expect(out).toContain("尚不存在")
    expect(out).toContain("1. 角色开关与名称")
    expect(out).toContain("9. 安装与其他")
    expect(out).toContain("10. Provider 密钥")
  })

  test("catalog by group number renders a field table with defaults", async () => {
    const out = await runConfigAction({ action: "catalog", key: "2" }, env)
    expect(out).toContain("| `coder_model` | \"opencode-go/glm-5.3\"")
    expect(out).toContain("默认")
    expect(await runConfigAction({ action: "catalog", key: "nope" }, env)).toStartWith("Error:")
  })

  test("describe explains type, default, and placeholders", async () => {
    const out = await runConfigAction({ action: "describe", key: "mode_models.<mode>.<role>" }, env)
    expect(out).toContain("<mode> 可选: select, verify")
    const bool = await runConfigAction({ action: "describe", key: "memory_enabled" }, env)
    expect(bool).toContain("true（开）")
    expect(bool).toContain("重启 OpenCode")
  })

  test("set previews without writing, then writes with apply", async () => {
    const preview = await runConfigAction({ action: "set", key: "coder_model", value: "acme/x" }, env)
    expect(preview).toContain("尚未写入")
    expect(preview).toContain('coder_model: "opencode-go/glm-5.3" -> "acme/x"')
    expect(existsSync(configPath)).toBe(false)

    const applied = await runConfigAction({ action: "set", key: "coder_model", value: "acme/x", apply: true }, env)
    expect(applied).toContain("已写入")
    expect(applied).toContain("回读校验: 通过")
    expect(applied).toContain(`rm "${configPath}"`)
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({ coder_model: "acme/x" })

    const got = await runConfigAction({ action: "get", key: "coder_model" }, env)
    expect(got).toBe('coder_model = "acme/x"（用户设置）')
  })

  test("invalid values are refused even with apply", async () => {
    const out = await runConfigAction({ action: "set", key: "embedding.model", value: "m", apply: true }, env)
    expect(out).toContain("不能写入")
    expect(existsSync(configPath)).toBe(false)
  })

  test("unset and reset round-trip, with a backup rollback hint", async () => {
    await runConfigAction({ action: "set", key: "memory_enabled", value: "关", apply: true }, env)
    const unset = await runConfigAction({ action: "unset", key: "memory_enabled", apply: true }, env)
    expect(unset).toContain(`cp "${configPath}.bak" "${configPath}"`)
    expect(await runConfigAction({ action: "get" }, env)).toContain("没有自定义项")
    expect(await runConfigAction({ action: "reset" }, env)).toContain("无改动")
  })

  test("validate reports schema errors", async () => {
    await Bun.write(configPath, '{ "legacy": true }')
    expect(await runConfigAction({ action: "validate" }, env)).toContain("校验失败")
    expect(await runConfigAction({ action: "get" }, env)).toContain("legacy = true  ← 不在目录中")
  })

  test("model_prompts changes report hot reload", async () => {
    const out = await runConfigAction({ action: "set", key: "model_prompts.glm53", value: '""', apply: true }, env)
    expect(out).toContain("下一轮对话即生效")
  })
})
