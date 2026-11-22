import { describe, expect, it } from "bun:test"

import { annotateAuthorReviewerReturn, hasAuthorReviewerReport, UNRESOLVED_REPORT_NOTE } from "./dispatch-review-report.ts"

const report = {
  stage: "final",
  verdict: "revise",
  factualAndSourceIssues: ["the path src/a.ts does not exist"],
  resolved: false,
}

function completedEnvelope(text: string): string {
  return JSON.stringify({
    v: 1,
    status: "completed",
    job_id: "ses_job",
    role: "author-reviewer",
    attempt: { index: 0, model: "opencode-go/kimi-k3.1-pro" },
    session_id: "ses_child",
    waited_ms: 10,
    text,
  })
}

describe("author-reviewer report soft check", () => {
  it("accepts a fenced or bare report that matches the contract", () => {
    expect(hasAuthorReviewerReport("Summary first.\n```json\n" + JSON.stringify(report) + "\n```")).toBe(true)
    expect(hasAuthorReviewerReport(`Report: ${JSON.stringify(report)}`)).toBe(true)
  })

  it("rejects prose, malformed JSON, and a report missing its stage", () => {
    expect(hasAuthorReviewerReport("Looks good to me.")).toBe(false)
    expect(hasAuthorReviewerReport("```json\n{ verdict: pass }\n```")).toBe(false)
    const { stage: _stage, ...stageless } = report
    expect(hasAuthorReviewerReport(JSON.stringify(stageless))).toBe(false)
  })

  it("appends the unresolved note to plain text and leaves a valid report untouched", () => {
    expect(annotateAuthorReviewerReturn("Looks good.")).toBe(`Looks good.\n${UNRESOLVED_REPORT_NOTE}`)
    const valid = JSON.stringify(report)
    expect(annotateAuthorReviewerReturn(valid)).toBe(valid)
    expect(annotateAuthorReviewerReturn("Error: author-reviewer is disabled by configuration")).toBe(
      "Error: author-reviewer is disabled by configuration",
    )
  })

  it("marks a completed envelope with report_check instead of appending text", () => {
    const marked = JSON.parse(annotateAuthorReviewerReturn(completedEnvelope("no report here")))
    expect(marked.report_check).toBe("unresolved")
    const clean = completedEnvelope(JSON.stringify(report))
    expect(annotateAuthorReviewerReturn(clean)).toBe(clean)
  })
})
