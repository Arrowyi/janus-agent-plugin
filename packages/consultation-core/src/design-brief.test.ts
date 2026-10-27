import { describe, expect, test } from "bun:test"

import { validateDecisionBrief } from "./decision-brief.ts"
import { ConsultationError } from "./errors.ts"

const designBrief = {
  mode: "design",
  conclusion: "Use a queue between the API and the worker.",
  confidence: "medium",
  stability: "conditional",
  verifiedFacts: ["The worker already retries idempotently."],
  synthesis: ["A queue isolates API latency from worker backlogs."],
  sources: [],
  nextAction: "Approve the queue decision and record the rejected shared-database option.",
  memoryDisclosure: [],
  goal: "Keep API latency stable while worker throughput varies.",
  nonGoals: ["Do not change the public API."],
  qualityScenarios: [
    {
      source: "Traffic spike",
      stimulus: "10x write burst",
      environment: "normal operation",
      artifact: "API",
      response: "requests keep succeeding",
      measure: "99% of writes under 200 ms",
    },
  ],
  options: [
    {
      option: "Queue between API and worker",
      tradeoffs: "Adds one hop and an operational component",
      recommended: true,
      reversal: "two-way",
      whatWouldChange: ["A hard requirement for synchronous completion"],
    },
    {
      option: "Shared database table",
      tradeoffs: "No new component, but couples throughput",
      recommended: false,
      reversal: "one-way",
      whatWouldChange: ["The worker moving to another store"],
    },
  ],
  levels: [
    {
      level: "module",
      summary: "API and worker communicate through one queue",
      decisions: ["Queue owns retry and ordering"],
    },
  ],
  recommendation: "Adopt the queue and keep the worker idempotent.",
  openQuestions: [
    { question: "Which queue technology?", trigger: "Before the first production deploy" },
  ],
  recordPath: "/home/user/.local/share/janus-agent/design/project-1234/queue/design.md",
  repoEvidence: [
    { path: "packages/api/src/server.ts", symbol: "handleWrite", note: "current synchronous path" },
  ],
}

function briefWith(override: Record<string, unknown>): unknown {
  return { ...designBrief, ...override }
}

describe("DesignBriefSchema", () => {
  test("accepts a repo-grounded brief with no external sources", () => {
    // given // when
    const brief = validateDecisionBrief(designBrief)

    // then
    expect(brief.mode).toBe("design")
    if (brief.mode !== "design") throw new Error("expected design mode")
    expect(brief.sources).toHaveLength(0)
    expect(brief.repoEvidence[0]?.symbol).toBe("handleWrite")
  })

  test("rejects a brief with neither external sources nor repo evidence", () => {
    expect(() =>
      validateDecisionBrief(briefWith({ sources: [], repoEvidence: [] })),
    ).toThrow(ConsultationError)
  })

  test("accepts a numeric quality-scenario measure such as 99%", () => {
    // given — the measure is a requirement, not a confidence claim
    const brief = validateDecisionBrief(
      briefWith({
        qualityScenarios: [
          {
            source: "Traffic spike",
            stimulus: "10x write burst",
            environment: "normal operation",
            artifact: "API",
            response: "requests keep succeeding",
            measure: "99% of writes under 200 ms",
          },
        ],
      }),
    )

    // then
    expect(brief.mode).toBe("design")
  })

  test("still rejects numeric confidence outside the quality measures", () => {
    expect(() => validateDecisionBrief(briefWith({ conclusion: "This works 90% of the time" }))).toThrow(
      ConsultationError,
    )
  })

  test("does not silently validate a design-shaped payload as research", () => {
    // given — research fields, no design fields
    const payload = {
      mode: "design",
      conclusion: "x",
      confidence: "high",
      stability: "stable",
      sources: [{ title: "s", grade: "high" }],
      nextAction: "y",
      keyPoints: ["a"],
      soWhat: "b",
    }

    // when // then
    expect(() => validateDecisionBrief(payload)).toThrow(ConsultationError)
  })

  test("requires at least two options and one quality scenario", () => {
    expect(() => validateDecisionBrief(briefWith({ options: [designBrief.options[0]] }))).toThrow()
    expect(() => validateDecisionBrief(briefWith({ qualityScenarios: [] }))).toThrow()
  })
})
