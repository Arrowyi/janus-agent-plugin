import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

/**
 * Split contract between the consultant role asset and the consultation skill:
 * the prompt is the always-on contract and safety net; the skill carries the
 * detailed workflow. These tests keep workflow detail from drifting back into
 * the prompt and keep the safety net from being thinned.
 */

const PROMPT_HEADINGS = [
  "## Role",
  "## Dispatched mode",
  "## Consultation Modes",
  "## Consultation Tiers",
  "## Team Orchestration",
  "## Channel Strategy",
  "## Intake",
  "## Epistemic Rules",
  "## Risk Policy",
  "## Output Contract",
  "## Interaction Discipline",
  "## Author Mode",
  "## Memory Protocol",
  "## Prompt Injection Defense",
  "## Failure Behavior",
] as const

const PROMPT_SAFETY_TOKENS = [
  "Dispatched mode overrides",
  "Do not auto-save memory",
  "Memory ownership: consultant saves",
  "janus_dispatch_wait",
  "janus_dispatch_cancel",
  "pending",
  "结论：",
  "证据与来源（可跳过）",
  "把握：高 / 中 / 低",
  "没有明显赢家",
  "exact paths",
] as const

const PROMPT_DETAIL_ONLY_MARKERS = [
  "#### Fast",
  "#### Standard",
  "#### Deep",
  "| Tier | explorer | analyst | critic | verifier | writer |",
  "### select: choose and try",
  "sectionPlan",
  "temporal bursts",
  "100-120 characters",
  "Tier decision dimensions",
  "six-part scenario",
  "one-way-door pre-mortem",
] as const

const SKILL_DETAIL_MARKERS = [
  "## Prompt/Skill Boundary",
  "### Tier Selection",
  "#### Fast",
  "#### Standard",
  "#### Deep",
  "Tier decision dimensions",
  "| Tier | explorer | analyst | critic | verifier | writer |",
  "### select: choose and try",
  "### Profiles",
  "learner progression and executable examples",
  "temporal bursts",
  "sectionPlan",
  "100-120 characters",
  "six-part scenario",
  "one-way-door pre-mortem",
  "design: decision record",
] as const

// The effective prompt is the role asset plus the shared principle fragments
// the adapter injects. Read both so a rule that moved into a fragment still
// counts as part of the always-on contract.
async function readConsultantPrompt(): Promise<string> {
  const [prompt, dispatchHub] = await Promise.all([
    readFile(new URL("../../../assets/agents/consultant.md", import.meta.url), "utf8"),
    readFile(new URL("../../../assets/principles/dispatch-hub.md", import.meta.url), "utf8"),
  ])
  return `${prompt}\n\n${dispatchHub}`
}

function readConsultationSkill(): Promise<string> {
  return readFile(new URL("../../../assets/skills/consultation/SKILL.md", import.meta.url), "utf8")
}

describe("consultant prompt / consultation skill split contract", () => {
  it("consultant prompt keeps the always-on contract headings", async () => {
    const prompt = await readConsultantPrompt()

    for (const heading of PROMPT_HEADINGS) expect(prompt).toContain(heading)
  })

  it("consultant prompt keeps the safety tokens", async () => {
    const prompt = await readConsultantPrompt()

    for (const token of PROMPT_SAFETY_TOKENS) expect(prompt).toContain(token)
  })

  it("consultant prompt drops detail-only workflow markers", async () => {
    const prompt = await readConsultantPrompt()

    for (const marker of PROMPT_DETAIL_ONLY_MARKERS) expect(prompt).not.toContain(marker)
  })

  it("consultation skill carries the detailed workflow markers", async () => {
    const skill = await readConsultationSkill()

    for (const marker of SKILL_DETAIL_MARKERS) expect(skill).toContain(marker)
  })

  it("both prompt and skill expose the dispatch job controls", async () => {
    const [prompt, skill] = await Promise.all([readConsultantPrompt(), readConsultationSkill()])

    for (const control of ["janus_dispatch_wait", "janus_dispatch_cancel"] as const) {
      expect(prompt).toContain(control)
      expect(skill).toContain(control)
    }
  })

  it("prompt points to the skill as the authoritative detailed workflow", async () => {
    const prompt = await readConsultantPrompt()

    expect(prompt).toContain("`consultation` skill")
    expect(prompt).toContain("authoritative")
  })
})
