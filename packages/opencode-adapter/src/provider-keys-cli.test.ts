import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { runCli, type CliIO } from "./provider-keys-cli.ts"
import { HOME_KEY, WORK_KEY, seedKeysHome } from "./provider-keys.fixture.ts"

let root: string
let env: NodeJS.ProcessEnv

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "janus-keys-cli-"))
  env = await seedKeysHome(root)
})

afterEach(async () => {
  await rm(root, { recursive: true, force: true })
})

function io(overrides: Partial<CliIO> = {}): CliIO & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = []
  const stderr: string[] = []
  return {
    env,
    isTTY: false,
    out: (text) => stdout.push(text),
    err: (text) => stderr.push(text),
    readStdin: async () => "",
    readHidden: async () => "",
    confirm: async () => false,
    detectOpencode: () => ({ running: true, startedAtMs: Date.now() - 60_000 }),
    cli: "janus-keys",
    stdout,
    stderr,
    ...overrides,
  }
}

async function vault(): Promise<{ providers: Record<string, { keys: { name: string; key: string }[] }> }> {
  return JSON.parse(await readFile(join(root, "data", "janus-agent", "provider-keys.json"), "utf8"))
}

async function auth(): Promise<Record<string, { key?: string }>> {
  return JSON.parse(await readFile(join(root, "data", "opencode", "auth.json"), "utf8"))
}

describe("janus-keys CLI", () => {
  test("add --stdin saves a candidate without touching auth.json", async () => {
    const cli = io({ readStdin: async () => `${HOME_KEY}\n` })
    expect(await runCli(["add", "deepseek", "home", "--stdin"], cli)).toBe(0)
    expect((await vault()).providers.deepseek?.keys.map((k) => k.name)).toEqual(["home"])
    expect((await auth()).deepseek?.key).toBe(WORK_KEY)
    expect(cli.stdout.join("\n")).toContain("无需重启")
  })

  test("add --env --use adopts the unnamed key, switches, and prints the restart notice", async () => {
    const cli = io({ env: { ...env, MY_KEY: HOME_KEY } })
    const code = await runCli(["add", "deepseek", "home", "--env", "MY_KEY", "--use", "--adopt-as", "default"], cli)
    expect(code).toBe(0)
    expect((await auth()).deepseek?.key).toBe(HOME_KEY)
    const out = cli.stdout.join("\n")
    expect(out).toContain("已切换：deepseek 的生效 key 现在是 home")
    expect(out).toContain("检测到 OpenCode 正在运行")
    expect(out).toContain("janus-keys use deepseek default")
    expect(out).not.toContain(HOME_KEY)
  })

  test("add --use without adopting an unnamed key refuses and saves nothing", async () => {
    const cli = io({ readStdin: async () => HOME_KEY })
    expect(await runCli(["add", "deepseek", "home", "--stdin", "--use"], cli)).toBe(1)
    expect(cli.stderr.join("\n")).toContain("还没有名字")
  })

  test("unknown providers need --force before a key is read", async () => {
    let read = false
    const cli = io({ readStdin: async () => { read = true; return HOME_KEY } })
    expect(await runCli(["add", "nowhere", "a", "--stdin"], cli)).toBe(1)
    expect(read).toBe(false)
    expect(await runCli(["add", "nowhere", "a", "--stdin", "--force"], io({ readStdin: async () => HOME_KEY }))).toBe(0)
  })

  test("hidden input must match twice", async () => {
    const answers = [HOME_KEY, "different"]
    const cli = io({ isTTY: true, readHidden: async () => answers.shift() ?? "" })
    expect(await runCli(["add", "deepseek", "home"], cli)).toBe(1)
    expect(cli.stderr.join("\n")).toContain("两次输入不一致")
  })

  test("use needs -y off a TTY; remove of the active key needs --keep or --logout", async () => {
    await runCli(["adopt", "--all"], io())
    await runCli(["add", "deepseek", "home", "--stdin"], io({ readStdin: async () => HOME_KEY }))
    const noTty = io()
    expect(await runCli(["use", "deepseek", "home"], noTty)).toBe(1)
    expect(noTty.stderr.join("\n")).toContain("-y")
    expect(await runCli(["use", "deepseek", "home", "-y"], io())).toBe(0)
    const remove = io()
    expect(await runCli(["remove", "deepseek", "home", "-y"], remove)).toBe(1)
    expect(remove.stderr.join("\n")).toContain("--keep")
    expect(await runCli(["remove", "deepseek", "home", "--keep", "-y"], io())).toBe(0)
  })

  test("list shows the adopt banner and help prints usage", async () => {
    const list = io()
    await runCli(["list"], list)
    expect(list.stdout.join("\n")).toContain("janus-keys adopt --all")
    const help = io()
    await runCli([], help)
    expect(help.stdout.join("\n")).toContain("janus-keys add <provider> <名字>")
  })

  test("show lists the exact rename/delete/switch commands for the provider", async () => {
    const unnamed = io()
    await runCli(["show", "deepseek"], unnamed)
    const before = unnamed.stdout.join("\n")
    expect(before).toContain("janus-keys adopt deepseek default")
    expect(before).toContain("janus-keys remove deepseek --logout")
    await runCli(["adopt", "--all"], io())
    await runCli(["add", "deepseek", "home", "--stdin"], io({ readStdin: async () => HOME_KEY }))
    const named = io()
    await runCli(["show", "deepseek"], named)
    const after = named.stdout.join("\n")
    expect(after).toContain("janus-keys use deepseek home")
    expect(after).toContain("janus-keys rename deepseek default <新名字>")
    expect(after).toContain("janus-keys remove deepseek home")
    expect(after).toContain("janus-keys remove deepseek default --keep")
    const list = io()
    await runCli(["list"], list)
    expect(list.stdout.join("\n")).toContain("janus-keys show <provider>")
  })

  test("remove without a name deletes the unnamed active key only with --logout", async () => {
    const refused = io()
    expect(await runCli(["remove", "deepseek", "-y"], refused)).toBe(1)
    expect(refused.stderr.join("\n")).not.toContain("--keep")
    expect(await runCli(["remove", "deepseek", "--logout", "-y"], io())).toBe(0)
  })
})
