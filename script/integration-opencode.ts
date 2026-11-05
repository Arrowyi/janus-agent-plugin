#!/usr/bin/env bun
/**
 * Isolated OpenCode integration proof for the janus-agent plugin.
 *
 * Behavior:
 *   (a) If `opencode` is not on PATH, print a clear SKIP message and exit 0.
 *   (b) Create a temp sandbox dir; set XDG_DATA_HOME / XDG_CONFIG_HOME /
 *       XDG_STATE_HOME / XDG_CACHE_HOME (and HOME) to subdirs of it for the
 *       opencode child process so the real user config/DB is never touched.
 *   (c) Write `<sandbox>/config/opencode/opencode.json` with a `file://`
 *       plugin entry. By default this script builds the bundle and installs it
 *       into a fresh temporary prefix, then points OpenCode at that installed
 *       `dist/index.js`. Override the entry with `JANUS_PLUGIN_ENTRY`
 *       (bare path or `file://` URL) to test another build.
 *   (d) Spawn `opencode serve --port <free>` (a free port is picked via a
 *       short-lived Bun.serve so health polling has a known target; --port 0
 *       is supported by opencode but parsing stdout for the assigned port is
 *       fragile across versions). Wait for readiness via /global/health.
 *   (e) Assert via HTTP: GET /config responds 200 and its JSON contains the
 *       `consultant` agent key, the `author-writer` agent key, and the
 *       `janus-memory` mcp key.
 *   (f) Assert the consultation skill file and the janus-models and
 *       janus-handoff command files were installed in the sandbox config
 *       directory.
 *   (g) Assert NOTHING was written into the plugin repo directory during the
 *       run by comparing `git status --porcelain` before and after.
 *   (h) Kill the server, print a PASS/FAIL evidence summary per assertion,
 *       exit non-zero on any FAIL.
 *
 * Run from the repo root:  bun run integration
 *
 * Self-contained: only Bun builtins (Bun.spawn, Bun.serve, fetch) and
 * node:fs / node:os / node:path.
 */

import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { fileURLToPath } from "node:url"
import { computeProjectId } from "../packages/opencode-adapter/src/agent-registration.ts"
import { buildCleanRoomEnv } from "./integration-env.ts"
import { proveDispatchPrimitives } from "./integration-dispatch-primitives.ts"
import {
  type Assertion,
  gitStatusPorcelain,
  hasNestedKey,
  isOpencodeOnPath,
  pickFreePort,
  resolvePluginEntry,
  toFileUrl,
  waitForHealth,
  authorWriterAssetPathForEntry,
} from "./integration-helpers.ts"

function readAgentPermission(
  configJson: unknown,
  agent: string,
): Record<string, unknown> | undefined {
  if (typeof configJson !== "object" || configJson === null) return undefined
  const agentMap = (configJson as Record<string, unknown>)["agent"]
  if (typeof agentMap !== "object" || agentMap === null) return undefined
  const entry = (agentMap as Record<string, unknown>)[agent]
  if (typeof entry !== "object" || entry === null) return undefined
  const permission = (entry as Record<string, unknown>)["permission"]
  return typeof permission === "object" && permission !== null
    ? (permission as Record<string, unknown>)
    : undefined
}

function readAgentPrompt(configJson: unknown, agent: string): string | undefined {
  if (typeof configJson !== "object" || configJson === null) return undefined
  const agentMap = (configJson as Record<string, unknown>)["agent"]
  if (typeof agentMap !== "object" || agentMap === null) return undefined
  const entry = (agentMap as Record<string, unknown>)[agent]
  if (typeof entry !== "object" || entry === null) return undefined
  const prompt = (entry as Record<string, unknown>)["prompt"]
  return typeof prompt === "string" ? prompt : undefined
}

async function main(): Promise<void> {
  const onPath = await isOpencodeOnPath()
  if (!onPath) {
    console.log("SKIP: opencode is not on PATH.")
    console.log("SKIP: The integration test requires opencode to be installed and on PATH.")
    console.log("SKIP: Install opencode or add it to PATH, then re-run: bun run integration")
    process.exit(0)
  }
  console.log("integration: opencode found on PATH")

  const sandbox = realpathSync(mkdtempSync(join(tmpdir(), "consult-integration-")))
  const sandboxData = join(sandbox, "data")
  const sandboxConfig = join(sandbox, "config")
  const sandboxState = join(sandbox, "state")
  const sandboxCache = join(sandbox, "cache")
  const sandboxHome = join(sandbox, "home")
  const sandboxProj = join(sandbox, "proj")
  for (const dir of [sandboxData, sandboxConfig, sandboxState, sandboxCache, sandboxHome, sandboxProj]) {
    mkdirSync(dir, { recursive: true })
  }

  const password = `int-${Math.random().toString(36).slice(2)}`
  const auth = `Basic ${btoa(`opencode:${password}`)}`

  const pluginEntry = await resolvePluginEntry()
  const adapterEntry = pluginEntry.entry
  console.log(`integration: plugin entry = ${adapterEntry}`)
  const installPrefix = pluginEntry.kind !== "override" ? pluginEntry.prefix : undefined
  const opencodeConfigDir = join(sandboxConfig, "opencode")
  mkdirSync(opencodeConfigDir, { recursive: true })
  const opencodeConfig = {
    $schema: "https://opencode.ai/config.json",
    plugin: [toFileUrl(adapterEntry)],
  }
  writeFileSync(join(opencodeConfigDir, "opencode.json"), `${JSON.stringify(opencodeConfig, null, 2)}\n`)

  const gitBefore = await gitStatusPorcelain()

  const assertions: Assertion[] = []

  const writerAssetPath = authorWriterAssetPathForEntry(adapterEntry)
  if (writerAssetPath !== undefined) {
    const writerAssetExists = existsSync(writerAssetPath)
    assertions.push({
      name: "packaged author-writer asset exists in plugin prefix",
      pass: writerAssetExists,
      detail: writerAssetExists ? writerAssetPath : `NOT FOUND: ${writerAssetPath}`,
    })
  }

  let proc: ReturnType<typeof Bun.spawn> | null = null

  try {
    const port = pickFreePort()
    const baseUrl = `http://127.0.0.1:${port}`
    console.log(`integration: spawning opencode serve on port ${port}`)

    const sandboxPaths = {
      home: sandboxHome,
      xdgConfigHome: sandboxConfig,
      xdgDataHome: sandboxData,
      xdgStateHome: sandboxState,
      xdgCacheHome: sandboxCache,
    }
    const childEnv = buildCleanRoomEnv(process.env, sandboxPaths)
    childEnv.OPENCODE_SERVER_PASSWORD = password

    proc = Bun.spawn(["opencode", "serve", "--port", String(port), "--hostname", "127.0.0.1"], {
      cwd: sandboxProj,
      env: childEnv,
      stdout: "inherit",
      stderr: "inherit",
    })

    const ready = await waitForHealth(`${baseUrl}/global/health`, auth, 30000)
    if (!ready) {
      assertions.push({
        name: "server readiness",
        pass: false,
        detail: "opencode serve did not become ready within 30s (check stderr above for errors)",
      })
    } else {
      assertions.push({
        name: "server readiness",
        pass: true,
        detail: `GET /global/health responded 200 (${baseUrl})`,
      })

      try {
        const resp = await fetch(`${baseUrl}/config`, { headers: { Authorization: auth } })
        const status = resp.status
        assertions.push({
          name: "GET /config responds 200",
          pass: status === 200,
          detail: `status=${status}`,
        })

        if (status === 200) {
          const json: unknown = await resp.json()
          const hasConsultant = hasNestedKey(json, "agent", "consultant")
          const hasMemoryMcp = hasNestedKey(json, "mcp", "janus-memory")
          const hasWriter = hasNestedKey(json, "agent", "author-writer")
          assertions.push({
            name: "config has consultant agent key",
            pass: hasConsultant,
            detail: hasConsultant ? "agent.consultant present" : "agent.consultant MISSING",
          })
          assertions.push({
            name: "config has janus-memory mcp key",
            pass: hasMemoryMcp,
            detail: hasMemoryMcp ? "mcp.janus-memory present" : "mcp.janus-memory MISSING",
          })
          assertions.push({
            name: "config has packaged author-writer agent key",
            pass: hasWriter,
            detail: hasWriter ? "agent.author-writer present" : "agent.author-writer MISSING",
          })
          for (const role of ["simple", "architect", "author", "coder", "coder-lite", "common-explorer", "consultant-analyst", "consultant-critic", "consultant-auditor", "coder-reviewer", "author-writer", "author-reviewer"]) {
            const present = hasNestedKey(json, "agent", role)
            assertions.push({
              name: `config has ${role} agent key`,
              pass: present,
              detail: present ? `agent.${role} present` : `agent.${role} MISSING`,
            })
          }
          const hasJanus = hasNestedKey(json, "agent", "janus")
          assertions.push({
            name: "config has janus agent key",
            pass: hasJanus,
            detail: hasJanus ? "agent.janus present" : "agent.janus MISSING",
          })
          const janusPrompt = readAgentPrompt(json, "janus")
          const janusHasCommonPrinciples =
            janusPrompt !== undefined && janusPrompt.includes("## Common Operating Principles")
          assertions.push({
            name: "installed janus prompt includes common principles",
            pass: janusHasCommonPrinciples,
            detail: janusHasCommonPrinciples
              ? "agent.janus.prompt contains ## Common Operating Principles"
              : "agent.janus.prompt MISSING ## Common Operating Principles",
          })

          const designStateDir = join(sandboxData, "janus-agent", "design")
          const authorStateDir = join(sandboxData, "janus-agent", "author")
          const handoffStateDir = join(sandboxData, "janus-agent", "handoff")
          const projectId = computeProjectId(sandboxProj)
          const coderExternal = readAgentPermission(json, "coder")?.["external_directory"] as
            | Record<string, string>
            | undefined
          const architectExternal = readAgentPermission(json, "architect")?.["external_directory"] as
            | Record<string, string>
            | undefined
          const authorExternal = readAgentPermission(json, "author")?.["external_directory"] as
            | Record<string, string>
            | undefined
          const reviewerExternal = readAgentPermission(json, "author-reviewer")?.["external_directory"] as
            | Record<string, string>
            | undefined
          const reviewerPermission = readAgentPermission(json, "author-reviewer")
          const architectPrompt = readAgentPrompt(json, "architect")
          const authorPrompt = readAgentPrompt(json, "author")
          const coderPrompt = readAgentPrompt(json, "coder")

          assertions.push({
            name: "architect grants external access to the design state dir",
            pass: architectExternal?.[`${designStateDir}/**`] === "allow",
            detail: architectExternal?.[`${designStateDir}/**`] ?? "design state dir not allowed",
          })
          assertions.push({
            name: "author grants external access to the author state dir",
            pass: authorExternal?.[`${authorStateDir}/**`] === "allow",
            detail: authorExternal?.[`${authorStateDir}/**`] ?? "author state dir not allowed",
          })
          assertions.push({
            name: "author grants external access to the design state dir",
            pass: authorExternal?.[`${designStateDir}/**`] === "allow",
            detail: authorExternal?.[`${designStateDir}/**`] ?? "design state dir not allowed",
          })
          assertions.push({
            name: "coder grants external access to the design state dir",
            pass: coderExternal?.[`${designStateDir}/**`] === "allow",
            detail: coderExternal?.[`${designStateDir}/**`] ?? "design state dir not allowed",
          })
          assertions.push({
            name: "author-reviewer grants read-only external access to both state dirs",
            pass:
              reviewerExternal?.[`${authorStateDir}/**`] === "allow" &&
              reviewerExternal?.[`${designStateDir}/**`] === "allow" &&
              reviewerPermission?.["edit"] === "deny" &&
              reviewerPermission?.["bash"] === "deny" &&
              reviewerPermission?.["webfetch"] === "deny" &&
              reviewerPermission?.["websearch"] === "deny",
            detail: `author=${reviewerExternal?.[`${authorStateDir}/**`]} design=${reviewerExternal?.[`${designStateDir}/**`]} edit=${reviewerPermission?.["edit"]} bash=${reviewerPermission?.["bash"]}`,
          })
          const coderReviewerExternal = readAgentPermission(json, "coder-reviewer")?.["external_directory"] as
            | Record<string, string>
            | undefined
          const coderReviewerPermission = readAgentPermission(json, "coder-reviewer")
          assertions.push({
            name: "coder-reviewer grants read-only external access to the design state dir",
            pass:
              coderReviewerExternal?.[`${designStateDir}/**`] === "allow" &&
              coderReviewerPermission?.["edit"] === "deny" &&
              coderReviewerPermission?.["bash"] === "deny" &&
              coderReviewerPermission?.["task"] === "deny",
            detail: `design=${coderReviewerExternal?.[`${designStateDir}/**`]} edit=${coderReviewerPermission?.["edit"]} bash=${coderReviewerPermission?.["bash"]} task=${coderReviewerPermission?.["task"]}`,
          })
          assertions.push({
            name: "design state directory created",
            pass: existsSync(designStateDir),
            detail: existsSync(designStateDir) ? designStateDir : `NOT FOUND: ${designStateDir}`,
          })
          assertions.push({
            name: "architect prompt names the design state dir and project id",
            pass:
              architectPrompt !== undefined &&
              architectPrompt.includes(`Design state dir: \`${designStateDir}\``) &&
              architectPrompt.includes(`project id: \`${projectId}\``),
            detail: architectPrompt?.includes(designStateDir)
              ? `design dir + project id ${projectId}`
              : "architect prompt MISSING design binding",
          })
          assertions.push({
            name: "author prompt names the author state dir and project id",
            pass:
              authorPrompt !== undefined &&
              authorPrompt.includes(`Author state dir: \`${authorStateDir}\``) &&
              authorPrompt.includes(`project id: \`${projectId}\``),
            detail: authorPrompt?.includes(authorStateDir)
              ? `author dir + project id ${projectId}`
              : "author prompt MISSING author binding",
          })
          assertions.push({
            name: "coder prompt names the project design base dir",
            pass: coderPrompt !== undefined && coderPrompt.includes(`Design record: \`${designStateDir}/${projectId}\``),
            detail: coderPrompt?.includes(`${designStateDir}/${projectId}`)
              ? `design base dir for ${projectId}`
              : "coder prompt MISSING design binding",
          })

          // The handoff dir is the one business-state dir shared by all five
          // primary entries.
          for (const role of ["janus", "consultant", "architect", "coder", "author"]) {
            const external = readAgentPermission(json, role)?.["external_directory"] as
              | Record<string, string>
              | undefined
            assertions.push({
              name: `${role} grants external access to the handoff state dir`,
              pass: external?.[`${handoffStateDir}/**`] === "allow",
              detail: external?.[`${handoffStateDir}/**`] ?? "handoff state dir not allowed",
            })
            const prompt = readAgentPrompt(json, role)
            const hasHandoffBinding =
              prompt !== undefined && prompt.includes(`Handoff state dir: \`${handoffStateDir}/${projectId}\``)
            assertions.push({
              name: `${role} prompt names the handoff state dir and project id`,
              pass: hasHandoffBinding,
              detail: hasHandoffBinding
                ? `handoff dir for ${projectId}`
                : `${role} prompt MISSING handoff binding`,
            })
          }
          const handoffDirExists = existsSync(handoffStateDir)
          assertions.push({
            name: "handoff state directory created",
            pass: handoffDirExists,
            detail: handoffDirExists ? handoffStateDir : `NOT FOUND: ${handoffStateDir}`,
          })
          const leafWithoutHandoff = ["simple", "coder-lite", "common-explorer", "consultant-analyst"]
          for (const role of leafWithoutHandoff) {
            const external = readAgentPermission(json, role)?.["external_directory"] as
              | Record<string, string>
              | undefined
            const lacksHandoff = external === undefined || external[`${handoffStateDir}/**`] === undefined
            assertions.push({
              name: `${role} holds no handoff state dir permission`,
              pass: lacksHandoff,
              detail: lacksHandoff ? "no handoff dir allow rule" : "unexpected handoff dir allow rule",
            })
          }
        }
      } catch (err) {
        const detail = err instanceof Error ? err.message : String(err)
        assertions.push({ name: "GET /config", pass: false, detail: `fetch error: ${detail}` })
      }

      const skillPaths = {
        consultation: join(sandboxConfig, "opencode", "skills", "consultation", "SKILL.md"),
        "consultation-design": join(sandboxConfig, "opencode", "skills", "consultation-design", "SKILL.md"),
        "consultation-doc": join(sandboxConfig, "opencode", "skills", "consultation-doc", "SKILL.md"),
      }
      for (const [name, skillPath] of Object.entries(skillPaths)) {
        const installed = existsSync(skillPath)
        assertions.push({
          name: `${name} skill installed in sandbox config`,
          pass: installed,
          detail: installed ? skillPath : `NOT FOUND: ${skillPath}`,
        })
      }

      const coreSkill = existsSync(skillPaths.consultation) ? readFileSync(skillPaths.consultation, "utf8") : ""
      const designSkill = existsSync(skillPaths["consultation-design"])
        ? readFileSync(skillPaths["consultation-design"], "utf8")
        : ""
      const docSkill = existsSync(skillPaths["consultation-doc"])
        ? readFileSync(skillPaths["consultation-doc"], "utf8")
        : ""
      assertions.push({
        name: "installed core skill contains the mode stack and sub-skill pointers",
        pass: coreSkill.includes("### Mode Stack") && coreSkill.includes("consultation-design") && coreSkill.includes("consultation-doc"),
        detail: "core skill mode stack and sub-skill pointers",
      })
      assertions.push({
        name: "installed design skill contains the design method and template",
        pass: designSkill.includes("## Design Mode") && designSkill.includes("### design: decision record"),
        detail: designSkill.includes("## Design Mode") ? "design skill present" : "design skill MISSING design mode",
      })
      assertions.push({
        name: "installed doc skill contains the doc workflow and template",
        pass: docSkill.includes("## Doc Mode") && docSkill.includes("### doc: delivery brief"),
        detail: docSkill.includes("## Doc Mode") ? "doc skill present" : "doc skill MISSING doc mode",
      })
      for (const name of ["janus_dispatch_wait", "janus_dispatch_cancel", "janus_dispatch_continue"]) {
        assertions.push({
          name: `installed core skill names ${name}`,
          pass: coreSkill.includes(name),
          detail: "installed tool-routing token",
        })
      }
      const modelsCommandPath = join(sandboxConfig, "opencode", "commands", "janus-models.md")
      const modelsCommandExists = existsSync(modelsCommandPath)
      assertions.push({
        name: "janus-models command installed in sandbox config",
        pass: modelsCommandExists,
        detail: modelsCommandExists ? modelsCommandPath : `NOT FOUND: ${modelsCommandPath}`,
      })

      if (modelsCommandExists) {
        const modelsCommandText = readFileSync(modelsCommandPath, "utf8")
        const hasInventory = modelsCommandText.includes("Inventory")
        const hasModelEval = modelsCommandText.includes("Model evaluation")
        const hasPromptEval = modelsCommandText.includes("Prompt evaluation")
        const hasExecute = modelsCommandText.includes("Execute changes")
        assertions.push({
          name: "installed janus-models command contains the workflow dimensions",
          pass: hasInventory && hasModelEval && hasPromptEval && hasExecute,
          detail: `Inventory=${hasInventory} Model evaluation=${hasModelEval} Prompt evaluation=${hasPromptEval} Execute changes=${hasExecute}`,
        })
      }
      const handoffCommandPath = join(sandboxConfig, "opencode", "commands", "janus-handoff.md")
      const handoffCommandExists = existsSync(handoffCommandPath)
      assertions.push({
        name: "janus-handoff command installed in sandbox config",
        pass: handoffCommandExists,
        detail: handoffCommandExists ? handoffCommandPath : `NOT FOUND: ${handoffCommandPath}`,
      })

      if (handoffCommandExists) {
        const handoffCommandText = readFileSync(handoffCommandPath, "utf8")
        const hasContract =
          handoffCommandText.includes("## 1. Current Truth Snapshot") &&
          handoffCommandText.includes("## 2. Handoff Ledger (Newest First)")
        const hasSubcommands =
          handoffCommandText.includes("`use <id|n>`") &&
          handoffCommandText.includes("`archive <n|range>`") &&
          handoffCommandText.includes("`delete`") &&
          handoffCommandText.includes("`export <n> [path]`") &&
          handoffCommandText.includes("`import <path>`")
        assertions.push({
          name: "installed janus-handoff command contains the document contract and subcommand surface",
          pass: hasContract && hasSubcommands,
          detail: `contract=${hasContract} subcommands=${hasSubcommands}`,
        })
      }
      const configCommandPath = join(sandboxConfig, "opencode", "commands", "janus-config.md")
      const configCommandExists = existsSync(configCommandPath)
      assertions.push({
        name: "janus-config command installed in sandbox config",
        pass: configCommandExists,
        detail: configCommandExists ? configCommandPath : `NOT FOUND: ${configCommandPath}`,
      })

      if (configCommandExists) {
        const configCommandText = readFileSync(configCommandPath, "utf8")
        const hasTool =
          configCommandText.includes("`janus_config`") && configCommandText.includes("`janus_provider_keys`")
        const hasFlows =
          configCommandText.includes("## Main menu") &&
          configCommandText.includes("## Change a value") &&
          configCommandText.includes("## Reset everything")
        assertions.push({
          name: "installed janus-config command drives the janus_config tool through guided menus",
          pass: hasTool && hasFlows,
          detail: `tool=${hasTool} flows=${hasFlows}`,
        })
      }
      const entryPath = adapterEntry.startsWith("file://") ? fileURLToPath(adapterEntry) : adapterEntry
      const keysCli = join(dirname(entryPath), "janus-keys.js")
      const keysShim = join(dirname(dirname(entryPath)), "bin", "janus-keys")
      assertions.push({
        name: "installed artifact ships the janus-keys CLI and its shim",
        pass: existsSync(keysCli) && existsSync(keysShim),
        detail: `cli=${existsSync(keysCli) ? keysCli : `NOT FOUND: ${keysCli}`} shim=${existsSync(keysShim) ? keysShim : `NOT FOUND: ${keysShim}`}`,
      })
      const liteWorkspace = join(sandboxData, "janus-agent", "lite")
      const liteWorkspaceExists = existsSync(liteWorkspace)
      assertions.push({
        name: "lite workspace directory created",
        pass: liteWorkspaceExists,
        detail: liteWorkspaceExists ? liteWorkspace : `NOT FOUND: ${liteWorkspace}`,
      })
      assertions.push(...await proveDispatchPrimitives(async (path, body) => {
        const response = await fetch(`${baseUrl}${path}?directory=${encodeURIComponent(sandboxProj)}`, {
          method: body === undefined ? "GET" : "POST",
          headers: { Authorization: auth, "Content-Type": "application/json" },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        })
        if (!response.ok) throw new Error(`primitive HTTP ${response.status}: ${await response.text()}`)
        return response.json()
      }, sandboxProj))
    }

    const gitAfter = await gitStatusPorcelain()
    const repoUntouched = gitBefore === gitAfter
    assertions.push({
      name: "repo directory untouched during run",
      pass: repoUntouched,
      detail: repoUntouched
        ? "git status --porcelain unchanged before vs after"
        : "git status --porcelain CHANGED (new files written into the repo)",
    })
  } finally {
    if (proc !== null) {
      try {
        proc.kill("SIGTERM")
      } catch (error) {
        if (!(error instanceof Error)) throw error
      }
      try {
        await proc.exited
      } catch (error) {
        if (!(error instanceof Error)) throw error
      }
    }
    rmSync(sandbox, { recursive: true, force: true })
    if (installPrefix !== undefined) {
      rmSync(installPrefix, { recursive: true, force: true })
    }
  }

  console.log("")
  console.log("=== integration evidence ===")
  for (const a of assertions) {
    const tag = a.pass ? "PASS" : "FAIL"
    console.log(`  ${tag}: ${a.name} - ${a.detail}`)
  }

  const allPass = assertions.length > 0 && assertions.every((a) => a.pass)
  console.log("")
  if (allPass) {
    console.log(`integration: PASS (${assertions.length} assertions)`)
    process.exit(0)
  } else {
    const fails = assertions.filter((a) => !a.pass).length
    console.error(`integration: FAIL (${fails} of ${assertions.length} assertions failed)`)
    process.exit(1)
  }
}

await main()
