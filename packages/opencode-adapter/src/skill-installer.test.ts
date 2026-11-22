import { describe, expect, it, beforeEach, afterEach } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { readFile } from "node:fs/promises"
import {
  CONSULTATION_SKILLS,
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

  it("prunes a retired Janus-generated skill and removes its empty directory", async () => {
    const tmpConfigDir = mkdtempSync(join(tmpdir(), "skill-prune-"))
    process.env.OPENCODE_CONFIG_DIR = tmpConfigDir
    const retired = join(tmpConfigDir, "skills", "retired-skill")
    mkdirSync(retired, { recursive: true })
    writeFileSync(
      join(retired, "SKILL.md"),
      "---\nname: retired-skill\n---\n<!-- generated by script/gen-skill.ts from skill-src/retired-skill; do not edit -->\nShipped by janus-agent.\n",
    )

    try {
      await installConsultationSkills(process.env)
      expect(existsSync(retired)).toBe(false)
    } finally {
      rmSync(tmpConfigDir, { recursive: true, force: true })
    }
  })

  it("preserves a user-modified retired skill even when it carries the fingerprint", async () => {
    const tmpConfigDir = mkdtempSync(join(tmpdir(), "skill-prune-usermod-"))
    process.env.OPENCODE_CONFIG_DIR = tmpConfigDir
    const retired = join(tmpConfigDir, "skills", "retired-skill")
    mkdirSync(retired, { recursive: true })
    const content =
      "<!-- user-modified -->\n<!-- generated by script/gen-skill.ts from skill-src/retired-skill; do not edit -->\njanus-agent\n"
    writeFileSync(join(retired, "SKILL.md"), content)

    try {
      await installConsultationSkills(process.env)
      expect(existsSync(join(retired, "SKILL.md"))).toBe(true)
      expect(readFileSync(join(retired, "SKILL.md"), "utf8")).toBe(content)
    } finally {
      rmSync(tmpConfigDir, { recursive: true, force: true })
    }
  })

  it("preserves a foreign skill missing part of the fingerprint", async () => {
    const tmpConfigDir = mkdtempSync(join(tmpdir(), "skill-prune-foreign-"))
    process.env.OPENCODE_CONFIG_DIR = tmpConfigDir
    const markerOnly = join(tmpConfigDir, "skills", "marker-only")
    const productOnly = join(tmpConfigDir, "skills", "product-only")
    mkdirSync(markerOnly, { recursive: true })
    mkdirSync(productOnly, { recursive: true })
    writeFileSync(
      join(markerOnly, "SKILL.md"),
      "<!-- generated by script/gen-skill.ts from skill-src/marker-only; do not edit -->\n",
    )
    writeFileSync(join(productOnly, "SKILL.md"), "A foreign skill for janus-agent.\n")

    try {
      await installConsultationSkills(process.env)
      expect(existsSync(join(markerOnly, "SKILL.md"))).toBe(true)
      expect(existsSync(join(productOnly, "SKILL.md"))).toBe(true)
    } finally {
      rmSync(tmpConfigDir, { recursive: true, force: true })
    }
  })

  it("keeps a directory that holds extra files besides a pruned SKILL.md", async () => {
    const tmpConfigDir = mkdtempSync(join(tmpdir(), "skill-prune-extra-"))
    process.env.OPENCODE_CONFIG_DIR = tmpConfigDir
    const retired = join(tmpConfigDir, "skills", "retired-skill")
    mkdirSync(retired, { recursive: true })
    writeFileSync(
      join(retired, "SKILL.md"),
      "<!-- generated by script/gen-skill.ts from skill-src/retired-skill; do not edit -->\njanus-agent\n",
    )
    writeFileSync(join(retired, "NOTES.md"), "user notes\n")

    try {
      await installConsultationSkills(process.env)
      expect(existsSync(join(retired, "SKILL.md"))).toBe(false)
      expect(existsSync(join(retired, "NOTES.md"))).toBe(true)
    } finally {
      rmSync(tmpConfigDir, { recursive: true, force: true })
    }
  })
})
