#!/usr/bin/env bun
/**
 * Install a packaged (bundled) build into a stable prefix.
 *
 * Builds `dist/`, stages `dist/` + `assets/` into
 * `$JANUS_INSTALL_DIR` or `$XDG_DATA_HOME/janus-agent-plugin`
 * (default `~/.local/share/janus-agent-plugin`), and verifies the
 * result. The installed bundle is self-contained: it needs neither the repo
 * source nor node_modules at runtime.
 *
 * Run from the repo root:  bun run install:local
 */

import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

import {
  installConfigCommand,
  installHandoffCommand,
  installMemoryCommands,
  installModelsCommand,
} from "../packages/opencode-adapter/src/command-installer.ts"
import { loadPluginConfig } from "../packages/opencode-adapter/src/plugin-config.ts"
import { resolveOpencodeConfigDir } from "../packages/opencode-adapter/src/skill-installer.ts"

const here = dirname(fileURLToPath(import.meta.url))
const repoRoot = resolve(here, "..")
const DIST_DIR = join(repoRoot, "dist")
const ASSETS_DIR = join(repoRoot, "assets")

export const REQUIRED_INSTALLED_FILES = [
  "dist/index.js",
  "dist/memory-mcp-server.js",
  "dist/janus-keys.js",
  "bin/janus-keys",
  "assets/agents/janus.md",
  "assets/agents/simple.md",
  "assets/agents/consultant.md",
  "assets/agents/architect.md",
  "assets/agents/coder.md",
  "assets/agents/author.md",
  "assets/agents/common-explorer.md",
  "assets/agents/consultant-analyst.md",
  "assets/agents/consultant-critic.md",
  "assets/agents/consultant-auditor.md",
  "assets/agents/coder-reviewer.md",
  "assets/agents/author-writer.md",
  "assets/agents/author-reviewer.md",
  "assets/agents/coder-lite.md",
  "assets/model-prompts/claudesonnet55.md",
  "assets/model-prompts/gemini38flash.md",
  "assets/model-prompts/gemini4argon.md",
  "assets/model-prompts/deepseekflash.md",
  "assets/model-prompts/deepseekv41flash.md",
  "assets/model-prompts/glm53flash.md",
  "assets/model-prompts/glm53.md",
  "assets/model-prompts/grok47.md",
  "assets/model-prompts/kimik31pro.md",
  "assets/model-prompts/qwen38max.md",
  "assets/principles/common-base.md",
  "assets/principles/common-write.md",
  "assets/principles/research-leaf.md",
  "assets/principles/dispatch-hub.md",
  "assets/principles/reasoning-failures.md",
  "assets/principles/mode-routing.md",
  "assets/principles/claim-types.md",
  "assets/principles/source-criteria.md",
  "assets/principles/channel-policy.md",
  "assets/principles/engineering-principles.md",
  "assets/principles/user-facing-style.md",
  "assets/commands/janus-models.md",
  "assets/commands/janus-handoff.md",
  "assets/commands/janus-config.md",
  "assets/protocols/counter_evidence.md",
  "assets/protocols/hypothesis_matrix.md",
  "assets/protocols/plan_robustness.md",
  "assets/protocols/design_premortem.md",
  "assets/protocols/code_plan_review.md",
  "assets/skills/consultation/SKILL.md",
  "assets/skills/consultation-design/SKILL.md",
  "assets/skills/consultation-doc/SKILL.md",
]

export function resolveInstallRoot(env: NodeJS.ProcessEnv): string {
  if (env.JANUS_INSTALL_DIR && env.JANUS_INSTALL_DIR.length > 0) {
    return env.JANUS_INSTALL_DIR
  }
  const home = env.HOME && env.HOME.length > 0 ? env.HOME : homedir()
  const dataHome =
    env.XDG_DATA_HOME && env.XDG_DATA_HOME.length > 0
      ? env.XDG_DATA_HOME
      : join(home, ".local", "share")
  return join(dataHome, "janus-agent-plugin")
}

async function runBuild(): Promise<void> {
  const proc = Bun.spawn(["bun", "run", "script/build.ts"], {
    cwd: repoRoot,
    stdout: "inherit",
    stderr: "inherit",
  })
  const code = await proc.exited
  if (code !== 0) {
    throw new Error(`build failed with exit code ${code}`)
  }
}

function readPackageVersion(): string {
  const parsed = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    version?: string
  }
  return parsed.version ?? "0.0.0"
}

function gitSha(): string {
  const proc = Bun.spawnSync(["git", "rev-parse", "--short", "HEAD"], { cwd: repoRoot })
  if (proc.exitCode !== 0) return "unknown"
  return proc.stdout.toString().trim() || "unknown"
}

function stage(installRoot: string): void {
  rmSync(join(installRoot, "dist"), { recursive: true, force: true })
  rmSync(join(installRoot, "assets"), { recursive: true, force: true })
  mkdirSync(installRoot, { recursive: true })
  cpSync(DIST_DIR, join(installRoot, "dist"), { recursive: true })
  cpSync(ASSETS_DIR, join(installRoot, "assets"), { recursive: true })
}

function writeManifests(installRoot: string): void {
  const version = readPackageVersion()
  writeFileSync(
    join(installRoot, "package.json"),
    `${JSON.stringify(
      {
        name: "@janus-agent/opencode-adapter",
        version,
        type: "module",
        main: "dist/index.js",
        private: true,
      },
      null,
      2,
    )}\n`,
  )
  writeFileSync(
    join(installRoot, "build-meta.json"),
    `${JSON.stringify(
      { version, gitSha: gitSha(), builtAt: new Date().toISOString(), source: repoRoot },
      null,
      2,
    )}\n`,
  )
}

/** The `janus-keys` launcher: a shell shim over the bundled CLI. */
export function keysShimContent(installRoot: string): string {
  return `#!/bin/sh\nexec bun "${join(installRoot, "dist", "janus-keys.js")}" "$@"\n`
}

function writeKeysShim(installRoot: string): string {
  const shim = join(installRoot, "bin", "janus-keys")
  mkdirSync(dirname(shim), { recursive: true })
  writeFileSync(shim, keysShimContent(installRoot))
  chmodSync(shim, 0o755)
  return shim
}

/**
 * Write the slash-command files now so they exist before OpenCode's next
 * startup scans its commands directory; the plugin's config hook only writes
 * them during startup, which is too late for that same startup. Honors
 * `install_commands` and the `<!-- user-modified -->` marker;
 * `JANUS_SKIP_COMMAND_SYNC=1` skips it (throwaway installs such as the
 * integration run must not touch the real OpenCode config).
 */
async function syncCommands(): Promise<void> {
  if (process.env.JANUS_SKIP_COMMAND_SYNC === "1") {
    console.log("commands not synced: JANUS_SKIP_COMMAND_SYNC=1")
    return
  }
  let installCommands = true
  try {
    installCommands = (await loadPluginConfig(process.env)).install_commands
  } catch (error) {
    console.warn(`WARNING: plugin config unreadable, commands not synced: ${error instanceof Error ? error.message : String(error)}`)
    return
  }
  if (!installCommands) {
    console.log("commands not synced: install_commands is false")
    return
  }
  await installMemoryCommands(process.env)
  await installModelsCommand(process.env)
  await installHandoffCommand(process.env)
  await installConfigCommand(process.env)
  console.log(`synced commands into ${join(resolveOpencodeConfigDir(process.env), "commands")}`)
}

function missingFiles(installRoot: string): string[] {
  return REQUIRED_INSTALLED_FILES.filter((rel) => !existsSync(join(installRoot, rel)))
}

async function main(): Promise<void> {
  const installRoot = resolveInstallRoot(process.env)
  console.log(`install root: ${installRoot}`)

  await runBuild()
  stage(installRoot)
  writeManifests(installRoot)
  const shim = writeKeysShim(installRoot)

  const missing = missingFiles(installRoot)
  if (missing.length > 0) {
    console.error("FAIL: installed artifact is incomplete:")
    for (const rel of missing) console.error(`  missing: ${rel}`)
    process.exit(1)
  }
  await syncCommands()

  const entry = `file://${join(installRoot, "dist/index.js")}`
  console.log(`installed ${REQUIRED_INSTALLED_FILES.length} required files`)
  console.log("")
  console.log("Provider key CLI (optional shortcut):")
  console.log(`  ${shim} help`)
  console.log(`  alias janus-keys='${shim}'   # add to ~/.zshrc to type just janus-keys`)
  console.log("")
  console.log("Point your OpenCode config at the installed bundle:")
  console.log(`  "plugin": ["${entry}"]`)
  console.log("")
  console.log("Verify the installed artifact:")
  console.log(`  JANUS_PLUGIN_ENTRY=${entry} bun run integration`)
}

if (import.meta.main) {
  await main()
}
