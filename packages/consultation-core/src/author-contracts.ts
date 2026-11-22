import { z } from "zod"
import { EpistemicStatusSchema } from "./enums.ts"

export const AuthorProfileSchema = z.enum(["tutorial", "architecture", "explanation"])
export type AuthorProfile = z.infer<typeof AuthorProfileSchema>

export const AuthorDeliverySchema = z.enum(["inline", "single_file", "multi_file"])
export type AuthorDelivery = z.infer<typeof AuthorDeliverySchema>

export const AuthorVerificationSchema = z.enum(["light", "targeted", "strict"])
export type AuthorVerification = z.infer<typeof AuthorVerificationSchema>

// D0 micro-fix, D1 local maintenance, D2 standard document, D3 large document
// set. The level decides which seats and review stages run; the profile does not.
export const AuthorLevelSchema = z.enum(["D0", "D1", "D2", "D3"])
export type AuthorLevel = z.infer<typeof AuthorLevelSchema>

// author-writer and author-reviewer are two-tier seats.
export const AuthorSeatTierSchema = z.enum(["fast", "standard"])
export type AuthorSeatTier = z.infer<typeof AuthorSeatTierSchema>

export const AuthorReviewStageSchema = z.enum(["outline", "unit", "reader", "final"])
export type AuthorReviewStage = z.infer<typeof AuthorReviewStageSchema>

export const AuthorSectionSchema = z.object({
  id: z.string().min(1),
  title: z.string().min(1),
  purpose: z.string().min(1),
  file: z.string().min(1).optional(),
  depthBudget: z.string().min(1).optional(), // approved length/depth target; exceeding it is a scope expansion
  learningObjectives: z.array(z.string().min(1)).default([]),
  prerequisites: z.array(z.string().min(1)).default([]),
  verificationTargets: z.array(z.string().min(1)).default([]),
})
export type AuthorSection = z.infer<typeof AuthorSectionSchema>

export const AuthorClaimSchema = z
  .object({
    claim: z.string().min(1),
    sectionIds: z.array(z.string().min(1)).min(1),
    status: EpistemicStatusSchema,
    basis: z.string().min(1).optional(),
    verificationMethod: z.string().min(1),
  })
  .refine(
    (value) =>
      !(value.status === "inferred" || value.status === "unverifiable") ||
      value.basis !== undefined,
    { message: "inferred/unverifiable author claims must carry a basis", path: ["basis"] },
  )
export type AuthorClaim = z.infer<typeof AuthorClaimSchema>

export const AuthorReviewVerdictSchema = z.enum(["pass", "revise", "block"])
export type AuthorReviewVerdict = z.infer<typeof AuthorReviewVerdictSchema>

export const AuthorSourceCheckSchema = z.object({
  claim: z.string().min(1),
  source: z.string().min(1), // URL or stable identifier that was opened or searched
  method: z.enum(["webfetch", "websearch", "repo"]),
  result: z.enum(["confirmed", "contradicted", "unreachable"]),
})
export type AuthorSourceCheck = z.infer<typeof AuthorSourceCheckSchema>

export const AuthorPriorFindingSchema = z.object({
  finding: z.string().min(1),
  closed: z.boolean(),
  note: z.string().min(1).optional(),
})
export type AuthorPriorFinding = z.infer<typeof AuthorPriorFindingSchema>

export const AuthorReviewerReportSchema = z.object({
  stage: AuthorReviewStageSchema,
  verdict: AuthorReviewVerdictSchema,
  factualAndSourceIssues: z.array(z.string()).default([]), // source symbol/path mismatches, unsupported red-herring chains, sourceLedger gaps
  briefAlignmentIssues: z.array(z.string()).default([]), // deviations from the brief's outline, audience, section goals, or required elements
  readabilityAndJargonIssues: z.array(z.string()).default([]), // AI-jargon stacking, unexplained first-use terms, stilted boilerplate
  flaws: z.array(z.string()).default([]), // substantive problems affecting accuracy or reader understanding
  resolved: z.boolean(), // true only when verdict === "pass" and the input material was complete
  unresolvedGaps: z.array(z.string()).default([]), // missing inputs (e.g. no brief or target file) or checks still owed
  sourceChecks: z.array(AuthorSourceCheckSchema).default([]), // every lookup the review spent, within its stage budget
  priorFindingsClosed: z.array(AuthorPriorFindingSchema).default([]), // re-review: one entry per previous-round finding
})
export type AuthorReviewerReport = z.infer<typeof AuthorReviewerReportSchema>

export const AuthorFindingDispositionSchema = z
  .object({
    finding: z.string().min(1),
    disposition: z.enum(["applied", "declined", "invalid"]),
    reason: z.string().min(1).optional(),
  })
  .refine((value) => value.disposition !== "declined" || value.reason !== undefined, {
    message: "a declined reviewer finding must carry a reason",
    path: ["reason"],
  })
export type AuthorFindingDisposition = z.infer<typeof AuthorFindingDispositionSchema>

export const AuthorReviewRecordSchema = z.object({
  stage: AuthorReviewStageSchema,
  jobId: z.string().min(1),
  tier: AuthorSeatTierSchema,
  round: z.number().int().min(1).max(3), // the first review plus at most two revise rounds per stage
  verdict: AuthorReviewVerdictSchema,
  dispositions: z.array(AuthorFindingDispositionSchema).default([]),
})
export type AuthorReviewRecord = z.infer<typeof AuthorReviewRecordSchema>
