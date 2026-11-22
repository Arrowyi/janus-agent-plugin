import { describe, expect, test } from "bun:test"
import {
  AuthorClaimSchema,
  AuthorDeliverySchema,
  AuthorFindingDispositionSchema,
  AuthorLevelSchema,
  AuthorProfileSchema,
  AuthorReviewerReportSchema,
  AuthorReviewRecordSchema,
  AuthorReviewStageSchema,
  AuthorSeatTierSchema,
  AuthorSectionSchema,
  AuthorVerificationSchema,
} from "./author-contracts.ts"
import { AuthorReviewerReportSchema as ReExportedSchema } from "./index.ts"

describe("author contracts", () => {
  test("accepts every author control value", () => {
    expect(AuthorProfileSchema.options).toEqual(["tutorial", "architecture", "explanation"])
    expect(AuthorDeliverySchema.options).toEqual(["inline", "single_file", "multi_file"])
    expect(AuthorVerificationSchema.options).toEqual(["light", "targeted", "strict"])
    expect(AuthorLevelSchema.options).toEqual(["D0", "D1", "D2", "D3"])
    expect(AuthorSeatTierSchema.options).toEqual(["fast", "standard"])
    expect(AuthorReviewStageSchema.options).toEqual(["outline", "unit", "reader", "final"])
  })

  test("accepts a complete section manifest entry", () => {
    const section = AuthorSectionSchema.parse({
      id: "structured-concurrency",
      title: "Structured concurrency",
      purpose: "Explain ownership and cancellation propagation.",
      file: "03-structured-concurrency.md",
      depthBudget: "One worked example and one failure case.",
      learningObjectives: ["Trace cancellation through a coroutine tree."],
      prerequisites: ["Suspension and continuations"],
      verificationTargets: ["Cancellation reaches child jobs."],
    })
    expect(section.file).toBe("03-structured-concurrency.md")
    expect(section.depthBudget).toBe("One worked example and one failure case.")
  })

  test("rejects an inferred claim without a basis", () => {
    expect(() =>
      AuthorClaimSchema.parse({
        claim: "Cancellation always reaches detached work.",
        sectionIds: ["structured-concurrency"],
        status: "inferred",
        verificationMethod: "Source inspection",
      }),
    ).toThrow()
  })

  test("accepts an inferred claim with a basis", () => {
    const claim = AuthorClaimSchema.parse({
      claim: "Cancellation propagates through the parent Job hierarchy.",
      sectionIds: ["structured-concurrency"],
      status: "inferred",
      basis: "Inferred from Job parent-child linkage in the inspected source.",
      verificationMethod: "Source inspection",
    })
    expect(claim.status).toBe("inferred")
  })
})

describe("author reviewer report", () => {
  test("accepts every verdict value and fills defaulted arrays", () => {
    expect(AuthorReviewerReportSchema.shape.verdict.options).toEqual(["pass", "revise", "block"])
    const report = AuthorReviewerReportSchema.parse({ stage: "unit", verdict: "revise", resolved: false })
    expect(report.factualAndSourceIssues).toEqual([])
    expect(report.briefAlignmentIssues).toEqual([])
    expect(report.readabilityAndJargonIssues).toEqual([])
    expect(report.flaws).toEqual([])
    expect(report.unresolvedGaps).toEqual([])
    expect(report.sourceChecks).toEqual([])
    expect(report.priorFindingsClosed).toEqual([])
  })

  test("accepts a complete critical report and keeps every issue list", () => {
    const report = AuthorReviewerReportSchema.parse({
      stage: "final",
      verdict: "block",
      factualAndSourceIssues: ["Section 2 cites `dispatch-tool.ts:99` but the symbol lives at line 58."],
      briefAlignmentIssues: ["Chapter order diverges from the approved brief outline."],
      readabilityAndJargonIssues: ["`SSOT` first appears without a plain-language explanation."],
      flaws: ["The causality chain from the cache to the latency drop is asserted, not sourced."],
      resolved: false,
      unresolvedGaps: ["The brief file was not supplied with the dispatch."],
      sourceChecks: [
        { claim: "The API returns a Flow.", source: "https://example.com/api", method: "webfetch", result: "contradicted" },
      ],
      priorFindingsClosed: [{ finding: "Missing expected output in step 3.", closed: true }],
    })
    expect(report.verdict).toBe("block")
    expect(report.resolved).toBe(false)
    expect(report.readabilityAndJargonIssues).toHaveLength(1)
    expect(report.sourceChecks[0]?.result).toBe("contradicted")
    expect(report.priorFindingsClosed[0]?.closed).toBe(true)
  })

  test("rejects an unknown verdict, a missing resolved flag, and a missing or unknown stage", () => {
    expect(() => AuthorReviewerReportSchema.parse({ stage: "final", verdict: "ship", resolved: true })).toThrow()
    expect(() => AuthorReviewerReportSchema.parse({ stage: "final", verdict: "pass" })).toThrow()
    expect(() => AuthorReviewerReportSchema.parse({ verdict: "pass", resolved: true })).toThrow()
    expect(() => AuthorReviewerReportSchema.parse({ stage: "plan", verdict: "pass", resolved: true })).toThrow()
  })

  test("the schema is re-exported from the package index", () => {
    expect(ReExportedSchema).toBe(AuthorReviewerReportSchema)
  })
})

describe("author review record", () => {
  test("requires a reason on a declined finding", () => {
    expect(() => AuthorFindingDispositionSchema.parse({ finding: "Tone is flat.", disposition: "declined" })).toThrow()
    const declined = AuthorFindingDispositionSchema.parse({
      finding: "Tone is flat.",
      disposition: "declined",
      reason: "The brief asks for a neutral reference voice.",
    })
    expect(declined.reason).toBeDefined()
  })

  test("caps the round at the first review plus two revise rounds", () => {
    const record = { stage: "unit", jobId: "job-1", tier: "fast", verdict: "revise" }
    expect(AuthorReviewRecordSchema.parse({ ...record, round: 3 }).round).toBe(3)
    expect(() => AuthorReviewRecordSchema.parse({ ...record, round: 4 })).toThrow()
    expect(() => AuthorReviewRecordSchema.parse({ ...record, round: 1, tier: "deep" })).toThrow()
  })
})
