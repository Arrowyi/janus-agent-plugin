import { describe, expect, test } from "bun:test"
import {
  AuthorClaimSchema,
  AuthorDeliverySchema,
  AuthorProfileSchema,
  AuthorReviewerReportSchema,
  AuthorSectionSchema,
  AuthorVerificationSchema,
} from "./author-contracts.ts"
import { AuthorReviewerReportSchema as ReExportedSchema } from "./index.ts"

describe("author contracts", () => {
  test("accepts every author control value", () => {
    expect(AuthorProfileSchema.options).toEqual(["tutorial", "architecture", "explanation"])
    expect(AuthorDeliverySchema.options).toEqual(["inline", "single_file", "multi_file"])
    expect(AuthorVerificationSchema.options).toEqual(["light", "targeted", "strict"])
  })

  test("accepts a complete section manifest entry", () => {
    const section = AuthorSectionSchema.parse({
      id: "structured-concurrency",
      title: "Structured concurrency",
      purpose: "Explain ownership and cancellation propagation.",
      file: "03-structured-concurrency.md",
      learningObjectives: ["Trace cancellation through a coroutine tree."],
      prerequisites: ["Suspension and continuations"],
      verificationTargets: ["Cancellation reaches child jobs."],
    })
    expect(section.file).toBe("03-structured-concurrency.md")
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
    const report = AuthorReviewerReportSchema.parse({ verdict: "revise", resolved: false })
    expect(report.factualAndSourceIssues).toEqual([])
    expect(report.briefAlignmentIssues).toEqual([])
    expect(report.readabilityAndJargonIssues).toEqual([])
    expect(report.flaws).toEqual([])
    expect(report.unresolvedGaps).toEqual([])
  })

  test("accepts a complete critical report and keeps every issue list", () => {
    const report = AuthorReviewerReportSchema.parse({
      verdict: "block",
      factualAndSourceIssues: ["Section 2 cites `dispatch-tool.ts:99` but the symbol lives at line 58."],
      briefAlignmentIssues: ["Chapter order diverges from the approved brief outline."],
      readabilityAndJargonIssues: ["`SSOT` first appears without a plain-language explanation."],
      flaws: ["The causality chain from D2 to the fragment budget is asserted, not sourced."],
      resolved: false,
      unresolvedGaps: ["The brief file was not supplied with the dispatch."],
    })
    expect(report.verdict).toBe("block")
    expect(report.resolved).toBe(false)
    expect(report.readabilityAndJargonIssues).toHaveLength(1)
  })

  test("rejects an unknown verdict and a missing resolved flag", () => {
    expect(() => AuthorReviewerReportSchema.parse({ verdict: "ship", resolved: true })).toThrow()
    expect(() => AuthorReviewerReportSchema.parse({ verdict: "pass" })).toThrow()
  })

  test("the schema is re-exported from the package index", () => {
    expect(ReExportedSchema).toBe(AuthorReviewerReportSchema)
  })
})
