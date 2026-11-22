import { AuthorReviewerReportSchema } from "@janus-agent/consultation-core"

import { parseOutcomeEnvelope } from "./dispatch-contract.ts"

/**
 * Soft check of an author-reviewer completion: the reply should carry one
 * structured review report (a JSON object, optionally inside a ```json
 * fence) that parses as `AuthorReviewerReportSchema`. The check never blocks
 * or rewrites the reply; an unparseable report only marks the return so the
 * author treats the review as unresolved instead of crediting it.
 */
export const UNRESOLVED_REPORT_NOTE =
  "[author-reviewer report: unresolved — the reply carries no report matching the author-reviewer report contract; ask the reviewer to resend it before crediting the review]"

function reportCandidates(text: string): string[] {
  const fenced = [...text.matchAll(/```(?:json)?\s*\n([\s\S]*?)```/g)].map((match) => match[1] ?? "")
  const first = text.indexOf("{")
  const last = text.lastIndexOf("}")
  const bare = first >= 0 && last > first ? [text.slice(first, last + 1)] : []
  return [...fenced.reverse(), ...bare]
}

export function hasAuthorReviewerReport(text: string): boolean {
  for (const candidate of reportCandidates(text)) {
    try {
      if (AuthorReviewerReportSchema.safeParse(JSON.parse(candidate)).success) return true
    } catch {
      continue
    }
  }
  return false
}

/**
 * Annotate a completed author-reviewer return from `janus_dispatch` or
 * `janus_dispatch_continue`. Plain-text success gets the note appended; a
 * completed envelope gets `report_check: "unresolved"`. `Error:` text and
 * non-completed envelopes pass through unchanged.
 */
export function annotateAuthorReviewerReturn(output: string): string {
  const parsed = parseOutcomeEnvelope(output)
  if (parsed.ok) {
    if (parsed.value.status !== "completed" || hasAuthorReviewerReport(parsed.value.text)) return output
    const envelope = JSON.parse(output) as Record<string, unknown>
    envelope.report_check = "unresolved"
    return JSON.stringify(envelope)
  }
  if (output.startsWith("Error:")) return output
  return hasAuthorReviewerReport(output) ? output : `${output}\n${UNRESOLVED_REPORT_NOTE}`
}
