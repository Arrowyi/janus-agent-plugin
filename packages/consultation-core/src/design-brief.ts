import { z } from "zod"

import { baseBriefShape, BriefSourceSchema } from "./brief-base.ts"
import { ConsultationError, ConsultationErrorCode } from "./errors.ts"

/**
 * A design record decision brief (design mode).
 *
 * A design is often grounded in the repository rather than external sources, so
 * `sources` may be empty — but only when `repoEvidence` names concrete paths and
 * symbols. The cross-field rule lives in `assertValidDesignEvidence` because a
 * `z.discriminatedUnion` member must be a plain ZodObject.
 */
export const DesignRepoEvidenceSchema = z.object({
  path: z.string().min(1),
  symbol: z.string().min(1),
  note: z.string().optional(),
})
export type DesignRepoEvidence = z.infer<typeof DesignRepoEvidenceSchema>

/** A quality attribute as a six-part scenario; the measure carries a number. */
export const DesignQualityScenarioSchema = z.object({
  source: z.string().min(1),
  stimulus: z.string().min(1),
  environment: z.string().min(1),
  artifact: z.string().min(1),
  response: z.string().min(1),
  measure: z.string().min(1),
})
export type DesignQualityScenario = z.infer<typeof DesignQualityScenarioSchema>

export const DesignOptionSchema = z.object({
  option: z.string().min(1),
  tradeoffs: z.string().min(1),
  recommended: z.boolean().default(false),
  reversal: z.enum(["one-way", "two-way"]),
  whatWouldChange: z.array(z.string()).default([]),
})
export type DesignOption = z.infer<typeof DesignOptionSchema>

export const DesignLevelSchema = z.object({
  level: z.enum(["system", "module", "interface"]),
  summary: z.string().min(1),
  decisions: z.array(z.string()).default([]),
})
export type DesignLevel = z.infer<typeof DesignLevelSchema>

export const DesignOpenQuestionSchema = z.object({
  question: z.string().min(1),
  trigger: z.string().min(1),
})
export type DesignOpenQuestion = z.infer<typeof DesignOpenQuestionSchema>

export const DesignBriefSchema = z.object({
  mode: z.literal("design"),
  ...baseBriefShape,
  // A design may be repo-grounded; `assertValidDesignEvidence` requires at
  // least one external source or one repoEvidence entry.
  sources: z.array(BriefSourceSchema).max(5).default([]),
  goal: z.string().min(1),
  nonGoals: z.array(z.string()).default([]),
  qualityScenarios: z.array(DesignQualityScenarioSchema).min(1),
  options: z.array(DesignOptionSchema).min(2),
  levels: z.array(DesignLevelSchema).min(1),
  recommendation: z.string().min(1),
  openQuestions: z.array(DesignOpenQuestionSchema).default([]),
  recordPath: z.string().min(1),
  repoEvidence: z.array(DesignRepoEvidenceSchema).default([]),
})
export type DesignBrief = z.infer<typeof DesignBriefSchema>

export function assertValidDesignEvidence(brief: DesignBrief): void {
  if (brief.sources.length === 0 && brief.repoEvidence.length === 0) {
    throw new ConsultationError(ConsultationErrorCode.VALIDATION_FAILED)
  }
}

/**
 * Text fields checked for invented numeric confidence. Quality-scenario
 * measures are deliberately excluded: a measurable target such as "99%
 * availability" is a required part of the design, not a confidence claim.
 */
export function designTexts(brief: DesignBrief): string[] {
  const texts: string[] = [
    brief.goal,
    ...brief.nonGoals,
    brief.recommendation,
    brief.recordPath,
    ...brief.openQuestions.flatMap((question) => [question.question, question.trigger]),
    ...brief.levels.flatMap((level) => [level.summary, ...level.decisions]),
    ...brief.repoEvidence.flatMap((evidence) => [evidence.path, evidence.symbol]),
  ]
  for (const scenario of brief.qualityScenarios) {
    texts.push(
      scenario.source,
      scenario.stimulus,
      scenario.environment,
      scenario.artifact,
      scenario.response,
    )
  }
  for (const option of brief.options) {
    texts.push(option.option, option.tradeoffs, ...option.whatWouldChange)
  }
  for (const evidence of brief.repoEvidence) {
    if (evidence.note !== undefined) texts.push(evidence.note)
  }
  return texts
}
