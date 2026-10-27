import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import {
  registerAnalyst,
  registerCoder,
  registerCoderLite,
  registerConsultantAgent,
  registerConsultationCritic,
  registerExplorer,
  registerJanus,
  registerLite,
  registerVerifier,
  registerWriter,
} from "./agent-registration.ts"
import type { JanusPluginConfig } from "./plugin-config.ts"

/**
 * Golden-file snapshots of every fully assembled role prompt.
 *
 * Assembly depends on the model-adaptation library, the common-principles
 * block, fragments, runtime bindings, and the project directory; each of those
 * is pinned here so a prompt change produces a readable Markdown diff instead
 * of an opaque inline snapshot. Refresh intentionally with:
 *
 *   UPDATE_PROMPTS=1 bun test packages/opencode-adapter/src/prompt-snapshots.test.ts
 *
 * then review every changed line against the design record before committing.
 */
const SNAPSHOT_DIR = new URL("./prompt-snapshots/", import.meta.url)
const SNAPSHOT_DIR_PATH = fileURLToPath(SNAPSHOT_DIR)

// Fixed paths keep the injected author/design/lite bindings byte-stable across
// machines. They are scratch locations under /tmp, never repo state.
const SNAPSHOT_HOME = "/tmp/janus-snapshot/home"
const SNAPSHOT_DATA_HOME = "/tmp/janus-snapshot/data"
const SNAPSHOT_LITE_WORKSPACE = `${SNAPSHOT_DATA_HOME}/janus-agent/lite`
const SNAPSHOT_PROJECT_DIR = "/tmp/janus-snapshot/project"
const SNAPSHOT_NAMESPACE = "oc-snapshot"

const SNAPSHOT_ENV: NodeJS.ProcessEnv = {
  HOME: SNAPSHOT_HOME,
  XDG_DATA_HOME: SNAPSHOT_DATA_HOME,
}

/** Role registration order and the agent key each binding block reports. */
const ROLE_TARGETS = [
  { golden: "consultant", agent: "consultant" },
  { golden: "coder", agent: "coder" },
  { golden: "lite", agent: "lite" },
  { golden: "coder-lite", agent: "coder-lite" },
  { golden: "janus", agent: "janus" },
  { golden: "explorer", agent: "consultation-explorer" },
  { golden: "analyst", agent: "consultation-analyst" },
  { golden: "critic", agent: "consultation-critic" },
  { golden: "verifier", agent: "consultation-verifier" },
  { golden: "writer", agent: "consultation-writer" },
] as const

function makeConfig(): JanusPluginConfig {
  return {
    install_skill: true,
    install_commands: true,
    memory_enabled: true,
    critic_agent: "consultation-critic",
    critic_enabled: true,
    explorer_agent: "consultation-explorer",
    analyst_agent: "consultation-analyst",
    verifier_agent: "consultation-verifier",
    verifier_enabled: true,
    writer_agent: "consultation-writer",
    writer_enabled: true,
    writer_docs_roots: ["userdoc"],
    coder_agent: "coder",
    coder_enabled: true,
    lite_agent: "lite",
    lite_enabled: true,
    lite_workspace_dir: SNAPSHOT_LITE_WORKSPACE,
    coder_lite_agent: "coder-lite",
    coder_lite_enabled: true,
    build_agent: "build",
    build_enabled: true,
    janus_agent: "janus",
    janus_enabled: true,
  }
}

async function assembleAll(): Promise<Map<string, string>> {
  const config: { agent?: Record<string, unknown> } = {}
  const pluginConfig = makeConfig()

  await registerConsultantAgent(
    config,
    pluginConfig,
    SNAPSHOT_NAMESPACE,
    SNAPSHOT_PROJECT_DIR,
    SNAPSHOT_ENV,
  )
  await registerCoder(config, pluginConfig, SNAPSHOT_PROJECT_DIR, SNAPSHOT_ENV)
  await registerLite(config, pluginConfig, SNAPSHOT_NAMESPACE)
  await registerCoderLite(config, pluginConfig)
  await registerJanus(config, pluginConfig)
  await registerExplorer(config, pluginConfig)
  await registerAnalyst(config, pluginConfig)
  await registerConsultationCritic(config, pluginConfig)
  await registerVerifier(config, pluginConfig)
  await registerWriter(config, pluginConfig, SNAPSHOT_ENV, SNAPSHOT_PROJECT_DIR)

  const prompts = new Map<string, string>()
  for (const target of ROLE_TARGETS) {
    const entry = config.agent?.[target.agent] as { prompt?: unknown } | undefined
    if (entry === undefined || typeof entry.prompt !== "string") {
      throw new Error(`agent ${target.agent} was not registered with a prompt`)
    }
    prompts.set(target.golden, entry.prompt)
  }
  return prompts
}

function firstDifference(expected: string, actual: string): string {
  const expectedLines = expected.split("\n")
  const actualLines = actual.split("\n")
  const length = Math.max(expectedLines.length, actualLines.length)
  for (let index = 0; index < length; index += 1) {
    if (expectedLines[index] !== actualLines[index]) {
      return `first difference at line ${index + 1}\n  golden: ${JSON.stringify(expectedLines[index])}\n  actual: ${JSON.stringify(actualLines[index])}`
    }
  }
  return "no line-level difference (trailing newline mismatch)"
}

const update = process.env.UPDATE_PROMPTS === "1"
let assembled: Map<string, string>

describe("assembled role prompt snapshots", () => {
  beforeAll(async () => {
    mkdirSync(SNAPSHOT_DIR_PATH, { recursive: true })
    assembled = await assembleAll()
  })

  afterAll(() => {
    rmSync("/tmp/janus-snapshot", { recursive: true, force: true })
  })

  it("assembles every role deterministically", async () => {
    // given — assembly reads the asset tree, the model library, and the config
    // when — a second assembly runs in the same process
    const second = await assembleAll()

    // then — order and bytes are stable
    expect([...second.keys()]).toEqual([...assembled.keys()])
    for (const [golden, prompt] of assembled) {
      expect(second.get(golden)).toBe(prompt)
    }
  })

  for (const target of ROLE_TARGETS) {
    it(`matches the ${target.golden} golden prompt`, async () => {
      // given
      const prompt = assembled.get(target.golden)
      if (prompt === undefined) throw new Error(`no assembled prompt for ${target.golden}`)
      const goldenPath = fileURLToPath(new URL(`${target.golden}.md`, SNAPSHOT_DIR))

      // when
      if (update) {
        await writeFile(goldenPath, prompt, "utf8")
        return
      }
      let golden: string
      try {
        golden = await readFile(goldenPath, "utf8")
      } catch {
        throw new Error(
          `missing golden ${goldenPath}; generate it with UPDATE_PROMPTS=1 bun test packages/opencode-adapter/src/prompt-snapshots.test.ts`,
        )
      }

      // then — the assembled prompt must match the reviewed golden exactly
      if (prompt !== golden) {
        throw new Error(
          `${target.golden} prompt differs from ${goldenPath}: ${firstDifference(golden, prompt)}`,
        )
      }
      expect(prompt).toBe(golden)
    })
  }
})
