import { afterAll, beforeAll, describe, expect, it } from "bun:test"
import { mkdirSync, rmSync } from "node:fs"
import { readFile, writeFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"

import {
  registerArchitect,
  registerAuthor,
  registerAuthorWriter,
  registerCoder,
  registerCoderLite,
  registerCoderReviewer,
  registerCommonExplorer,
  registerConsultantAgent,
  registerConsultantAnalyst,
  registerConsultantAuditor,
  registerConsultantCritic,
  registerJanus,
  registerSimple,
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

// Fixed paths keep the injected author/design/simple bindings byte-stable across
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
  { golden: "janus", agent: "janus" },
  { golden: "simple", agent: "simple" },
  { golden: "consultant", agent: "consultant" },
  { golden: "architect", agent: "architect" },
  { golden: "coder", agent: "coder" },
  { golden: "author", agent: "author" },
  { golden: "common-explorer", agent: "common-explorer" },
  { golden: "consultant-analyst", agent: "consultant-analyst" },
  { golden: "consultant-critic", agent: "consultant-critic" },
  { golden: "consultant-auditor", agent: "consultant-auditor" },
  { golden: "coder-reviewer", agent: "coder-reviewer" },
  { golden: "author-writer", agent: "author-writer" },
  { golden: "coder-lite", agent: "coder-lite" },
] as const

function makeConfig(): JanusPluginConfig {
  return {
    install_skill: true,
    install_commands: true,
    memory_enabled: true,
    janus_agent: "janus",
    janus_enabled: true,
    simple_agent: "simple",
    simple_enabled: true,
    simple_workspace_dir: SNAPSHOT_LITE_WORKSPACE,
    consultant_agent: "consultant",
    architect_agent: "architect",
    architect_enabled: true,
    coder_agent: "coder",
    coder_enabled: true,
    author_agent: "author",
    author_enabled: true,
    common_explorer_agent: "common-explorer",
    common_explorer_enabled: true,
    consultant_analyst_agent: "consultant-analyst",
    consultant_analyst_enabled: true,
    consultant_critic_agent: "consultant-critic",
    consultant_critic_enabled: true,
    consultant_auditor_agent: "consultant-auditor",
    consultant_auditor_enabled: true,
    coder_reviewer_agent: "coder-reviewer",
    coder_reviewer_enabled: true,
    author_writer_agent: "author-writer",
    author_writer_enabled: true,
    writer_docs_roots: ["userdoc"],
    coder_lite_agent: "coder-lite",
    coder_lite_enabled: true,
  }
}

async function assembleAll(): Promise<Map<string, string>> {
  const config: { agent?: Record<string, unknown> } = {}
  const pluginConfig = makeConfig()

  await registerConsultantAgent(config, pluginConfig, SNAPSHOT_NAMESPACE, SNAPSHOT_PROJECT_DIR, SNAPSHOT_ENV)
  await registerArchitect(config, pluginConfig, SNAPSHOT_NAMESPACE, SNAPSHOT_PROJECT_DIR, SNAPSHOT_ENV)
  await registerAuthor(config, pluginConfig, SNAPSHOT_NAMESPACE, SNAPSHOT_PROJECT_DIR, SNAPSHOT_ENV)
  await registerCoder(config, pluginConfig, SNAPSHOT_PROJECT_DIR, SNAPSHOT_ENV)
  await registerSimple(config, pluginConfig, SNAPSHOT_NAMESPACE)
  await registerCoderLite(config, pluginConfig)
  await registerJanus(config, pluginConfig, SNAPSHOT_PROJECT_DIR, SNAPSHOT_ENV)
  await registerCommonExplorer(config, pluginConfig)
  await registerConsultantAnalyst(config, pluginConfig)
  await registerConsultantCritic(config, pluginConfig)
  await registerCoderReviewer(config, pluginConfig)
  await registerConsultantAuditor(config, pluginConfig)
  await registerAuthorWriter(config, pluginConfig, SNAPSHOT_ENV, SNAPSHOT_PROJECT_DIR)

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
