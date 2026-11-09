import { z } from "zod"

import { ConfidenceSchema, SourceGradeSchema, StabilitySchema, type EpistemicStatus } from "./enums.ts"

export const BriefSourceSchema = z.object({
  title: z.string(),
  url: z.string().optional(),
  grade: SourceGradeSchema,
})

export const EliminationBucketSummarySchema = z.object({
  bucket: z.string().min(1),
  provisional: z.boolean().optional(),
  scanned: z.array(z.string().min(1)).default([]),
  finalists: z.array(z.string().min(1)).default([]),
  exclusionReason: z.string().optional(),
})

export const baseBriefShape = {
  conclusion: z.string().min(1),
  confidence: ConfidenceSchema,
  stability: StabilitySchema,
  verifiedFacts: z.array(z.string()).default([]),
  synthesis: z.array(z.string()).default([]),
  sources: z.array(BriefSourceSchema).min(1).max(5),
  nextAction: z.string().min(1),
  memoryDisclosure: z.array(z.string()).default([]),
  ledgerPath: z.string().min(1).optional(),
  eliminationSummary: z.array(EliminationBucketSummarySchema).max(6).optional(),
} as const

function requiresBasis(status: EpistemicStatus): boolean {
  return status === "inferred" || status === "unverifiable"
}

export function basisRefinement<T extends { basis?: string }>(
  status: (value: T) => EpistemicStatus,
): (value: T) => boolean {
  return (value) => !requiresBasis(status(value)) || (value.basis !== undefined && value.basis.length > 0)
}
