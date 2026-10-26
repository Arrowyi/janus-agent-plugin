import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { MEMORY_COMMAND_PREFIX, MODELS_COMMAND_PREFIX, installMemoryCommands, installModelsCommand } from "./command-installer.ts"
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
