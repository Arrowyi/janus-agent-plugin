import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"

import {
  SKILLS,
  generatedMarker,
  injectMarkers,
  renderSkill,
  SKILL_FRAGMENTS,
} from "./gen-skill.ts"

describe("gen-skill", () => {
  test("every generated skill is the current rendered output", async () => {
    for (const skill of SKILLS) {
      const rendered = await renderSkill(skill)
      const committed = await readFile(skill.outputPath, "utf8")
      expect(committed).toBe(rendered)
    }
  })

  test("places the generated marker directly after the front matter", async () => {
    for (const skill of SKILLS) {
      const rendered = await renderSkill(skill)
      const frontMatterEnd = rendered.indexOf("\n---\n")
      expect(rendered.startsWith("---\n")).toBe(true)
      expect(frontMatterEnd).toBeGreaterThan(0)
      expect(
        rendered
          .slice(rendered.indexOf("\n", frontMatterEnd + 1) + 1)
          .startsWith(`${generatedMarker(skill.name)}\n`),
      ).toBe(true)
    }
  })

  test("renders every shared fragment once and leaves no marker", async () => {
    for (const skill of SKILLS) {
      const rendered = await renderSkill(skill)
      for (const fragment of skill.fragments) {
        const text = (await readFile(fragment.assetPath, "utf8")).trim()
        expect(rendered).toContain(text)
        expect(rendered.split(text).length - 1).toBe(1)
        expect(rendered).not.toContain(fragment.marker)
      }
    }
  })

  test("fails loudly when a fragment marker is missing or repeated", async () => {
    const body = "## Two-Axis Routing\n\nno marker here"
    for (const fragment of SKILL_FRAGMENTS) {
      await expect(injectMarkers(body, [fragment])).rejects.toThrow(fragment.marker)
      await expect(injectMarkers(`${fragment.marker}\n${fragment.marker}`, [fragment])).rejects.toThrow(
        "repeats",
      )
    }
  })

  test("fails loudly when a fragment asset is missing or unreadable", async () => {
    const fragment = { name: "missing", marker: "<!-- MISSING -->", assetPath: "/tmp/janus-missing-fragment.md" }
    await expect(injectMarkers(fragment.marker, [fragment])).rejects.toThrow("<!-- MISSING -->")
  })

  test("emits the core modules in the declared order", async () => {
    const rendered = await renderSkill()
    const positions = [
      "## Team Orchestration",
      "## Claim Decomposition",
      "## Risk Classification",
      "## Research Mode",
      "## Decision and Preference Handling",
      "### select: choose and try",
      "### verify: verdict first",
      "### roadmap: feasibility first",
      "### research: bottom line then meaning",
      "### guide: shortest path first",
      "## Memory: The Consultation Record",
    ].map((heading) => rendered.indexOf(heading))

    expect(positions.every((position) => position >= 0)).toBe(true)
    expect([...positions].sort((left, right) => left - right)).toEqual(positions)
  })

  test("emits the design and doc playbooks under their own names", async () => {
    const design = await renderSkill(SKILLS[1])
    const doc = await renderSkill(SKILLS[2])
    expect(design).toContain("## Design Mode")
    expect(design).toContain("### design: decision record")
    expect(design).not.toContain("## Doc Mode")
    expect(doc).toContain("## Doc Mode")
    expect(doc).toContain("### doc: delivery brief")
    expect(doc).not.toContain("## Design Mode")
  })
})
