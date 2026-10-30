import { describe, expect, it } from "bun:test"
import { readFile } from "node:fs/promises"

/**
 * Split contract between the consultant role asset and the three consultation
 * skills: the prompt is the always-on contract and safety net; the core skill
 * carries the shared workflow, and the design/doc sub-skills carry the heavy
 * mode playbooks. These tests keep workflow detail from drifting back into the
 * prompt and keep each skill's own detail in place.
 */

const PROMPT_HEADINGS = [
  "## Role",
  "## Dispatched mode",
  "## Consultation Modes",
  "## Mode Stack",
  "## Consultation Tiers",
  "## Team Orchestration",
  "## Channel Strategy",
  "## Intake",
  "## Epistemic Rules",
  "## Risk Policy",
  "## Output Contract",
  "## Interaction Discipline",
  "## Doc Mode",
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
  "Mode Stack",
] as const

const PROMPT_DETAIL_ONLY_MARKERS = [
  "#### Fast",
  "#### Standard",
  "#### Deep",
  "| Tier | explorer | analyst | critic | arch-critic | auditor | writer |",
  "### select: choose and try",
  "sectionPlan",
  "temporal bursts",
  "100-120 characters",
  "Tier decision dimensions",
  "six-part scenario",
  "one-way-door pre-mortem",
] as const

const CORE_SKILL_MARKERS = [
  "## Prompt/Skill Boundary",
  "### Tier Selection",
  "#### Fast",
  "#### Standard",
  "#### Deep",
  "Tier decision dimensions",
  "| Tier | explorer | analyst | critic | arch-critic | auditor | writer |",
  "### select: choose and try",
  "### verify: verdict first",
  "### roadmap: feasibility first",
  "### research: bottom line then meaning",
  "### guide: shortest path first",
  "temporal bursts",
  "100-120 characters",
] as const

const DESIGN_SKILL_MARKERS = [
  "## Design Mode",
  "### Method",
  "### The design record",
  "### Anti-patterns (do not)",
  "one-way-door pre-mortem",
  "six-part scenario",
  "### Handoff to coder",
] as const

const DOC_SKILL_MARKERS = [
  "## Doc Mode",
  "### Profiles",
  "learner progression and executable examples",
  "sectionPlan",
  "### doc: delivery brief",
  "writer_session_id",
] as const

async function readConsultantPrompt(): Promise<string> {
  const [prompt, dispatchHub] = await Promise.all([
    readFile(new URL("../../../assets/agents/consultant.md", import.meta.url), "utf8"),
    readFile(new URL("../../../assets/principles/dispatch-hub.md", import.meta.url), "utf8"),
  ])
  return `${prompt}\n\n${dispatchHub}`
}

async function readSkill(name: "consultation" | "consultation-design" | "consultation-doc"): Promise<string> {
  return readFile(new URL(`../../../assets/skills/${name}/SKILL.md`, import.meta.url), "utf8")
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

  it("each skill carries its own detailed workflow markers", async () => {
    for (const marker of CORE_SKILL_MARKERS) expect(await readSkill("consultation")).toContain(marker)
    for (const marker of DESIGN_SKILL_MARKERS) {
      expect(await readSkill("consultation-design")).toContain(marker)
    }
    for (const marker of DOC_SKILL_MARKERS) expect(await readSkill("consultation-doc")).toContain(marker)
  })

  it("both prompt and core skill expose the dispatch job controls", async () => {
    const [prompt, skill] = await Promise.all([readConsultantPrompt(), readSkill("consultation")])

    for (const control of ["janus_dispatch_wait", "janus_dispatch_cancel"] as const) {
      expect(prompt).toContain(control)
      expect(skill).toContain(control)
    }
  })

  it("prompt points to the three skills as the authoritative detailed workflow", async () => {
    const prompt = await readConsultantPrompt()

    expect(prompt).toContain("`consultation` skill")
    expect(prompt).toContain("`consultation-design`")
    expect(prompt).toContain("`consultation-doc`")
    expect(prompt).toContain("authoritative")
  })
})
