import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { LEAF_DISPATCH_DENY } from "./agent-registration.ts"
import { applyKeysPlan, loadKeysState, planAdd } from "./provider-keys.ts"
import { HOME_KEY, WORK_KEY, seedKeysHome } from "./provider-keys.fixture.ts"
import { PROVIDER_KEYS_TOOL_NAME, createProviderKeysTool, runKeysAction, type KeysToolArgs } from "./provider-keys-tool.ts"

let root: string
let env: NodeJS.ProcessEnv
const startedAtMs = Date.now() - 60_000

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "janus-keys-tool-"))
  env = await seedKeysHome(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function run(args: KeysToolArgs): Promise<string> {
  return runKeysAction(args, { env, startedAtMs, cliCommand: () => "janus-keys" })
}

async function addHomeKey(): Promise<void> {
  const state = await loadKeysState(env)
  await applyKeysPlan(state, planAdd(state, "deepseek", "home", HOME_KEY))
}

describe("janus_provider_keys tool", () => {
  test("is denied to every leaf role and takes no key argument", () => {
    expect(LEAF_DISPATCH_DENY).toMatchObject({ [PROVIDER_KEYS_TOOL_NAME]: "deny" })
    const args = Object.keys(createProviderKeysTool({ env }).args)
    expect(args).not.toContain("key")
    expect(args).not.toContain("value")
  })

  test("first list shows the unnamed-key banner with the adopt choices", async () => {
    const out = await run({ action: "list" })
    expect(out).toContain("发现 1 个 provider 已在 OpenCode 中配置了 key，但还没有名字：deepseek")
    expect(out).toContain('1 全部以 "default" 收录')
    expect(out).toContain("| 1 | anthropic（Anthropic）")
    expect(out).toContain("生效中（未命名）")
    expect(out).toContain("oauth 登录（不可切换）")
  })

  test("adopt previews, then applies without a restart", async () => {
    expect(await run({ action: "adopt", provider: "*" })).toContain("尚未写入")
    const applied = await run({ action: "adopt", provider: "*", apply: true })
    expect(applied).toContain("无需重启")
    expect(await run({ action: "list" })).not.toContain("还没有名字")
  })

  test("use writes auth.json and returns the restart notice; list shows pending", async () => {
    await addHomeKey()
    expect(await run({ action: "use", provider: "deepseek", name: "home" })).toContain("还没有名字")
    const preview = await run({ action: "use", provider: "deepseek", name: "home", adopt_as: "work" })
    expect(preview).toContain("需要重启 OpenCode 才生效")
    const applied = await run({ action: "use", provider: "deepseek", name: "home", adopt_as: "work", apply: true })
    expect(applied).toContain("已切换：deepseek 的生效 key 现在是 home")
    expect(applied).toContain("当前状态：已写入 OpenCode 的 auth.json")
    expect(applied).toContain("完全退出 OpenCode")
    expect(applied).toContain("/janus-config 切换 deepseek work")
    const auth = JSON.parse(await readFile(join(root, "data", "opencode", "auth.json"), "utf8"))
    expect(auth.deepseek.key).toBe(HOME_KEY)
    const list = await run({ action: "list" })
    expect(list).toContain("已切换，待重启生效")
    expect(list).toContain("提醒：deepseek 的 key 已切换")
  })

  test("show and search render masked data", async () => {
    await addHomeKey()
    const show = await run({ action: "show", provider: "deepseek" })
    expect(show).toContain("| 1 | home | sk-…7890")
    expect(show).toContain("DEEPSEEK_API_KEY（未设置）")
    expect(await run({ action: "search", query: "open" })).toContain("| openai | OpenAI | OPENAI_API_KEY | 否 |")
  })

  test("add_help prints exact terminal commands, adopting an unnamed key first", async () => {
    const out = await run({ action: "add_help", provider: "deepseek", name: "home" })
    expect(out).toContain("janus-keys add deepseek home --use --adopt-as default")
    expect(out).toContain("pbpaste | janus-keys add deepseek home --stdin --use")
    expect(out).toContain("--env DEEPSEEK_API_KEY")
    expect(await run({ action: "add_help", provider: "nowhere", name: "x" })).toContain("--force")
  })

  test("removing the active key asks for the logout choice", async () => {
    await run({ action: "adopt", provider: "deepseek", name: "work", apply: true })
    expect(await run({ action: "remove", provider: "deepseek", name: "work" })).toContain("logout")
    const out = await run({ action: "remove", provider: "deepseek", name: "work", logout: true, apply: true })
    expect(out).toContain("已移除：deepseek 在 OpenCode 中不再有 key")
  })

  test("no output ever contains a full key", async () => {
    await addHomeKey()
    const outputs = await Promise.all([
      run({ action: "list" }),
      run({ action: "show", provider: "deepseek" }),
      run({ action: "use", provider: "deepseek", name: "home", adopt_as: "work" }),
      run({ action: "adopt", provider: "*" }),
    ])
    const text = outputs.join("\n")
    expect(text).not.toContain(WORK_KEY)
    expect(text).not.toContain(HOME_KEY)
  })

  test("missing arguments are reported", async () => {
    expect(await run({ action: "use", provider: "deepseek" })).toBe("Error: 需要 name")
  })
})
