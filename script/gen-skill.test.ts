import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"

import {
  GENERATED_MARKER,
  injectMarkers,
  renderSkill,
  SKILL_FRAGMENTS,
  SKILL_OUTPUT_PATH,
} from "./gen-skill.ts"

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

  test("renders every shared fragment once and leaves no marker", async () => {
    // given
    const rendered = await renderSkill()

    // when // then — each fragment is inserted from its single source
    for (const fragment of SKILL_FRAGMENTS) {
      const text = (await readFile(fragment.assetPath, "utf8")).trim()
      expect(rendered).toContain(text)
      expect(rendered.split(text).length - 1).toBe(1)
      expect(rendered).not.toContain(fragment.marker)
    }
  })

  test("fails loudly when a fragment marker is missing or repeated", async () => {
    // given
    const body = "## Two-Axis Routing\n\nno marker here"

    // when // then — every fragment enforces its own marker
    for (const fragment of SKILL_FRAGMENTS) {
      await expect(injectMarkers(body, [fragment])).rejects.toThrow(fragment.marker)
      await expect(
        injectMarkers(`${fragment.marker}\n${fragment.marker}`, [fragment]),
      ).rejects.toThrow("repeats")
    }
  })

  test("fails loudly when a fragment asset is missing or empty", async () => {
    // given
    const fragment = { name: "missing", marker: "<!-- MISSING -->", assetPath: join(SKILL_FRAGMENTS[0]!.assetPath, "nope.md") }

    // when // then
    await expect(injectMarkers(fragment.marker, [fragment])).rejects.toThrow("<!-- MISSING -->")
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
