import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { existsSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  applyChange,
  effectiveValue,
  planChange,
  readConfigState,
  userSetPaths,
  validateConfigText,
} from "./config-editor.ts"

let dir: string
let configPath: string
let env: NodeJS.ProcessEnv

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "janus-config-editor-"))
  configPath = join(dir, "nested", "config.jsonc")
  env = { JANUS_CONFIG: configPath }
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

async function seed(text: string): Promise<void> {
  await Bun.write(configPath, text)
}

describe("planChange + applyChange", () => {
  test("creates a missing file and its directory", async () => {
    const state = await readConfigState(env)
    expect(state.exists).toBe(false)
    const plan = planChange(state, { kind: "set", key: "coder_model", value: "acme/coder-x" })
    expect(plan.errors).toEqual([])
    expect(plan.noop).toBe(false)
    const result = await applyChange(plan)
    expect(result.backupPath).toBeUndefined()
    const text = await readFile(configPath, "utf8")
    expect(JSON.parse(text)).toEqual({ coder_model: "acme/coder-x" })
  })

  test("preserves comments and backs up the previous file", async () => {
    await seed('{\n  // keep me\n  "janus_enabled": true,\n}\n')
    const plan = planChange(await readConfigState(env), { kind: "set", key: "janus_enabled", value: "关" })
    expect(plan.changes).toEqual([{ key: "janus_enabled", before: true, after: false }])
    const result = await applyChange(plan)
    const text = await readFile(configPath, "utf8")
    expect(text).toContain("// keep me")
    expect(text).toContain('"janus_enabled": false')
    expect(await readFile(result.backupPath ?? "", "utf8")).toContain('"janus_enabled": true')
  })

  test("a preview never writes", async () => {
    planChange(await readConfigState(env), { kind: "set", key: "memory_enabled", value: "false" })
    expect(existsSync(configPath)).toBe(false)
  })

  test("nested routing keys create and prune their parents", async () => {
    const set = planChange(await readConfigState(env), { kind: "set", key: "mode_models.design.coder-reviewer", value: "acme/rev" })
    await applyChange(set)
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({ mode_models: { design: { "coder-reviewer": "acme/rev" } } })
    const unset = planChange(await readConfigState(env), { kind: "unset", key: "mode_models.design.coder-reviewer" })
    await applyChange(unset)
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({})
  })

  test("a seeded child materializes its required siblings and unset restores them", async () => {
    const plan = planChange(await readConfigState(env), { kind: "set", key: "team_caps.round_cap", value: "4" })
    expect(plan.errors).toEqual([])
    await applyChange(plan)
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({
      team_caps: { round_cap: 4, explorer_cap: 5, critic_search_cap: 5 },
    })
    await applyChange(planChange(await readConfigState(env), { kind: "unset", key: "team_caps.round_cap" }))
    expect(JSON.parse(await readFile(configPath, "utf8"))).toEqual({})
  })

  test("tier_role_caps seeds all three tiers", async () => {
    await applyChange(planChange(await readConfigState(env), { kind: "set", key: "tier_role_caps.deep.consultant_critic", value: "3" }))
    const state = await readConfigState(env)
    expect(state.errors).toEqual([])
    expect(effectiveValue(state, ["tier_role_caps", "deep", "consultant_critic"]).value).toBe(3)
    expect(effectiveValue(state, ["tier_role_caps", "standard", "common_explorer"]).value).toBe(5)
  })

  test("a partial embedding block is rejected", async () => {
    const plan = planChange(await readConfigState(env), { kind: "set", key: "embedding.model", value: "text-embedding-3-small" })
    expect(plan.errors.length).toBeGreaterThan(0)
    await expect(applyChange(plan)).rejects.toThrow()
    expect(existsSync(configPath)).toBe(false)
  })

  test("a full embedding object is accepted", async () => {
    const value = JSON.stringify({ base_url: "https://x/v1", api_key_env: "K", model: "m", dimensions: 8 })
    const plan = planChange(await readConfigState(env), { kind: "set", key: "embedding", value })
    expect(plan.errors).toEqual([])
  })

  test("invalid writer_docs_roots fail validation", async () => {
    const plan = planChange(await readConfigState(env), { kind: "set", key: "writer_docs_roots", value: "../outside" })
    expect(plan.errors.join("\n")).toContain("..")
  })

  test("comma lists and an empty list coerce", async () => {
    const list = planChange(await readConfigState(env), { kind: "set", key: "writer_docs_roots", value: "docs，userdoc/guides" })
    expect(list.changes[0]?.after).toEqual(["docs", "userdoc/guides"])
    const empty = planChange(await readConfigState(env), { kind: "set", key: "writer_docs_roots", value: "[]" })
    expect(empty.changes[0]?.after).toEqual([])
  })

  test("unknown keys and bad values are refused", async () => {
    const state = await readConfigState(env)
    expect(planChange(state, { kind: "set", key: "bogus_key", value: "1" }).errors[0]).toContain("未知配置项")
    expect(planChange(state, { kind: "set", key: "coder_model", value: "no-provider" }).errors[0]).toContain("provider/model")
    expect(planChange(state, { kind: "set", key: "team_caps.round_cap", value: "1.5" }).errors[0]).toContain("整数")
  })

  test("setting the current value is a no-op", async () => {
    await seed('{ "coder_model": "acme/x" }\n')
    const plan = planChange(await readConfigState(env), { kind: "set", key: "coder_model", value: "acme/x" })
    expect(plan.noop).toBe(true)
    await expect(applyChange(plan)).rejects.toThrow()
    const seeded = planChange(await readConfigState(env), { kind: "set", key: "team_caps.round_cap", value: "3" })
    expect(seeded.noop).toBe(true)
  })

  test("previews show the effective value being replaced", async () => {
    const plan = planChange(await readConfigState(env), { kind: "set", key: "tier_role_caps.deep.consultant_critic", value: "3" })
    expect(plan.changes).toEqual([{ key: "tier_role_caps.deep.consultant_critic", before: 2, after: 3 }])
  })

  test("unsetting a value equal to the default still removes it", async () => {
    await seed('{ "memory_enabled": true }\n')
    const plan = planChange(await readConfigState(env), { kind: "unset", key: "memory_enabled" })
    expect(plan.noop).toBe(false)
    expect(JSON.parse(plan.after)).toEqual({})
  })

  test("a legacy unknown key can be unset to repair the file", async () => {
    await seed('{ "old_field": 1, "coder_model": "acme/x" }\n')
    const state = await readConfigState(env)
    expect(state.errors.length).toBeGreaterThan(0)
    const plan = planChange(state, { kind: "unset", key: "old_field" })
    expect(plan.errors).toEqual([])
    await applyChange(plan)
    expect((await readConfigState(env)).errors).toEqual([])
  })

  test("reset empties the file and keeps a backup", async () => {
    await seed('{ "coder_model": "acme/x" }\n')
    const result = await applyChange(planChange(await readConfigState(env), { kind: "reset" }))
    expect(await readFile(configPath, "utf8")).toBe("{}\n")
    expect(await readFile(result.backupPath ?? "", "utf8")).toContain("acme/x")
  })
})

describe("effective values", () => {
  test("architect inherits an explicit consultant model", async () => {
    await seed('{ "consultant_model": "acme/judge" }\n')
    const state = await readConfigState(env)
    expect(effectiveValue(state, ["architect_model"])).toEqual({ value: "acme/judge", source: "inherited" })
    expect(effectiveValue(state, ["consultant_model"])).toEqual({ value: "acme/judge", source: "user" })
    expect(effectiveValue(state, ["coder_model"]).source).toBe("default")
    expect(effectiveValue(state, ["tier_models", "deep", "coder"]).value).toBe("opencode-go/kimi-k3.1-pro")
    expect(effectiveValue(state, ["writer_delegate_agent"]).source).toBe("unset")
  })

  test("userSetPaths lists leaf paths", () => {
    const { raw } = validateConfigText('{ "coder_model": "a/b", "mode_models": { "doc": { "author-writer": "a/c" } }, "model_prompts": { "glm53": "" } }')
    expect(userSetPaths(raw)).toEqual([["coder_model"], ["mode_models", "doc", "author-writer"], ["model_prompts", "glm53"]])
  })
})
