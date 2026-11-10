import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  CONFIG_COMMAND_PREFIX,
  HANDOFF_COMMAND_PREFIX,
  MEMORY_COMMAND_PREFIX,
  MODELS_COMMAND_PREFIX,
  installConfigCommand,
  installHandoffCommand,
  installMemoryCommands,
  installModelsCommand,
} from "./command-installer.ts"
import { resolveAsset } from "./asset-paths.ts"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { force: true, recursive: true })))
})

async function tempConfigDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "consultation-cmd-"))
  directories.push(dir)
  return dir
}

function envFor(configDir: string): NodeJS.ProcessEnv {
  return { OPENCODE_CONFIG_DIR: configDir }
}

describe("installMemoryCommands", () => {
  test("writes the janus-memory command with the resolved CLI path and subcommand dispatch", async () => {
    // given
    const configDir = await tempConfigDir()
    // when
    await installMemoryCommands(envFor(configDir))
    const file = await readFile(join(configDir, "commands", `${MEMORY_COMMAND_PREFIX}.md`), "utf8")
    // then
    expect(file).toContain("description:")
    expect(file).toContain("memory_recall")
    expect(file).toContain("memory_expand")
    expect(file).toContain("memory_manage")
    expect(file).toContain("操作提示")
    expect(file).toContain("retire")
    expect(file).toContain("forget")
    expect(file).toContain("itemId")
    expect(file).toContain("删 2，4，5")
    expect(file).toContain("删 4~9")
    expect(file).toContain("留 5，7")
  })

  test("is idempotent: a second call leaves the file unchanged", async () => {
    // given
    const configDir = await tempConfigDir()
    await installMemoryCommands(envFor(configDir))
    const first = await readFile(join(configDir, "commands", `${MEMORY_COMMAND_PREFIX}.md`), "utf8")
    // when
    await installMemoryCommands(envFor(configDir))
    const second = await readFile(join(configDir, "commands", `${MEMORY_COMMAND_PREFIX}.md`), "utf8")
    // then
    expect(second).toBe(first)
  })

  test("does not overwrite a user-modified command file", async () => {
    // given
    const configDir = await tempConfigDir()
    const commandsDir = join(configDir, "commands")
    await mkdir(commandsDir, { recursive: true })
    const target = join(commandsDir, `${MEMORY_COMMAND_PREFIX}.md`)
    await writeFile(target, "<!-- user-modified -->\ncustom", "utf8")
    // when
    await installMemoryCommands(envFor(configDir))
    const after = await readFile(target, "utf8")
    // then
    expect(after).toBe("<!-- user-modified -->\ncustom")
  })
})

describe("installModelsCommand", () => {
  test("writes the shipped janus-models command and leaves the frontmatter unpinned", async () => {
    // given
    const configDir = await tempConfigDir()
    // when
    await installModelsCommand(envFor(configDir))
    const file = await readFile(join(configDir, "commands", `${MODELS_COMMAND_PREFIX}.md`), "utf8")
    const asset = await readFile(resolveAsset("commands/janus-models.md"), "utf8")
    // then
    expect(file).toBe(asset)
    expect(file).toContain("Inventory")
    expect(file).toContain("Model evaluation")
    expect(file).toContain("Prompt evaluation")
    expect(file).toContain("Combined recommendation")
    expect(file).toContain("Execute changes")
    expect(file).toContain("盘点")
    expect(file).toContain("评估")
    expect(file).toContain("model_prompts")
    expect(file).toContain("Write only to the user-level Janus config; overwrite existing values and add missing keys.")
    expect(file).not.toContain("中文输出")
    const frontmatter = file.split("---")[1] ?? ""
    expect(frontmatter).not.toContain("agent:")
  })

  test("is idempotent: a second call leaves the file unchanged", async () => {
    // given
    const configDir = await tempConfigDir()
    await installModelsCommand(envFor(configDir))
    const first = await readFile(join(configDir, "commands", `${MODELS_COMMAND_PREFIX}.md`), "utf8")
    // when
    await installModelsCommand(envFor(configDir))
    const second = await readFile(join(configDir, "commands", `${MODELS_COMMAND_PREFIX}.md`), "utf8")
    // then
    expect(second).toBe(first)
  })

  test("does not overwrite a user-modified command file", async () => {
    // given
    const configDir = await tempConfigDir()
    const commandsDir = join(configDir, "commands")
    await mkdir(commandsDir, { recursive: true })
    const target = join(commandsDir, `${MODELS_COMMAND_PREFIX}.md`)
    await writeFile(target, "<!-- user-modified -->\ncustom", "utf8")
    // when
    await installModelsCommand(envFor(configDir))
    const after = await readFile(target, "utf8")
    // then
    expect(after).toBe("<!-- user-modified -->\ncustom")
  })
})

describe("installHandoffCommand", () => {
  test("writes the shipped janus-handoff command with the full subcommand surface", async () => {
    // given
    const configDir = await tempConfigDir()
    // when
    await installHandoffCommand(envFor(configDir))
    const file = await readFile(join(configDir, "commands", `${HANDOFF_COMMAND_PREFIX}.md`), "utf8")
    const asset = await readFile(resolveAsset("commands/janus-handoff.md"), "utf8")
    // then
    expect(file).toBe(asset)
    expect(file).toContain("handoff state directory")
    expect(file).toContain("## 1. 背景与当前定论")
    expect(file).toContain("## 2. 交接记录与下一跳指引")
    expect(file).toContain("first 120 lines")
    expect(file).toContain("`use <id|n>`")
    expect(file).toContain("last_hop")
    expect(file).toContain("本跳结论摘要")
    expect(file).toContain("默认接力任务")
    expect(file).toContain("共 N 个交接单")
    expect(file).not.toContain("archive")
    expect(file).toContain("`delete`")
    expect(file).toContain("`export <n> [path]`")
    expect(file).toContain("`import <path>`")
    expect(file).toContain("删 2，4，5")
    expect(file).toContain("删 4~9")
    expect(file).toContain("留 5，7")
    expect(file).toContain("never silently auto-select")
    const frontmatter = file.split("---")[1] ?? ""
    expect(frontmatter).not.toContain("agent:")
  })

  test("is idempotent: a second call leaves the file unchanged", async () => {
    // given
    const configDir = await tempConfigDir()
    await installHandoffCommand(envFor(configDir))
    const first = await readFile(join(configDir, "commands", `${HANDOFF_COMMAND_PREFIX}.md`), "utf8")
    // when
    await installHandoffCommand(envFor(configDir))
    const second = await readFile(join(configDir, "commands", `${HANDOFF_COMMAND_PREFIX}.md`), "utf8")
    // then
    expect(second).toBe(first)
  })

  test("does not overwrite a user-modified command file", async () => {
    // given
    const configDir = await tempConfigDir()
    const commandsDir = join(configDir, "commands")
    await mkdir(commandsDir, { recursive: true })
    const target = join(commandsDir, `${HANDOFF_COMMAND_PREFIX}.md`)
    await writeFile(target, "<!-- user-modified -->\ncustom", "utf8")
    // when
    await installHandoffCommand(envFor(configDir))
    const after = await readFile(target, "utf8")
    // then
    expect(after).toBe("<!-- user-modified -->\ncustom")
  })
})

describe("installConfigCommand", () => {
  test("writes the shipped janus-config command driving the janus_config tool", async () => {
    // given
    const configDir = await tempConfigDir()
    // when
    await installConfigCommand(envFor(configDir))
    const file = await readFile(join(configDir, "commands", `${CONFIG_COMMAND_PREFIX}.md`), "utf8")
    const asset = await readFile(resolveAsset("commands/janus-config.md"), "utf8")
    // then
    expect(file).toBe(asset)
    expect(file).toContain("`janus_config`")
    expect(file).toContain("without** `apply`")
    expect(file).toContain("apply: true")
    expect(file).toContain("/janus-models")
    expect(file).toContain("Never edit `config.jsonc`, OpenCode's `auth.json`")
    expect(file).toContain("## Provider keys (group 10)")
    expect(file).toContain("`janus_provider_keys`")
    expect(file).toContain("**in full and in order**")
    expect(file).toContain("do not pass it to any tool")
    const frontmatter = file.split("---")[1] ?? ""
    expect(frontmatter).not.toContain("agent:")
  })

  test("does not overwrite a user-modified command file", async () => {
    // given
    const configDir = await tempConfigDir()
    const commandsDir = join(configDir, "commands")
    await mkdir(commandsDir, { recursive: true })
    const target = join(commandsDir, `${CONFIG_COMMAND_PREFIX}.md`)
    await writeFile(target, "<!-- user-modified -->\ncustom", "utf8")
    // when
    await installConfigCommand(envFor(configDir))
    // then
    expect(await readFile(target, "utf8")).toBe("<!-- user-modified -->\ncustom")
  })
})
