import { mkdir, readFile, rename, writeFile } from "node:fs/promises"
import { existsSync } from "node:fs"
import { join } from "node:path"
import { resolveAsset } from "./asset-paths.ts"

const USER_MODIFIED_MARKER = "<!-- user-modified -->"

export const CONSULTATION_SKILLS = [
  "consultation",
  "consultation-design",
  "consultation-doc",
] as const

/**
 * Resolve the opencode config directory from environment variables.
 *
 * Priority: `$OPENCODE_CONFIG_DIR` >
 * `$XDG_CONFIG_HOME/opencode` >
 * `~/.config/opencode`.
 */
export function resolveOpencodeConfigDir(env: NodeJS.ProcessEnv): string {
  if (env.OPENCODE_CONFIG_DIR && env.OPENCODE_CONFIG_DIR.length > 0) {
    return env.OPENCODE_CONFIG_DIR
  }
  const xdg = env.XDG_CONFIG_HOME
  if (xdg && xdg.length > 0) {
    return join(xdg, "opencode")
  }
  const home = env.HOME ?? ""
  return join(home, ".config", "opencode")
}

/**
 * Install the `consultation` skill into the opencode config directory.
 *
 * The skill file is written to `<configDir>/skills/consultation/SKILL.md`
 * from the repo-root `assets/skills/consultation/SKILL.md`. The file is
 * written only when missing or when the content differs from the asset.
 * A file whose first line is `<!-- user-modified -->` is never overwritten.
 * Writes are atomic (write tmp then rename).
 */
async function installSkill(env: NodeJS.ProcessEnv, skillName: string): Promise<void> {
  const configDir = resolveOpencodeConfigDir(env)
  const targetDir = join(configDir, "skills", skillName)
  const targetFile = join(targetDir, "SKILL.md")

  const assetPath = resolveAsset(`skills/${skillName}/SKILL.md`)
  const assetContent = await readFile(assetPath, "utf8")

  let existing: string | undefined
  try {
    existing = await readFile(targetFile, "utf8")
  } catch {
    // missing file — proceed to write
  }

  if (existing !== undefined) {
    if (existing.startsWith(USER_MODIFIED_MARKER)) return
    if (existing === assetContent) return
  }

  await mkdir(targetDir, { recursive: true })
  const tmpFile = `${targetFile}.tmp`
  await writeFile(tmpFile, assetContent, "utf8")
  await rename(tmpFile, targetFile)
}

/** Install the core skill plus the design and doc sub-skills. */
export async function installConsultationSkills(env: NodeJS.ProcessEnv): Promise<void> {
  for (const skillName of CONSULTATION_SKILLS) await installSkill(env, skillName)
}

/** Backwards-compatible core-skill installer. */
export async function installConsultationSkill(env: NodeJS.ProcessEnv): Promise<void> {
  await installSkill(env, "consultation")
}
