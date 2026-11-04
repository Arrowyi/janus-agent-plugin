import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { HOME_KEY, OAUTH_SECRET, WORK_KEY, seedKeysHome } from "./provider-keys.fixture.ts"
import {
  applyKeysPlan,
  configuredProviders,
  isPendingRestart,
  loadKeysState,
  maskKey,
  planAdd,
  planAdopt,
  planRemove,
  planRename,
  planUse,
  restartNotice,
  searchProviders,
  summarize,
} from "./provider-keys.ts"

let root: string
let env: NodeJS.ProcessEnv

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "janus-keys-"))
  env = await seedKeysHome(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

async function apply(plan: ReturnType<typeof planUse>) {
  return applyKeysPlan(await loadKeysState(env), plan)
}

function allText(...values: unknown[]): string {
  return JSON.stringify(values)
}

describe("provider keys", () => {
  test("masks keys to the first 3 and last 4 characters", () => {
    expect(maskKey(WORK_KEY)).toBe("sk-…cdef")
    expect(maskKey("short")).toBe("…rt")
  })

  test("lists configured providers with an unnamed active key", async () => {
    const state = await loadKeysState(env)
    const summaries = configuredProviders(state)
    expect(summaries.map((s) => s.id)).toEqual(["anthropic", "deepseek"])
    const deepseek = summarize(state, "deepseek")
    expect(deepseek.unnamedActive).toBe(true)
    expect(deepseek.name).toBe("DeepSeek")
    expect(deepseek.env).toEqual(["DEEPSEEK_API_KEY"])
  })

  test("search covers models.dev and custom providers", async () => {
    const state = await loadKeysState(env)
    expect(searchProviders(state, "OPENAI").map((p) => p.id)).toEqual(["openai"])
    expect(searchProviders(state, "gateway")[0]).toMatchObject({ id: "acme", custom: true })
  })

  test("adopt names every unnamed key without touching auth.json", async () => {
    const before = await readFile(join(root, "data", "opencode", "auth.json"), "utf8")
    const plan = planAdopt(await loadKeysState(env), "*")
    expect(plan.restartNeeded).toBe(false)
    expect(plan.auth).toBeUndefined()
    await apply(plan)
    const state = await loadKeysState(env)
    expect(summarize(state, "deepseek").activeName).toBe("default")
    expect(await readFile(join(root, "data", "opencode", "auth.json"), "utf8")).toBe(before)
    const vaultStat = await stat(state.paths.vault)
    expect(vaultStat.mode & 0o777).toBe(0o600)
  })

  test("adopt on a taken name suggests another", async () => {
    await apply(planAdd(await loadKeysState(env), "deepseek", "default", HOME_KEY))
    const plan = planAdopt(await loadKeysState(env), "deepseek", "default")
    expect(plan.errors[0]).toContain("default-2")
    const all = planAdopt(await loadKeysState(env), "*", "default")
    expect(all.lines[0]).toContain('"default-2"')
  })

  test("names and key values are unique per provider", async () => {
    await apply(planAdd(await loadKeysState(env), "deepseek", "home", HOME_KEY))
    const state = await loadKeysState(env)
    expect(planAdd(state, "deepseek", "home", "sk-other-key-000000").errors[0]).toContain("已有名为")
    expect(planAdd(state, "deepseek", "copy", HOME_KEY).errors[0]).toContain('已经保存为 "home"')
    expect(planAdd(state, "deepseek", "has space", "sk-x-0000000").errors[0]).toContain("无效")
  })

  test("unknown providers need force", async () => {
    const state = await loadKeysState(env)
    expect(planAdd(state, "nowhere", "a", HOME_KEY).errors[0]).toContain("--force")
    expect(planAdd(state, "nowhere", "a", HOME_KEY, { force: true }).errors).toEqual([])
  })

  test("switching away from an unnamed key is blocked unless it is adopted first", async () => {
    await apply(planAdd(await loadKeysState(env), "deepseek", "home", HOME_KEY))
    const blocked = planUse(await loadKeysState(env), "deepseek", "home")
    expect(blocked.errors[0]).toContain("还没有名字")
    const plan = planUse(await loadKeysState(env), "deepseek", "home", "work")
    expect(plan.restartNeeded).toBe(true)
    const result = await apply(plan)
    const auth = JSON.parse(await readFile(join(root, "data", "opencode", "auth.json"), "utf8"))
    expect(auth.deepseek).toEqual({ type: "api", key: HOME_KEY })
    expect(auth.anthropic).toEqual({ type: "oauth", refresh: OAUTH_SECRET })
    expect(JSON.parse(await readFile(result.authBackup ?? "", "utf8")).deepseek.key).toBe(WORK_KEY)
    expect((await stat(join(root, "data", "opencode", "auth.json"))).mode & 0o777).toBe(0o600)
    const state = await loadKeysState(env)
    const summary = summarize(state, "deepseek")
    expect(summary.activeName).toBe("home")
    expect(summary.keys.map((k) => k.name)).toEqual(["home", "work"])
    expect(isPendingRestart(summary, Date.now() - 60_000)).toBe(true)
    expect(isPendingRestart(summary, Date.now() + 60_000)).toBe(false)
  })

  test("switching to the active key is a no-op", async () => {
    await apply(planAdopt(await loadKeysState(env), "deepseek", "work"))
    expect(planUse(await loadKeysState(env), "deepseek", "work").noop).toBe(true)
  })

  test("oauth providers cannot be switched", async () => {
    await apply(planAdd(await loadKeysState(env), "anthropic", "k", HOME_KEY))
    expect(planUse(await loadKeysState(env), "anthropic", "k").errors[0]).toContain("oauth")
  })

  test("removing the active key requires a logout choice", async () => {
    await apply(planAdopt(await loadKeysState(env), "deepseek", "work"))
    const state = await loadKeysState(env)
    expect(planRemove(state, "deepseek", "work").errors[0]).toContain("logout")
    const keep = planRemove(state, "deepseek", "work", false)
    expect(keep.auth).toBeUndefined()
    expect(keep.restartNeeded).toBe(false)
    const logout = planRemove(state, "deepseek", "work", true)
    expect(logout.restartNeeded).toBe(true)
    await apply(logout)
    const auth = JSON.parse(await readFile(join(root, "data", "opencode", "auth.json"), "utf8"))
    expect(auth.deepseek).toBeUndefined()
    expect(auth.anthropic).toBeDefined()
  })

  test("an unnamed active key can only be deleted with logout, and rename points to adopt", async () => {
    const state = await loadKeysState(env)
    expect(planRemove(state, "deepseek", "").errors[0]).toContain("adopt")
    expect(planRename(state, "deepseek", "default", "x").errors[0]).toContain("adopt")
    const logout = planRemove(state, "deepseek", "", true)
    expect(logout.restartNeeded).toBe(true)
    expect(logout.lines.join("\n")).toContain("auth.json.bak")
    await apply(logout)
    const auth = JSON.parse(await readFile(join(root, "data", "opencode", "auth.json"), "utf8"))
    expect(auth.deepseek).toBeUndefined()
    expect(auth.anthropic).toBeDefined()
    await apply(planAdd(await loadKeysState(env), "deepseek", "home", HOME_KEY))
    expect(planRemove(await loadKeysState(env), "deepseek", "", true).errors[0]).toContain("请指定")
  })

  test("a key already used by another provider needs force; the unnamed active key points to adopt", async () => {
    const state = await loadKeysState(env)
    expect(planAdd(state, "deepseek", "same", WORK_KEY).errors[0]).toContain("adopt deepseek same")
    expect(planAdd(state, "openai", "k", WORK_KEY).errors[0]).toContain("已用于 deepseek")
    expect(planAdd(state, "openai", "k", WORK_KEY, { force: true }).errors).toEqual([])
  })

  test("rename keeps uniqueness", async () => {
    await apply(planAdd(await loadKeysState(env), "deepseek", "home", HOME_KEY))
    await apply(planAdopt(await loadKeysState(env), "deepseek", "work"))
    const state = await loadKeysState(env)
    expect(planRename(state, "deepseek", "home", "work").errors[0]).toContain("已有名为")
    await apply(planRename(state, "deepseek", "home", "personal"))
    expect(summarize(await loadKeysState(env), "deepseek").keys.map((k) => k.name)).toEqual(["personal", "work"])
  })

  test("no plan or notice text contains a full key", async () => {
    await apply(planAdd(await loadKeysState(env), "deepseek", "home", HOME_KEY))
    const state = await loadKeysState(env)
    const plans = [
      planAdopt(state, "*"),
      planUse(state, "deepseek", "home", "work"),
      planRemove(state, "deepseek", "home"),
      planRename(state, "deepseek", "home", "x"),
      planAdd(state, "deepseek", "dup", HOME_KEY),
    ]
    const notice = restartNotice(plans[1] as ReturnType<typeof planUse>, {
      switchCommand: (p, n) => `/janus-config 切换 ${p} ${n}`,
      removeCommand: (p, n) => `remove ${p} ${n}`,
      statusCommand: (p) => `/janus-config key ${p}`,
      authBackup: "/x/auth.json.bak",
    })
    const text = allText(plans.map((plan) => [plan.lines, plan.errors]), notice)
    expect(text).not.toContain(WORK_KEY)
    expect(text).not.toContain(HOME_KEY)
    expect(notice).toContain("已切换：deepseek 的生效 key 现在是 home")
    expect(notice).toContain("/janus-config 切换 deepseek work")
    expect(notice).toContain("完全退出 OpenCode")
  })
})
