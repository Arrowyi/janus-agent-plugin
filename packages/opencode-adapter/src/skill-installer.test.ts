import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { readFile } from "node:fs/promises"
import {
  CONSULTATION_SKILLS,
  installConsultationSkill,
  installConsultationSkills,
  resolveOpencodeConfigDir,
} from "./skill-installer.ts"
import { resolveAsset } from "./asset-paths.ts"

describe("resolveOpencodeConfigDir", () => {
  const savedEnv: Record<string, string | undefined> = {}
  const envKeys = ["OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "HOME"]

  beforeEach(() => {
    for (const key of envKeys) savedEnv[key] = process.env[key]
  })

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
  })

  it("returns $OPENCODE_CONFIG_DIR when set", () => {
    process.env.OPENCODE_CONFIG_DIR = "/custom/oc-config"
    expect(resolveOpencodeConfigDir(process.env)).toBe("/custom/oc-config")
  })

  it("returns $XDG_CONFIG_HOME/opencode when OPENCODE_CONFIG_DIR is unset", () => {
    delete process.env.OPENCODE_CONFIG_DIR
    process.env.XDG_CONFIG_HOME = "/custom/xdg"
    expect(resolveOpencodeConfigDir(process.env)).toBe(join("/custom/xdg", "opencode"))
  })

  it("returns ~/.config/opencode when both OPENCODE_CONFIG_DIR and XDG_CONFIG_HOME are unset", () => {
    delete process.env.OPENCODE_CONFIG_DIR
    delete process.env.XDG_CONFIG_HOME
    process.env.HOME = "/home/testuser"
    expect(resolveOpencodeConfigDir(process.env)).toBe(join("/home/testuser", ".config", "opencode"))
  })
})

describe("installConsultationSkills", () => {
  const savedEnv: Record<string, string | undefined> = {}
  const envKeys = ["OPENCODE_CONFIG_DIR", "XDG_CONFIG_HOME", "HOME"]

  beforeEach(() => {
    for (const key of envKeys) savedEnv[key] = process.env[key]
  })

  afterEach(() => {
    for (const key of envKeys) {
      if (savedEnv[key] === undefined) delete process.env[key]
      else process.env[key] = savedEnv[key]
    }
  })

  function targetFile(configDir: string, name: string): string {
    return join(configDir, "skills", name, "SKILL.md")
  }

  it("writes all three SKILL.md files when they are missing", async () => {
    const tmpConfigDir = mkdtempSync(join(tmpdir(), "skill-missing-"))
    process.env.OPENCODE_CONFIG_DIR = tmpConfigDir

    try {
      for (const name of CONSULTATION_SKILLS) expect(existsSync(targetFile(tmpConfigDir, name))).toBe(false)
      await installConsultationSkills(process.env)
      for (const name of CONSULTATION_SKILLS) {
        expect(existsSync(targetFile(tmpConfigDir, name))).toBe(true)
        const assetContent = await readFile(resolveAsset(`skills/${name}/SKILL.md`), "utf8")
        expect(readFileSync(targetFile(tmpConfigDir, name), "utf8")).toBe(assetContent)
      }
    } finally {
      rmSync(tmpConfigDir, { recursive: true, force: true })
    }
  })

  it("does not rewrite a skill whose content already matches", async () => {
    const tmpConfigDir = mkdtempSync(join(tmpdir(), "skill-match-"))
    process.env.OPENCODE_CONFIG_DIR = tmpConfigDir
    const name = "consultation-design"
    const file = targetFile(tmpConfigDir, name)
    mkdirSync(join(tmpConfigDir, "skills", name), { recursive: true })
    const assetContent = await readFile(resolveAsset(`skills/${name}/SKILL.md`), "utf8")
    writeFileSync(file, assetContent)

    try {
      await installConsultationSkills(process.env)
      expect(readFileSync(file, "utf8")).toBe(assetContent)
    } finally {
      rmSync(tmpConfigDir, { recursive: true, force: true })
    }
  })

  it("rewrites stale content in every skill", async () => {
    const tmpConfigDir = mkdtempSync(join(tmpdir(), "skill-differs-"))
    process.env.OPENCODE_CONFIG_DIR = tmpConfigDir
    for (const name of CONSULTATION_SKILLS) {
      mkdirSync(join(tmpConfigDir, "skills", name), { recursive: true })
      writeFileSync(targetFile(tmpConfigDir, name), "# old stale content\n")
    }

    try {
      await installConsultationSkills(process.env)
      for (const name of CONSULTATION_SKILLS) {
        const assetContent = await readFile(resolveAsset(`skills/${name}/SKILL.md`), "utf8")
        expect(readFileSync(targetFile(tmpConfigDir, name), "utf8")).toBe(assetContent)
      }
    } finally {
      rmSync(tmpConfigDir, { recursive: true, force: true })
    }
  })

  it("never overwrites a skill whose first line is <!-- user-modified -->", async () => {
    const tmpConfigDir = mkdtempSync(join(tmpdir(), "skill-usermod-"))
    process.env.OPENCODE_CONFIG_DIR = tmpConfigDir
    const name = "consultation-doc"
    mkdirSync(join(tmpConfigDir, "skills", name), { recursive: true })
    const userContent = "<!-- user-modified -->\n# my custom skill\n"
    writeFileSync(targetFile(tmpConfigDir, name), userContent)

    try {
      await installConsultationSkills(process.env)
      expect(readFileSync(targetFile(tmpConfigDir, name), "utf8")).toBe(userContent)
    } finally {
      rmSync(tmpConfigDir, { recursive: true, force: true })
    }
  })

  it("keeps the core-only installer for backward compatibility", async () => {
    const tmpConfigDir = mkdtempSync(join(tmpdir(), "skill-core-only-"))
    process.env.OPENCODE_CONFIG_DIR = tmpConfigDir

    try {
      await installConsultationSkill(process.env)
      expect(existsSync(targetFile(tmpConfigDir, "consultation"))).toBe(true)
      expect(existsSync(targetFile(tmpConfigDir, "consultation-design"))).toBe(false)
    } finally {
      rmSync(tmpConfigDir, { recursive: true, force: true })
    }
  })
})
