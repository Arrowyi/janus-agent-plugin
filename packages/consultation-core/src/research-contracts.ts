import { z } from "zod"

import {
  ClaimKindSchema,
  SourceGradeSchema,
  SourceIntentSchema,
  SourceStanceSchema,
  SourceTypeSchema,
} from "./enums.ts"
import { IntentSignalNameSchema, SourceInputSchema } from "./source-grading.ts"

export const DecomposedClaimSchema = z.object({
  id: z.string(),
  text: z.string(),
  kind: ClaimKindSchema,
  requiresCounterEvidence: z.boolean(),
})

export type DecomposedClaim = z.infer<typeof DecomposedClaimSchema>

export const GradedSourceSchema = SourceInputSchema.extend({
  grade: SourceGradeSchema,
  gradeBasis: z.string().optional(),
  independentSupport: z.boolean().optional(),
  corroborationNote: z.string().optional(),
  url: z.string().optional(),
  publisher: z.string().optional(),
  publishedAt: z.string().optional(),
  sourceType: SourceTypeSchema.optional(),
  stance: SourceStanceSchema.optional(),
  accessedAt: z.string(),
  excerpt: z.string().optional(),
  intent: SourceIntentSchema.optional(),
  intentSignalsFired: z.array(IntentSignalNameSchema).optional(),
})

export type GradedSource = z.infer<typeof GradedSourceSchema>

export const SourceIndependenceSchema = z.enum(["supported", "unclear", "conflicted"])
export type SourceIndependence = z.infer<typeof SourceIndependenceSchema>

export const SourceIntentAuditSchema = z.object({
  sourceId: z.string(),
  intent: SourceIntentSchema,
  signalsFired: z.array(IntentSignalNameSchema).default([]),
  independence: SourceIndependenceSchema.optional(),
  missingObservations: z.array(z.string()).default([]),
  rationale: z.string(),
})

export type SourceIntentAudit = z.infer<typeof SourceIntentAuditSchema>
