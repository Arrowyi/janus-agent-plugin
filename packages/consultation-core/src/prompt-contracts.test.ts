import { describe, expect, it } from "bun:test"
import { readFile, readdir } from "node:fs/promises"

import { AuthorSectionSchema } from "./author-contracts.ts"
import { AnalysisDraftBaseSchema, CritiqueDraftSchema } from "./team.ts"

async function readAgentPrompt(file: string): Promise<string> {
  return readFile(new URL(`../../../assets/agents/${file}`, import.meta.url), "utf8")
}

function expectFields(prompt: string, fields: readonly string[]): void {
  for (const field of fields) expect(prompt).toContain(field)
}

const GRADED_SOURCE_FIELDS = [
  "id",
  "title",
  "isPrimary",
  "accountable",
  "methodTransparent",
  "independenceChainId",
  "hasCommercialOrIdeologicalConflict",
  "recent",
  "applicable",
  "grade",
  "accessedAt",
] as const

describe("agent prompt contracts", () => {
  it("explorer exposes the graded-source contract and search coverage", async () => {
    const prompt = await readAgentPrompt("explorer.md")

    expectFields(prompt, GRADED_SOURCE_FIELDS)
    expectFields(prompt, [
      "gradeBasis",
      "publishedAt",
      "publisher",
      "sourceType",
      "stance",
      "excerpt",
      "coverage",
      "queries",
      "channels",
      "blocked",
    ])
  })

  it("critic exposes the complete critique contract including loop control", async () => {
    const prompt = await readAgentPrompt("consultation-critic.md")

    expectFields(prompt, Object.keys(CritiqueDraftSchema.shape))
    expectFields(prompt, ["unresolvedGaps"])
  })

  it("analyst exposes the complete analysis contract", async () => {
    const prompt = await readAgentPrompt("analyst.md")

    expectFields(prompt, Object.keys(AnalysisDraftBaseSchema.shape))
    expectFields(prompt, ["verified", "refuted", "inferred", "unverifiable"])
  })

  it("writer exposes the author-section contract in its blueprint", async () => {
    const prompt = await readAgentPrompt("writer.md")

    expectFields(prompt, Object.keys(AuthorSectionSchema.shape))
    expectFields(prompt, ["sectionPlan", "continuityMap", "teachingBeats"])
  })

  it("consultant states dispatched-mode precedence and memory ownership", async () => {
    const prompt = await readAgentPrompt("consultant.md")

    expect(prompt).toContain("Dispatched mode overrides")
    expect(prompt).toContain("Memory ownership")
  })

  it("janus hands consultation memory to the consultant and preserves its reply format", async () => {
    const prompt = await readAgentPrompt("janus.md")

    expect(prompt).toContain("Memory ownership: consultant saves")
    expect(prompt).toContain("Consultant relay format")
    expect(prompt).toContain("结论：")
    expect(prompt).toContain("下一步：")
    expect(prompt).toContain("Do not rewrite it into Janus's short style")
  })

  it("shared common principles asset carries the persistent file-change confirmation gate", async () => {
    const common = await readFile(
      new URL("../../../assets/principles/common.md", import.meta.url),
      "utf8",
    )

    expect(common).toContain("## Common Operating Principles")
    expect(common).toContain("### File Change Confirmation")
    expect(common).toContain("persistent file change")
    expect(common).toContain(
      "In dispatched mode, do not ask the end user: return the proposed file list and reasons to the dispatcher and stop",
    )
    expect(common).toContain("After a round that changed files")
    expect(common).toContain("exact paths actually changed")
  })

  it("no agent asset duplicates the shared file-change confirmation section", async () => {
    const agentDir = new URL("../../../assets/agents/", import.meta.url)
    const files = (await readdir(agentDir)).filter((file) => file.endsWith(".md")).sort()

    expect(files.length).toBe(10)
    for (const file of files) {
      const prompt = await readFile(new URL(file, agentDir), "utf8")
      if (prompt.includes("## File Change Confirmation")) {
        throw new Error(`${file} duplicates the shared File Change Confirmation section`)
      }
    }
  })

  it("skill keeps the dispatched context and structured handoffs", async () => {
    const skill = await readFile(
      new URL("../../../assets/skills/consultation/SKILL.md", import.meta.url),
      "utf8",
    )

    expect(skill).toContain("Dispatched bounded task")
    expect(skill).toContain("Memory ownership")
    expect(skill).toContain("resolved")
    expect(skill).toContain("sectionPlan")
    expect(skill).toContain("Persistent file changes")
    expect(skill).toContain("exact paths")
    expect(skill).toContain("exact paths actually changed")
  })

  it("consultant prompt states the terminal-first double anchor", async () => {
    const prompt = await readAgentPrompt("consultant.md")

    for (const text of [
      "结论：",
      "下一步：",
      "证据与来源（可跳过）",
      "把握：高 / 中 / 低",
      "没有明显赢家",
    ]) {
      expect(prompt).toContain(text)
    }
  })

  it("skill defines the terminal readability rules and six mode templates", async () => {
    const skill = await readFile(
      new URL("../../../assets/skills/consultation/SKILL.md", import.meta.url),
      "utf8",
    )

    for (const text of [
      "Output Readability (Terminal-First)",
      "Double anchor",
      "Short vs full",
      "select: choose and try",
      "verify: verdict first",
      "plan: feasibility first",
      "research: bottom line then meaning",
      "guide: shortest path first",
      "author: delivery brief",
      "证据与来源（可跳过）",
      "没有明显赢家",
      "100-120 characters",
    ]) {
      expect(skill).toContain(text)
    }
  })
})
