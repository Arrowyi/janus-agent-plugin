import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { readdirSync, statSync } from "node:fs"
import { join } from "node:path"

/**
 * Lightweight prompt lint (DR8):
 *  - per-layer word budgets, so a prompt cannot silently absorb workflow detail;
 *  - cross-file duplicate sentences, so the same rule is stated once except for
 *    a small allowlist of intentionally mirrored safety/style lines.
 *
 * Generated `assets/skills/consultation/SKILL.md` is checked via its modules;
 * the generated file itself is covered by script/gen-skill.test.ts.
 */
const REPO_ROOT = join(import.meta.dir, "..")
const ASSETS = join(REPO_ROOT, "assets")

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name)
    return statSync(path).isDirectory() ? walk(path) : [path]
  })
}

function words(text: string): number {
  return text.split(/\s+/).filter(Boolean).length
}

const DEFAULT_AGENT_BUDGET = 1500

const AGENT_BUDGETS: Record<string, number> = {
  "consultant.md": 3200,
  "coder.md": 2400,
}

const FRAGMENT_BUDGET = 500
const SKILL_MODULE_BUDGET = 2000
// Per-skill generated-body budgets, measured including front matter. The core
// drops from the former 9,960-word monolith to <=5,800 by moving the heavy
// design/doc playbooks into their own on-demand skills.
const SKILL_TOTAL_BUDGETS: Record<string, number> = {
  consultation: 5800,
  "consultation-design": 1300,
  "consultation-doc": 3000,
}

/**
 * Sentences intentionally mirrored across role prompts. Each entry names why
 * the duplication is deliberate rather than a rule that should live in one place.
 */
const INTENTIONAL_DUPLICATES = [
  // House interaction style repeated in every user-facing entry prompt.
  "No emoji unless the user used one first.",
  "A simple one-shot answer needs no block; its last sentence is the action.",
  // Memory-handling rule mirrored in ask-lite's own prompt and the skill's memory policy.
  "Sensitive fields are excluded and persist only after itemized confirmation.",
  // Writer has its own bounded-task rule; the research leaf shares the wording.
  "Being observed while still working (`pending` / `unknown`) is not a failure; progress is not your final report.",
  // Channel-policy safety lines deliberately mirrored in the consultant prompt and the skill.
  "Never ask for passwords, session cookies, or API keys; the user performs the login or purchase.",
  "Leaked or pirated material may be collected and used when it is the best available route; flag that channel and its risk, grade it `lead_only`/`suspect`, and corroborate it before treating it as proof, but never present it as the sole source.",
  // The auditor prompt and the skill's intent-audit section both warn about this zone.
  "Leaked documents and pirated content are a high-fabrication zone.",
] as const

function sentences(text: string): string[] {
  const body = text
    .replace(/<!--[\s\S]*?-->/g, "")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("#"))
    .join("\n")
    .replace(/\s+/g, " ")
  return body
    .split(/(?<=[.!?])\s+/)
    .map((sentence) => sentence.trim().replace(/^-\s*/, ""))
    .filter((sentence) => sentence.split(" ").length >= 8)
}

async function readText(path: string): Promise<string> {
  return readFile(path, "utf8")
}

describe("prompt word budgets", () => {
  test("agent role assets stay within their layer budget", async () => {
    const files = readdirSync(join(ASSETS, "agents")).filter((file) => file.endsWith(".md"))

    for (const file of files) {
      const budget = AGENT_BUDGETS[file] ?? DEFAULT_AGENT_BUDGET
      const count = words(await readText(join(ASSETS, "agents", file)))
      if (count > budget) {
        throw new Error(`assets/agents/${file} has ${count} words, over its ${budget}-word budget`)
      }
      expect(count).toBeLessThanOrEqual(budget)
    }
  })

  test("shared principle fragments stay within the fragment budget", async () => {
    for (const file of [
      "research-leaf.md",
      "dispatch-hub.md",
      "reasoning-failures.md",
      "mode-routing.md",
      "claim-types.md",
      "source-criteria.md",
      "channel-policy.md",
      "engineering-principles.md",
    ]) {
      const count = words(await readText(join(ASSETS, "principles", file)))
      if (count > FRAGMENT_BUDGET) {
        throw new Error(`assets/principles/${file} has ${count} words, over ${FRAGMENT_BUDGET}`)
      }
      expect(count).toBeLessThanOrEqual(FRAGMENT_BUDGET)
    }
  })

  test("each skill module and every generated skill stay within budget", async () => {
    for (const [skillName, budget] of Object.entries(SKILL_TOTAL_BUDGETS)) {
      const srcDir = join(REPO_ROOT, "skill-src", skillName)
      const modules = walk(srcDir).filter((file) => file.endsWith(".md"))
      let total = 0

      for (const module of modules) {
        const count = words(await readText(module))
        total += count
        if (count > SKILL_MODULE_BUDGET) {
          throw new Error(
            `${module.replace(`${REPO_ROOT}/`, "")} has ${count} words, over ${SKILL_MODULE_BUDGET}`,
          )
        }
        expect(count).toBeLessThanOrEqual(SKILL_MODULE_BUDGET)
      }

      const generated = await readText(join(ASSETS, "skills", skillName, "SKILL.md"))
      const body = generated
        .split("\n")
        .filter((line) => !line.startsWith("<!-- generated by script/gen-skill.ts"))
        .join("\n")
      if (words(body) > budget) {
        throw new Error(`${skillName}/SKILL.md has ${words(body)} words, over its ${budget}-word budget`)
      }
      expect(words(body)).toBeLessThanOrEqual(budget)
      expect(total).toBeGreaterThan(0)
    }
  })
})

describe("cross-file duplicate sentences", () => {
  test("the mode-routing card lives only in the shared fragment", async () => {
    const cardLine = "Route by **ask**, not by sentence"
    const fragment = await readText(join(ASSETS, "principles", "mode-routing.md"))
    expect(fragment).toContain(cardLine)
    for (const file of ["janus.md", "consultant.md"]) {
      expect(await readText(join(ASSETS, "agents", file))).not.toContain(cardLine)
    }
  })

  test("the claim-type table lives only in the shared fragment", async () => {
    const header = "| Claim type | Verification method |"
    const fragment = await readText(join(ASSETS, "principles", "claim-types.md"))
    expect(fragment).toContain(header)
    for (const path of [
      join(ASSETS, "agents", "analyst.md"),
      join(REPO_ROOT, "skill-src/consultation/policies/evidence-and-sources.md"),
    ]) {
      expect(await readText(path)).not.toContain(header)
    }
    const skill = await readText(join(ASSETS, "skills/consultation/SKILL.md"))
    expect(skill.split(header).length - 1).toBe(1)
  })

  test("only allowlisted sentences repeat across prompts and skill modules", async () => {
    const files = [
      ...walk(join(ASSETS, "agents")),
      ...walk(join(ASSETS, "principles")).filter(
        (file) => !file.endsWith("common-base.md") && !file.endsWith("common-write.md"),
      ),
      ...walk(join(REPO_ROOT, "skill-src")),
    ].filter((file) => file.endsWith(".md"))

    const seen = new Map<string, Set<string>>()
    for (const file of files) {
      for (const sentence of sentences(await readText(file))) {
        const owners = seen.get(sentence) ?? new Set<string>()
        owners.add(file.replace(`${REPO_ROOT}/`, ""))
        seen.set(sentence, owners)
      }
    }

    const allowlist = new Set<string>(INTENTIONAL_DUPLICATES)
    const unexpected: string[] = []
    for (const [sentence, owners] of seen) {
      if (owners.size > 1 && !allowlist.has(sentence)) {
        unexpected.push(`${[...owners].join(" | ")}\n    ${sentence}`)
      }
    }
    if (unexpected.length > 0) {
      throw new Error(`unexpected duplicated sentences:\n  ${unexpected.join("\n  ")}`)
    }
    expect(unexpected).toEqual([])
  })

  test("every allowlisted duplicate is still present in at least two files", async () => {
    const files = [
      ...walk(join(ASSETS, "agents")),
      ...walk(join(ASSETS, "principles")).filter(
        (file) => !file.endsWith("common-base.md") && !file.endsWith("common-write.md"),
      ),
      ...walk(join(REPO_ROOT, "skill-src")),
    ].filter((file) => file.endsWith(".md"))
    const counts = new Map<string, number>()

    for (const file of files) {
      for (const sentence of new Set(sentences(await readText(file)))) {
        counts.set(sentence, (counts.get(sentence) ?? 0) + 1)
      }
    }

    const stale = INTENTIONAL_DUPLICATES.filter((sentence) => (counts.get(sentence) ?? 0) < 2)
    expect(stale).toEqual([])
  })
})
