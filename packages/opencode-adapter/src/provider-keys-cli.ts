#!/usr/bin/env bun
/**
 * `janus-keys`: the terminal side of provider key management. It is the only
 * place a key value is entered (hidden prompt, stdin, or an environment
 * variable), so secrets never pass through an OpenCode conversation.
 */
import {
  applyKeysPlan,
  loadKeysState,
  planAdd,
  planAdopt,
  planRemove,
  planRename,
  planUse,
  restartNotice,
  type KeysPlan,
  type KeysState,
} from "./provider-keys.ts"
import {
  cliStyle,
  noticeOptions,
  renderList,
  renderPlan,
  renderSearch,
  renderShow,
  resolveKeysCliCommand,
} from "./provider-keys-view.ts"

export interface OpencodeProcess {
  readonly running: boolean
  /** Earliest start time among running OpenCode processes (epoch ms). */
  readonly startedAtMs?: number
}

export interface CliIO {
  readonly env: NodeJS.ProcessEnv
  readonly isTTY: boolean
  readonly out: (text: string) => void
  readonly err: (text: string) => void
  readonly readStdin: () => Promise<string>
  readonly readHidden: (prompt: string) => Promise<string>
  readonly confirm: (prompt: string) => Promise<boolean>
  readonly detectOpencode: () => OpencodeProcess
  readonly cli: string
}

const USAGE = (cli: string) => `用法:
  ${cli} list                                   列出已配置的 provider 与生效 key
  ${cli} search <关键字>                         搜索可配置的 provider
  ${cli} show <provider>                        查看某 provider 的全部候选 key（打码）
  ${cli} add <provider> <名字> [--use]           添加 key（隐藏输入，输两次）
        [--stdin | --env 变量名]                  从管道或环境变量读取 key
        [--adopt-as <名字>] [--force]             先收录未命名的当前 key / 允许自定义 provider 或同一 key 用于多个 provider
  ${cli} use <provider> <名字> [--adopt-as <名字>] [-y]   切换生效 key
  ${cli} remove <provider> <名字> [--logout | --keep] [-y] 删除 key（删生效中的 key 需选 --logout 或 --keep）
  ${cli} remove <provider> --logout [-y]        删除未命名的生效 key（同时从 OpenCode 移除）
  ${cli} rename <provider> <名字> <新名字>         改名（未命名的 key 用 adopt 起名）
  ${cli} adopt --all [--name default]           给 OpenCode 里已有但未命名的 key 起名收录
  ${cli} adopt <provider> [名字]

切换、logout 后需要完全退出并重新打开 OpenCode 才生效；添加（不带 --use）、改名、收录无需重启。`

interface ParsedArgs {
  readonly positional: string[]
  readonly flags: Map<string, string | true>
}

function parseArgs(argv: readonly string[]): ParsedArgs {
  const positional: string[] = []
  const flags = new Map<string, string | true>()
  const withValue = new Set(["--env", "--adopt-as", "--name"])
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index] ?? ""
    if (arg.startsWith("-")) {
      if (withValue.has(arg)) {
        flags.set(arg, argv[index + 1] ?? "")
        index++
      } else {
        flags.set(arg, true)
      }
    } else {
      positional.push(arg)
    }
  }
  return { positional, flags }
}

function flagValue(args: ParsedArgs, name: string): string | undefined {
  const value = args.flags.get(name)
  return typeof value === "string" ? value : undefined
}

async function writePlan(io: CliIO, state: KeysState, plan: KeysPlan, needsConfirm: boolean, yes: boolean): Promise<number> {
  if (plan.errors.length > 0 || plan.noop) {
    const text = renderPlan(plan)
    if (plan.errors.length > 0) {
      io.err(text)
      return 1
    }
    io.out(text)
    return 0
  }
  if (needsConfirm && !yes) {
    io.out(renderPlan(plan))
    if (!io.isTTY) {
      io.err("非交互终端：确认无误后加 -y 重新运行。")
      return 1
    }
    if (!(await io.confirm("确认写入？[y/N] "))) {
      io.out("已取消，未写入。")
      return 1
    }
  }
  const result = await applyKeysPlan(state, plan)
  io.out(renderPlan(plan).replace("改动:", "已写入:").replace(/\n\n影响：.*$/s, ""))
  io.out("")
  if (plan.restartNeeded) {
    io.out(restartNotice(plan, noticeOptions(cliStyle(io.cli), result.authBackup, io.detectOpencode().running)))
  } else {
    io.out("无需重启：OpenCode 当前使用的 key 没有变化。")
  }
  return 0
}

async function readKey(io: CliIO, args: ParsedArgs): Promise<string | undefined> {
  const envName = flagValue(args, "--env")
  if (envName !== undefined) {
    const value = io.env[envName]
    if (value === undefined || value.trim().length === 0) {
      io.err(`环境变量 ${envName} 未设置或为空。`)
      return undefined
    }
    return value.trim()
  }
  if (args.flags.has("--stdin")) {
    const value = (await io.readStdin()).trim()
    if (value.length === 0) io.err("stdin 中没有读到 key。")
    return value.length === 0 ? undefined : value
  }
  if (!io.isTTY) {
    io.err("非交互终端请用 --stdin 或 --env 提供 key。")
    return undefined
  }
  const first = (await io.readHidden("输入 key（不会显示）: ")).trim()
  const second = (await io.readHidden("再输入一次确认: ")).trim()
  if (first !== second) {
    io.err("两次输入不一致，未保存。")
    return undefined
  }
  return first
}

export async function runCli(argv: readonly string[], io: CliIO): Promise<number> {
  const args = parseArgs(argv)
  const [command, provider = "", name = "", third = ""] = args.positional
  const yes = args.flags.has("-y") || args.flags.has("--yes")
  const style = cliStyle(io.cli)
  const state = await loadKeysState(io.env)
  const sinceMs = io.detectOpencode().startedAtMs

  const require = (...values: string[]): boolean => {
    if (values.every((value) => value.length > 0)) return true
    io.err(USAGE(io.cli))
    return false
  }

  switch (command) {
    case "list":
    case "ls":
      io.out(renderList(state, style, sinceMs))
      return 0
    case "search":
      io.out(renderSearch(state, provider))
      return 0
    case "show":
      if (!require(provider)) return 1
      io.out(renderShow(state, provider, style, sinceMs))
      return 0
    case "add": {
      if (!require(provider, name)) return 1
      const precheck = planAdd(state, provider, name, "placeholder-key", { force: args.flags.has("--force") })
      if (precheck.errors.length > 0) {
        io.err(renderPlan(precheck))
        return 1
      }
      const key = await readKey(io, args)
      if (key === undefined) return 1
      const adoptAs = flagValue(args, "--adopt-as")
      const plan = planAdd(state, provider, name, key, {
        use: args.flags.has("--use"),
        force: args.flags.has("--force"),
        ...(adoptAs !== undefined ? { adoptAs } : {}),
      })
      return writePlan(io, state, plan, false, true)
    }
    case "use": {
      if (!require(provider, name)) return 1
      return writePlan(io, state, planUse(state, provider, name, flagValue(args, "--adopt-as")), true, yes)
    }
    case "remove":
    case "rm": {
      if (!require(provider)) return 1
      const logout = args.flags.has("--logout") ? true : args.flags.has("--keep") ? false : undefined
      const plan = planRemove(state, provider, name, logout)
      if (plan.errors.length > 0 && logout === undefined && name !== "" && plan.errors[0]?.includes("logout")) {
        io.err(`${plan.errors[0]}\n加 --keep（只删候选）或 --logout（同时从 OpenCode 移除）重新运行。`)
        return 1
      }
      return writePlan(io, state, plan, true, yes)
    }
    case "rename":
      if (!require(provider, name, third)) return 1
      return writePlan(io, state, planRename(state, provider, name, third), false, true)
    case "adopt": {
      const all = args.flags.has("--all")
      if (!all && !require(provider)) return 1
      const plan = all
        ? planAdopt(state, "*", flagValue(args, "--name") ?? "default")
        : planAdopt(state, provider, name || flagValue(args, "--name") || "default")
      return writePlan(io, state, plan, false, true)
    }
    case undefined:
    case "help":
    case "-h":
    case "--help":
      io.out(USAGE(io.cli))
      return 0
    default:
      io.err(`未知命令 "${command}"\n\n${USAGE(io.cli)}`)
      return 1
  }
}

function detectOpencode(): OpencodeProcess {
  const pgrep = Bun.spawnSync(["pgrep", "-x", "opencode"])
  const pids = pgrep.stdout.toString().split(/\s+/).filter((pid) => pid.length > 0)
  if (pids.length === 0) return { running: false }
  const starts = pids
    .map((pid) => Date.parse(Bun.spawnSync(["ps", "-o", "lstart=", "-p", pid]).stdout.toString().trim()))
    .filter((ms) => Number.isFinite(ms))
  return starts.length === 0 ? { running: true } : { running: true, startedAtMs: Math.min(...starts) }
}

function readHidden(prompt: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const stdin = process.stdin
    process.stdout.write(prompt)
    let value = ""
    stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding("utf8")
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") {
          cleanup()
          process.stdout.write("\n")
          resolve(value)
          return
        }
        if (char === "\u0003") {
          cleanup()
          process.stdout.write("\n")
          reject(new Error("已取消"))
          return
        }
        if (char === "\u007f" || char === "\b") value = value.slice(0, -1)
        else value += char
      }
    }
    const cleanup = () => {
      stdin.off("data", onData)
      stdin.setRawMode(false)
      stdin.pause()
    }
    stdin.on("data", onData)
  })
}

async function confirm(prompt: string): Promise<boolean> {
  process.stdout.write(prompt)
  for await (const line of console) {
    return /^(y|yes|是|确认)$/i.test(line.trim())
  }
  return false
}

if (import.meta.main) {
  const code = await runCli(process.argv.slice(2), {
    env: process.env,
    isTTY: process.stdin.isTTY === true,
    out: (text) => console.log(text),
    err: (text) => console.error(text),
    readStdin: () => Bun.stdin.text(),
    readHidden,
    confirm,
    detectOpencode,
    cli: resolveKeysCliCommand(import.meta.url),
  }).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : String(error))
    return 1
  })
  process.exit(code)
}
