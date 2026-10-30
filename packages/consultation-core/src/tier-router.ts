import type { ConsultationMode, RiskLevel, Tier } from "./enums.ts"

export type TierRoutingInput = {
  readonly risk: RiskLevel
  readonly hasAuthoritativePrimarySource: boolean
  readonly reliableSourceConflict: boolean
  readonly personalContextDependence: boolean
  readonly synthesisDominated: boolean
  /** Optional mode constraint: guide, author, and design never run at fast. */
  readonly mode?: ConsultationMode
}

/** Modes whose deliverable is never valid at fast tier. */
export const FAST_FORBIDDEN_MODES: ReadonlySet<ConsultationMode> = new Set<ConsultationMode>([
  "guide",
  "doc",
  "design",
])

function baseTier(input: TierRoutingInput): Tier {
  switch (input.risk) {
    case "high":
      return "deep"
    case "low":
      if (
        (input.reliableSourceConflict && input.synthesisDominated) ||
        (!input.hasAuthoritativePrimarySource && input.synthesisDominated)
      ) {
        return "deep"
      }
      if (
        input.hasAuthoritativePrimarySource &&
        !input.personalContextDependence &&
        !input.synthesisDominated
      ) {
        return "fast"
      }
      return "standard"
    case "medium":
      if (
        (input.reliableSourceConflict && input.synthesisDominated) ||
        (!input.hasAuthoritativePrimarySource && input.synthesisDominated)
      ) {
        return "deep"
      }
      return "standard"
  }
}

export function routeTier(input: TierRoutingInput): Tier {
  const tier = baseTier(input)
  if (input.mode !== undefined && FAST_FORBIDDEN_MODES.has(input.mode) && tier === "fast") {
    return "standard"
  }
  return tier
}
