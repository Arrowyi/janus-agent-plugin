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
 *   (f) Assert the three consultation skill files and the three janus
 *       command files were installed in the sandbox config directory, and
 *       that the startup prune removed staged retired probes (fingerprint-
 *       bearing, not user-modified) while user-modified and foreign probes
 *       survived.
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

import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { computeProjectId, editAllowTwins } from "../packages/opencode-adapter/src/agent-registration.ts"
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

  // Stage pruning probes in the sandbox config directory BEFORE the server
  // starts: the plugin's config hook runs the startup prune, so the probes
  // prove the D5 pruning behavior against the real startup path. The
  // fingerprint strings mirror what script/gen-skill.ts emits and what the
  // command files reference (the janus data root), without naming any
  // retired command or skill.
  const sandboxSkillsDir = join(opencodeConfigDir, "skills")
  const sandboxCommandsDir = join(opencodeConfigDir, "commands")
  mkdirSync(sandboxSkillsDir, { recursive: true })
  mkdirSync(sandboxCommandsDir, { recursive: true })
  const genMarker = "<!-- generated by script/gen-skill.ts from skill-src/"
  const dataRootFingerprint = "$XDG_DATA_HOME/janus-agent/"
  const userModified = "<!-- user-modified -->"
  mkdirSync(join(sandboxSkillsDir, "retired-probe"), { recursive: true })
  writeFileSync(
    join(sandboxSkillsDir, "retired-probe", "SKILL.md"),
    `${genMarker}retired-probe; do not edit -->\njanus-agent\n`,
  )
  mkdirSync(join(sandboxSkillsDir, "user-probe"), { recursive: true })
  writeFileSync(
    join(sandboxSkillsDir, "user-probe", "SKILL.md"),
    `${userModified}\n${genMarker}user-probe; do not edit -->\njanus-agent\n`,
  )
  mkdirSync(join(sandboxSkillsDir, "foreign-skill"), { recursive: true })
  writeFileSync(join(sandboxSkillsDir, "foreign-skill", "SKILL.md"), "a foreign skill with no install fingerprints\n")
  writeFileSync(join(sandboxCommandsDir, "janus-retired-probe.md"), `Data root: ${dataRootFingerprint}probe\n`)
  writeFileSync(join(sandboxCommandsDir, "janus-user-probe.md"), `${userModified}\nData root: ${dataRootFingerprint}probe\n`)
  writeFileSync(join(sandboxCommandsDir, "foreign-notes.md"), "a foreign file with no janus fingerprints\n")

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

      const liteWorkspace = join(sandboxData, "janus-agent", "lite")

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
          for (const role of ["simple", "architect", "tech-lead", "author", "coder", "solution-reviewer", "common-explorer", "consultant-analyst", "consultant-critic", "consultant-auditor", "coder-reviewer", "author-writer", "author-reviewer"]) {
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
          const janusPromptCommon = readAgentPrompt(json, "janus")
          const janusHasCommonPrinciples =
            janusPromptCommon !== undefined && janusPromptCommon.includes("## Common Operating Principles")
          assertions.push({
            name: "installed janus prompt includes common principles",
            pass: janusHasCommonPrinciples,
            detail: janusHasCommonPrinciples
              ? "agent.janus.prompt contains ## Common Operating Principles"
              : "agent.janus.prompt MISSING ## Common Operating Principles",
          })

          const designStateDir = join(sandboxData, "janus-agent", "design")
          const authorStateDir = join(sandboxData, "janus-agent", "author")
          const ledgerStateDir = join(sandboxData, "janus-agent", "ledger")
          const projectId = computeProjectId(sandboxProj)
          const coderExternal = readAgentPermission(json, "coder")?.["external_directory"] as
            | Record<string, string>
            | undefined
          const architectExternal = readAgentPermission(json, "architect")?.["external_directory"] as
            | Record<string, string>
            | undefined
          const janusExternal = readAgentPermission(json, "janus")?.["external_directory"] as
            | Record<string, string>
            | undefined
          const authorExternal = readAgentPermission(json, "author")?.["external_directory"] as
            | Record<string, string>
            | undefined
          const consultantExternal = readAgentPermission(json, "consultant")?.["external_directory"] as
            | Record<string, string>
            | undefined
          const reviewerExternal = readAgentPermission(json, "author-reviewer")?.["external_directory"] as
            | Record<string, string>
            | undefined
          const reviewerPermission = readAgentPermission(json, "author-reviewer")
          const architectPrompt = readAgentPrompt(json, "architect")
          const techLeadPrompt = readAgentPrompt(json, "tech-lead")
          const authorPrompt = readAgentPrompt(json, "author")
          const janusPrompt = readAgentPrompt(json, "janus")
          const consultantPrompt = readAgentPrompt(json, "consultant")

          const architectExternalShaped =
            architectExternal !== undefined &&
            Object.keys(architectExternal).length === 1 &&
            architectExternal[`${designStateDir}/**`] === "allow"
          assertions.push({
            name: "architect grants external access to exactly the design state dir",
            pass: architectExternalShaped,
            detail: architectExternalShaped
              ? "exactly the design state dir"
              : `unexpected architect external_directory: ${JSON.stringify(architectExternal)}`,
          })
          const janusExternalShaped =
            janusExternal !== undefined &&
            Object.keys(janusExternal).length === 1 &&
            janusExternal[`${designStateDir}/**`] === "allow"
          assertions.push({
            name: "janus grants external access to exactly the design state dir",
            pass: janusExternalShaped,
            detail: janusExternalShaped
              ? "exactly the design state dir (the unattended tech-lead relay read grant)"
              : `unexpected janus external_directory: ${JSON.stringify(janusExternal)}`,
          })
          const authorExternalShaped =
            authorExternal !== undefined &&
            Object.keys(authorExternal).length === 2 &&
            authorExternal[`${authorStateDir}/**`] === "allow" &&
            authorExternal[`${designStateDir}/**`] === "allow"
          assertions.push({
            name: "author grants external access to exactly the author and design state dirs",
            pass: authorExternalShaped,
            detail: authorExternalShaped
              ? "author + design state dirs"
              : `unexpected author external_directory: ${JSON.stringify(authorExternal)}`,
          })
          const consultantExternalShaped =
            consultantExternal !== undefined &&
            Object.keys(consultantExternal).length === 1 &&
            consultantExternal[`${ledgerStateDir}/${projectId}/**`] === "allow"
          assertions.push({
            name: "consultant grants external access to exactly the project-scoped ledger dir",
            pass: consultantExternalShaped,
            detail: consultantExternalShaped
              ? `exactly ${ledgerStateDir}/${projectId}`
              : `unexpected consultant external_directory: ${JSON.stringify(consultantExternal)}`,
          })
          const tmpScopeDirs = [
            `${tmpdir()}/opencode`,
            `${realpathSync(tmpdir())}/opencode`,
            "/tmp/opencode",
            "/private/tmp/opencode",
          ]
          const coderTmpScopes = new Set(tmpScopeDirs.map((scopeDir) => `${scopeDir}/**`))
          const coderTmpScoped =
            coderExternal !== undefined &&
            Object.keys(coderExternal).length === 4 &&
            Object.keys(coderExternal).every((key) => coderTmpScopes.has(key)) &&
            coderExternal[`${designStateDir}/**`] === undefined
          assertions.push({
            name: "coder external access is limited to the shared tmp scopes (no design state dir)",
            pass: coderTmpScoped,
            detail: coderTmpScoped
              ? "exactly the four tmpdir opencode scopes"
              : `unexpected coder external_directory: ${JSON.stringify(coderExternal)}`,
          })

          // Edit-rule twins: host edit permissions evaluate
          // path.relative(worktree, file) submissions, so each sanctioned
          // allow also carries the base-relative twin. The expected record is
          // computed with the same editAllowTwins helper the registration
          // uses, keyed against the sandbox project dir.
          const techLeadEdit = readAgentPermission(json, "tech-lead")?.["edit"] as
            | Record<string, string>
            | undefined
          const expectedTechLeadEdit: Record<string, string> = {
            "*": "deny",
            ...editAllowTwins([sandboxProj], designStateDir),
          }
          const techLeadEditShaped =
            techLeadEdit !== undefined &&
            JSON.stringify(Object.keys(techLeadEdit)) === JSON.stringify(Object.keys(expectedTechLeadEdit)) &&
            Object.keys(expectedTechLeadEdit).every(
              (key) => techLeadEdit[key] === expectedTechLeadEdit[key],
            )
          assertions.push({
            name: "tech-lead edit is the deny catch-all plus the design dir and its sandbox-relative twins",
            pass: techLeadEditShaped,
            detail: techLeadEditShaped
              ? "deny catch-all first, design absolute/de-slash/realpath + relative twins allow"
              : `unexpected tech-lead edit: ${JSON.stringify(techLeadEdit)}`,
          })

          const coderEdit = readAgentPermission(json, "coder")?.["edit"] as
            | Record<string, string>
            | undefined
          const coderEditShaped =
            coderEdit !== undefined &&
            Object.keys(coderEdit)[0] === "*" &&
            coderEdit["*"] === "allow" &&
            coderEdit["../*"] === "ask" &&
            coderEdit["/*"] === "ask" &&
            tmpScopeDirs.every((scopeDir) => coderEdit[`${scopeDir}/**`] === "allow") &&
            tmpScopeDirs.every(
              (scopeDir) => coderEdit[`${relative(sandboxProj, scopeDir)}/**`] === "allow",
            ) &&
            coderEdit[`${relative(sandboxProj, designStateDir)}/**`] === undefined
          assertions.push({
            name: "coder edit asks for external edits under both shapes and allows the tmp-scope twins",
            pass: coderEditShaped,
            detail: coderEditShaped
              ? "allow catch-all first, ../* and /* asks, tmp twins last"
              : `unexpected coder edit: ${JSON.stringify(coderEdit)}`,
          })

          const liteEdit = readAgentPermission(json, "simple")?.["edit"] as
            | Record<string, string>
            | undefined
          const liteEditShaped =
            liteEdit !== undefined &&
            Object.keys(liteEdit)[0] === "*" &&
            liteEdit["*"] === "ask" &&
            liteEdit[`${liteWorkspace}/**`] === "allow" &&
            liteEdit[`${relative(sandboxProj, liteWorkspace)}/**`] === "allow"
          assertions.push({
            name: "simple edit allows its workspace plus the sandbox-relative twin",
            pass: liteEditShaped,
            detail: liteEditShaped
              ? "ask catch-all first, workspace absolute + relative twin allow"
              : `unexpected simple edit: ${JSON.stringify(liteEdit)}`,
          })
          assertions.push({
            name: "author-reviewer grants read-only external access to both state dirs plus budgeted web lookups",
            pass:
              reviewerExternal?.[`${authorStateDir}/**`] === "allow" &&
              reviewerExternal?.[`${designStateDir}/**`] === "allow" &&
              reviewerPermission?.["edit"] === "deny" &&
              reviewerPermission?.["bash"] === "deny" &&
              reviewerPermission?.["task"] === "deny" &&
              reviewerPermission?.["webfetch"] === "allow" &&
              reviewerPermission?.["websearch"] === "allow",
            detail: `author=${reviewerExternal?.[`${authorStateDir}/**`]} design=${reviewerExternal?.[`${designStateDir}/**`]} edit=${reviewerPermission?.["edit"]} bash=${reviewerPermission?.["bash"]} task=${reviewerPermission?.["task"]} webfetch=${reviewerPermission?.["webfetch"]} websearch=${reviewerPermission?.["websearch"]}`,
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
            name: "tech-lead prompt names the project design record",
            pass: techLeadPrompt !== undefined && techLeadPrompt.includes(`Design record: \`${designStateDir}/${projectId}\``),
            detail: techLeadPrompt?.includes(`${designStateDir}/${projectId}`)
              ? `design record for ${projectId}`
              : "tech-lead prompt MISSING design record binding",
          })

          for (const [name, dir] of [
            ["design", designStateDir],
            ["author", authorStateDir],
            ["ledger", join(ledgerStateDir, projectId)],
            ["simple workspace", liteWorkspace],
          ] as const) {
            assertions.push({
              name: `${name} directory created`,
              pass: existsSync(dir),
              detail: existsSync(dir) ? dir : `NOT FOUND: ${dir}`,
            })
          }
          assertions.push({
            name: "tech-lead prompt carries the plan.md checkpoint markers",
            pass: techLeadPrompt !== undefined && techLeadPrompt.includes("计划检查点") && techLeadPrompt.includes("checkpoint: continue") && techLeadPrompt.includes("checkpoint: blocked"),
            detail: techLeadPrompt?.includes("计划检查点") ? "计划检查点 + checkpoint states present" : "tech-lead prompt MISSING checkpoint markers",
          })
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
      if (adapterEntry.endsWith(join("dist", "index.js"))) {
        const bundleText = existsSync(adapterEntry) ? readFileSync(adapterEntry, "utf8") : ""
        const hasIdsArg = bundleText.includes("coder-reviewer requires reviews_job_ids")
        const hasStageArg = bundleText.includes('solution-reviewer with protocol code_plan_review requires stage: "plan"')
        assertions.push({
          name: "installed dispatch tool exposes the reviews_job_ids and stage guard surface",
          pass: hasIdsArg && hasStageArg,
          detail: `reviews_job_ids=${hasIdsArg} stage=${hasStageArg} (${adapterEntry})`,
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
      // Startup prune proof (D5): the retired probe (fingerprint-bearing, not
      // user-modified) was pruned; the user-modified and foreign probes
      // survived. The user-modified and foreign probes are then removed so
      // the enumeration assertions below see a clean final state.
      const retiredProbeSkillGone = !existsSync(join(sandboxSkillsDir, "retired-probe"))
      assertions.push({
        name: "startup prune removed the fingerprint-bearing non-user-modified probe skill",
        pass: retiredProbeSkillGone,
        detail: retiredProbeSkillGone ? "retired-probe pruned" : "retired-probe SURVIVED (prune missing)",
      })
      const userProbeSkillKept = existsSync(join(sandboxSkillsDir, "user-probe", "SKILL.md"))
      assertions.push({
        name: "startup prune kept the user-modified probe skill",
        pass: userProbeSkillKept,
        detail: userProbeSkillKept ? "user-probe survived" : "user-probe WRONGLY PRUNED",
      })
      const foreignSkillKept = existsSync(join(sandboxSkillsDir, "foreign-skill", "SKILL.md"))
      assertions.push({
        name: "startup prune kept the foreign probe skill",
        pass: foreignSkillKept,
        detail: foreignSkillKept ? "foreign-skill survived" : "foreign-skill WRONGLY PRUNED",
      })
      const retiredProbeCommandGone = !existsSync(join(sandboxCommandsDir, "janus-retired-probe.md"))
      assertions.push({
        name: "startup prune removed the fingerprint-bearing non-user-modified probe command",
        pass: retiredProbeCommandGone,
        detail: retiredProbeCommandGone ? "janus-retired-probe.md pruned" : "janus-retired-probe.md SURVIVED (prune missing)",
      })
      const userProbeCommandKept = existsSync(join(sandboxCommandsDir, "janus-user-probe.md"))
      assertions.push({
        name: "startup prune kept the user-modified probe command",
        pass: userProbeCommandKept,
        detail: userProbeCommandKept ? "janus-user-probe.md survived" : "janus-user-probe.md WRONGLY PRUNED",
      })
      const foreignCommandKept = existsSync(join(sandboxCommandsDir, "foreign-notes.md"))
      assertions.push({
        name: "startup prune kept the foreign command file",
        pass: foreignCommandKept,
        detail: foreignCommandKept ? "foreign-notes.md survived" : "foreign-notes.md WRONGLY PRUNED",
      })
      // Remove the surviving probes so the enumeration assertions below see
      // the state a fresh install produces.
      for (const probe of [
        join(sandboxSkillsDir, "user-probe"),
        join(sandboxSkillsDir, "foreign-skill"),
        join(sandboxCommandsDir, "janus-user-probe.md"),
        join(sandboxCommandsDir, "foreign-notes.md"),
      ]) {
        try {
          rmSync(probe, { recursive: true, force: true })
        } catch {
          // enumeration below will surface the leftover
        }
      }

      // Enumerate the installed skills and janus command files: exactly the
      // three current names each, by listing the directories (absence by
      // enumeration, not by naming retired artifacts).
      const installedSkills = readdirSync(sandboxSkillsDir).filter((name) =>
        existsSync(join(sandboxSkillsDir, name, "SKILL.md")),
      )
      const skillsExact =
        installedSkills.length === 3 &&
        ["consultation", "consultation-design", "consultation-doc"].every((name) => installedSkills.includes(name))
      assertions.push({
        name: "installed skill directories are exactly the three current skills",
        pass: skillsExact,
        detail: skillsExact ? installedSkills.sort().join(", ") : `unexpected skills: ${installedSkills.sort().join(", ")}`,
      })
      const installedJanusCommands = readdirSync(sandboxCommandsDir).filter((name) => /^janus-[a-z0-9-]+\.md$/.test(name))
      const commandsExact =
        installedJanusCommands.length === 3 &&
        ["janus-memory.md", "janus-models.md", "janus-config.md"].every((name) => installedJanusCommands.includes(name))
      assertions.push({
        name: "installed janus-*.md command files are exactly the three current commands",
        pass: commandsExact,
        detail: commandsExact
          ? installedJanusCommands.sort().join(", ")
          : `unexpected commands: ${installedJanusCommands.sort().join(", ")}`,
      })
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
