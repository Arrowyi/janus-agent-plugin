import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

import { GENERATED_MARKER, renderSkill, SKILL_OUTPUT_PATH } from "./gen-skill.ts"

describe("gen-skill", () => {
  test("assets/skills/consultation/SKILL.md is the current generated output", async () => {
    // given
    const rendered = await renderSkill()
    const committed = await readFile(SKILL_OUTPUT_PATH, "utf8")

    // when // then — edit skill-src/, run `bun run gen:skill`, and commit both
    expect(committed).toBe(rendered)
  })

  test("places the generated marker directly after the front matter", async () => {
    // given
    const rendered = await renderSkill()

    // when
    const frontMatterEnd = rendered.indexOf("\n---\n")

    // then — front matter first, then exactly one marker line, then the body
    expect(rendered.startsWith("---\n")).toBe(true)
    expect(frontMatterEnd).toBeGreaterThan(0)
    expect(rendered.slice(frontMatterEnd + 1, rendered.indexOf("\n", frontMatterEnd + 1))).toBe("---")
    expect(
      rendered.slice(rendered.indexOf("\n", frontMatterEnd + 1) + 1).startsWith(
        `${GENERATED_MARKER}\n\n# Consultation Skill`,
      ),
    ).toBe(true)
  })

  test("emits modules in the declared order", async () => {
    // given
    const rendered = await renderSkill()

    // when
    const positions = [
      "## Team Orchestration",
      "## Claim Decomposition",
      "## Risk Classification",
      "## Research Mode",
      "## Author Mode",
      "## Decision and Preference Handling",
      "### select: choose and try",
      "### verify: verdict first",
      "### plan: feasibility first",
      "### research: bottom line then meaning",
      "### guide: shortest path first",
      "### author: delivery brief",
      "## Memory: The Consultation Record",
    ].map((heading) => rendered.indexOf(heading))

    // then — every heading exists and appears after the previous one
    expect(positions.every((position) => position >= 0)).toBe(true)
    expect([...positions].sort((left, right) => left - right)).toEqual(positions)
  })
})
