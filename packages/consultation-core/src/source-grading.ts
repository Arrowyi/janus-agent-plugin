import { z } from "zod"

import { SourceGradeSchema, SourceIntentSchema, type SourceGrade, type SourceIntent } from "./enums.ts"

export const SourceInputSchema = z.object({
  id: z.string(),
  title: z.string(),
  isPrimary: z.boolean(),
  accountable: z.boolean(),
  methodTransparent: z.boolean(),
  independenceChainId: z.string(),
  hasCommercialOrIdeologicalConflict: z.boolean(),
  recent: z.boolean(),
  applicable: z.boolean(),
})

export type SourceInput = z.infer<typeof SourceInputSchema>

export function gradeSource(input: SourceInput): SourceGrade {
  if (!input.applicable) return SourceGradeSchema.Enum.lead_only
  if (
    input.isPrimary &&
    input.accountable &&
    input.methodTransparent &&
    !input.hasCommercialOrIdeologicalConflict
  ) {
    return SourceGradeSchema.Enum.high
  }
  if (
    (input.isPrimary || input.accountable) &&
    input.methodTransparent &&
    !input.hasCommercialOrIdeologicalConflict &&
    input.recent
  ) {
    return SourceGradeSchema.Enum.medium
  }
  if (input.hasCommercialOrIdeologicalConflict || !input.methodTransparent) {
    return SourceGradeSchema.Enum.low
  }
  return SourceGradeSchema.Enum.lead_only
}

export function groupByChain<T extends { readonly independenceChainId: string }>(
  sources: readonly T[],
): Map<string, T[]> {
  const chains = new Map<string, T[]>()
  for (const source of sources) {
    const chain = chains.get(source.independenceChainId)
    if (chain === undefined) {
      chains.set(source.independenceChainId, [source])
      continue
    }
    chain.push(source)
  }
  return chains
}

/**
 * Deliberate-deception signals an intent-auditing agent can detect via text,
 * account, temporal, rating-distribution, or platform-marker inspection.
 * The agent reports which signals fired; `gradeIntent` aggregates the verdict.
 */
export const IntentSignalsSchema = z.object({
  temporalBurst: z.boolean(),
  phraseRepetition: z.boolean(),
  singleProductAccount: z.boolean(),
  ratingTextMismatch: z.boolean(),
  newHighVolumeAccount: z.boolean(),
  missingDisclosure: z.boolean(),
  targetConcentration: z.boolean(),
  crossAccountReuse: z.boolean(),
  incentivizedSignal: z.boolean(),
  sentimentSkewPositive: z.boolean(),
  sentimentSkewNegative: z.boolean(),
})

export type IntentSignals = z.infer<typeof IntentSignalsSchema>

/**
 * The same eleven detection signals as a named list, for agents that report
 * only the signals that fired instead of a boolean matrix.
 */
export const IntentSignalNameSchema = z.enum([
  "temporalBurst",
  "phraseRepetition",
  "singleProductAccount",
  "ratingTextMismatch",
  "newHighVolumeAccount",
  "missingDisclosure",
  "targetConcentration",
  "crossAccountReuse",
  "incentivizedSignal",
  "sentimentSkewPositive",
  "sentimentSkewNegative",
])

export type IntentSignalName = z.infer<typeof IntentSignalNameSchema>

export function intentSignalsFromNames(names: readonly IntentSignalName[]): IntentSignals {
  const fired = new Set(names)
  return {
    temporalBurst: fired.has("temporalBurst"),
    phraseRepetition: fired.has("phraseRepetition"),
    singleProductAccount: fired.has("singleProductAccount"),
    ratingTextMismatch: fired.has("ratingTextMismatch"),
    newHighVolumeAccount: fired.has("newHighVolumeAccount"),
    missingDisclosure: fired.has("missingDisclosure"),
    targetConcentration: fired.has("targetConcentration"),
    crossAccountReuse: fired.has("crossAccountReuse"),
    incentivizedSignal: fired.has("incentivizedSignal"),
    sentimentSkewPositive: fired.has("sentimentSkewPositive"),
    sentimentSkewNegative: fired.has("sentimentSkewNegative"),
  }
}

export function gradeIntent(signals: IntentSignals): SourceIntent {
  const mechanics: readonly boolean[] = [
    signals.temporalBurst,
    signals.phraseRepetition,
    signals.singleProductAccount,
    signals.ratingTextMismatch,
    signals.newHighVolumeAccount,
    signals.crossAccountReuse,
    signals.incentivizedSignal,
  ]
  const mechanicCount = mechanics.filter(Boolean).length
  if (mechanicCount < 2) return SourceIntentSchema.Enum.clean

  // Direction: targetConcentration or a negative sentiment skew marks a smear;
  // a positive skew or missing commercial disclosure marks a shill. Ambiguous
  // direction degrades to unknown rather than guessing a side.
  const negative = signals.targetConcentration || signals.sentimentSkewNegative
  const positive = signals.sentimentSkewPositive || signals.missingDisclosure
  if (negative && !positive) return SourceIntentSchema.Enum.suspect_smear
  if (positive && !negative) return SourceIntentSchema.Enum.suspect_shill
  return SourceIntentSchema.Enum.unknown
}

export function gradeIntentFromNames(names: readonly IntentSignalName[]): SourceIntent {
  return gradeIntent(intentSignalsFromNames(names))
}
