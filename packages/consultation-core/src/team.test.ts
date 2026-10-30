import { describe, expect, it } from "bun:test"

import {
  AnalysisDraftBaseSchema,
  AnalysisDraftSchema,
  CritiqueDraftSchema,
  DEFAULT_TEAM_CAPS,
  ExplorerReportSchema,
  TeamRoleSchema,
  initialState,
  isConverged,
  nextAction,
  tierRoleCaps,
  withCritique,
  type ConsultationState,
  type CritiqueDraft,
} from "./team.ts"
import type { DecomposedClaim } from "./research-contracts.ts"

const budget = { maxSearches: 10, maxFetches: 10, maxSubagents: 6, maxTokens: 10000 }
const claims: DecomposedClaim[] = [
  { id: "c1", text: "claim one", kind: "fact", requiresCounterEvidence: false },
]

function crit(resolved: boolean, round: number): CritiqueDraft {
  return {
    round,
    counterEvidence: [],
    qualifyingEvidence: [],
    supersedingEvidence: [],
    flaws: [],
    missingAlternatives: [],
    provenanceProblems: [],
    biasChecks: [],
    riskAssessment: "ok",
    confidenceAdjustment: "keep",
    whatWouldChangeTheRecommendation: [],
    resolved,
    unresolvedGaps: [],
    planReview: [],
  }
}

describe("AnalysisDraftSchema", () => {
  it("requires a basis for inferred and unverifiable analysis", () => {
    expect(() =>
      AnalysisDraftSchema.parse({
        claimId: "c1",
        status: "inferred",
        finding: "the mechanism is likely X",
        confidence: "low",
      }),
    ).toThrow()

    const parsed = AnalysisDraftSchema.parse({
      claimId: "c1",
      status: "inferred",
      finding: "the mechanism is likely X",
      confidence: "low",
      basis: "inferred X from two independent reports plus the documented mechanism",
    })
    expect(parsed.basis).toContain("inferred X")
  })

  it("accepts optional load-bearing assumptions and an outside view", () => {
    const parsed = AnalysisDraftBaseSchema.parse({
      claimId: "c1",
      status: "inferred",
      finding: "the platform team will stay for the paid tier",
      confidence: "medium",
      basis: "inferred from two retention reports",
      assumptions: [
        {
          assumption: "the free tier continues",
          confidence: "medium",
          ifFalse: "the migration cost reverses the recommendation",
          test: "check the published pricing page each quarter",
        },
      ],
      outsideView: {
        referenceClass: "similar platform migrations",
        baseRate: "5 of 7 took 6-12 months (2020-2024 migrations)",
        caseAdjustment: "the smaller scope shortens it",
      },
    })

    expect(parsed.assumptions[0]?.ifFalse).toContain("migration cost")
    expect(parsed.outsideView?.baseRate).toContain("5 of 7")
  })

  it("defaults assumptions to empty and outsideView to undefined", () => {
    const parsed = AnalysisDraftBaseSchema.parse({
      claimId: "c1",
      status: "verified",
      finding: "the source says X",
      confidence: "high",
    })

    expect(parsed.assumptions).toEqual([])
    expect(parsed.outsideView).toBeUndefined()
  })

  it("accepts competing hypotheses and the evidence that discriminates them", () => {
    const parsed = AnalysisDraftBaseSchema.parse({
      claimId: "c1",
      status: "inferred",
      finding: "the outage started in the queue",
      confidence: "medium",
      basis: "inferred from the restart timeline",
      hypotheses: [
        {
          hypothesis: "the database connection pool exhausted",
          confidence: "low",
          supports: ["s1"],
          contradicts: ["s2"],
          verdict: "unresolved",
        },
        {
          hypothesis: "the queue backed up after the retry storm",
          confidence: "medium",
          supports: ["s2", "s3"],
          contradicts: [],
          verdict: "leading",
        },
      ],
      discriminatingEvidence: ["s2", "queue depth after the restart"],
    })

    expect(parsed.hypotheses?.[0]?.verdict).toBe("unresolved")
    expect(parsed.hypotheses?.[1]?.supports).toEqual(["s2", "s3"])
    expect(parsed.discriminatingEvidence).toEqual(["s2", "queue depth after the restart"])
  })

  it("keeps hypotheses and discriminatingEvidence optional", () => {
    const parsed = AnalysisDraftBaseSchema.parse({
      claimId: "c1",
      status: "verified",
      finding: "the source says X",
      confidence: "high",
    })

    expect(parsed.hypotheses).toBeUndefined()
    expect(parsed.discriminatingEvidence).toBeUndefined()
  })
})

describe("CritiqueDraftSchema design review", () => {
  it("accepts an optional nullable designReview block for design-mode pre-mortems", () => {
    const parsed = CritiqueDraftSchema.parse({
      ...crit(true, 1),
      designReview: {
        preMortem: ["the migration locks the table"],
        unmetQualityScenarios: ["p95 latency"],
        reversibilityProblems: [],
        missingOptions: ["queue the writes"],
      },
    })
    expect(parsed.designReview?.preMortem).toEqual(["the migration locks the table"])
    expect(CritiqueDraftSchema.parse(crit(true, 1)).designReview).toBeUndefined()
    expect(CritiqueDraftSchema.parse({ ...crit(true, 1), designReview: null }).designReview).toBeNull()
  })
})

describe("CritiqueDraftSchema plan review", () => {
  it("defaults planReview to an empty list and accepts bounded repairs", () => {
    expect(CritiqueDraftSchema.parse(crit(true, 1)).planReview).toEqual([])

    const parsed = CritiqueDraftSchema.parse({
      ...crit(true, 1),
      planReview: [
        {
          step: "choose a storage engine",
          uncertainty: "unverifiable",
          alternatives: ["B-tree", "LSM"],
          repair: "start with the reversible B-tree option",
          repaired: true,
        },
      ],
      residualUncertainty: "write amplification stays unknown",
    })
    expect(parsed.planReview[0]?.repaired).toBe(true)
    expect(parsed.residualUncertainty).toBe("write amplification stays unknown")
  })
})

describe("CritiqueDraftSchema selection checks", () => {
  it("defaults biasChecks to an empty list and accepts selection findings", () => {
    expect(CritiqueDraftSchema.parse(crit(true, 1)).biasChecks).toEqual([])

    const parsed = CritiqueDraftSchema.parse({
      ...crit(true, 1),
      biasChecks: [
        {
          type: "selection",
          finding: "only successful launches are visible",
          missingCases: ["failed launches", "withdrawn products"],
          denominator: "unknown population of attempts",
          verdict: "material",
        },
      ],
    })
    expect(parsed.biasChecks[0]?.missingCases).toEqual(["failed launches", "withdrawn products"])
  })
})

describe("ExplorerReportSchema selection frame", () => {
  it("defaults selectionFrame and accepts the source corroboration fields", () => {
    const graded = {
      id: "s1",
      title: "Source",
      isPrimary: true,
      accountable: true,
      methodTransparent: true,
      independenceChainId: "chain-1",
      hasCommercialOrIdeologicalConflict: false,
      recent: true,
      applicable: true,
      grade: "high",
      accessedAt: "2026-10-29",
      independentSupport: true,
      corroborationNote: "an independent regulator filing agrees",
    }

    const parsed = ExplorerReportSchema.parse({
      claims: [
        { claimId: "c1", findings: "finding", sources: [graded], coverage: {}, gaps: [] },
        {
          claimId: "c2",
          findings: "finding",
          sources: [graded],
          coverage: { selectionFrame: ["only funded cases were indexed"] },
          gaps: [],
        },
      ],
    })

    expect(parsed.claims[0]?.coverage?.selectionFrame).toEqual([])
    expect(parsed.claims[1]?.coverage?.selectionFrame).toEqual(["only funded cases were indexed"])
    expect(parsed.claims[0]?.sources[0]?.independentSupport).toBe(true)
  })
})

describe("initialState", () => {
  it("starts at phase explore, round 0, empty artifacts", () => {
    // given // when
    const state = initialState({ question: "q", tier: "standard", claims, budget })

    // then
    expect(state.phase).toBe("explore")
    expect(state.round).toBe(0)
    expect(state.evidence).toEqual([])
    expect(state.analysis).toEqual([])
    expect(state.critiques).toEqual([])
  })
})

describe("nextAction", () => {
  it("moves explore -> analyze -> critique on the first pass", () => {
    // given
    const state = initialState({ question: "q", tier: "standard", claims, budget })

    // when // then
    expect(nextAction(state)).toBe("analyze")
    const analyzed = { ...state, phase: "analyze" as const }
    expect(nextAction(analyzed)).toBe("critique")
  })

  it("returns explore after a non-resolved critique, starting a new round", () => {
    // given
    let state = initialState({ question: "q", tier: "standard", claims, budget })
    state = withCritique(state, crit(false, 0))

    // when // then
    expect(state.round).toBe(1)
    expect(nextAction(state)).toBe("explore")
  })

  it("synthesizes when the latest critique is resolved", () => {
    // given
    let state = initialState({ question: "q", tier: "deep", claims, budget })
    state = withCritique(state, crit(true, 0))

    // when // then
    expect(nextAction(state)).toBe("synthesize")
  })

  it("synthesizes at the round cap even when unresolved", () => {
    // given
    let state = initialState({ question: "q", tier: "deep", claims, budget })
    state = withCritique(state, crit(false, 0))
    state = withCritique(state, crit(false, 1))
    state = withCritique(state, crit(false, 2))

    // when // then
    expect(state.round).toBe(DEFAULT_TEAM_CAPS.roundCap)
    expect(nextAction(state)).toBe("synthesize")
  })

  it("respects an overridden smaller round cap", () => {
    // given
    let state = initialState({ question: "q", tier: "deep", claims, budget })
    state = withCritique(state, crit(false, 0))

    // when // then
    expect(nextAction(state, { ...DEFAULT_TEAM_CAPS, roundCap: 1 })).toBe("synthesize")
  })
})

describe("isConverged", () => {
  it("is false with no critiques and true when the latest is resolved", () => {
    // given // when // then
    expect(isConverged([])).toBe(false)
    expect(isConverged([crit(false, 0)])).toBe(false)
    expect(isConverged([crit(false, 0), crit(true, 1)])).toBe(true)
  })
})

describe("TeamRoleSchema", () => {
  it("lists every team role including writer", () => {
    // given // when // then
    expect(TeamRoleSchema.options).toEqual(["explorer", "analyst", "critic", "arch_critic", "auditor", "writer"])
  })
})

describe("tierRoleCaps", () => {
  it("encodes the tier matrix including writer", () => {
    // given // when // then
    expect(tierRoleCaps("fast")).toEqual({ explorer: 5, analyst: 0, critic: 0, arch_critic: 0, auditor: 0, writer: 0 })
    expect(tierRoleCaps("standard")).toEqual({ explorer: 5, analyst: 1, critic: 1, arch_critic: 1, auditor: 1, writer: 1 })
    expect(tierRoleCaps("deep")).toEqual({ explorer: 5, analyst: 3, critic: 2, arch_critic: 2, auditor: 2, writer: 2 })
  })
})

describe("DEFAULT_TEAM_CAPS", () => {
  it("caps rounds at 3, explorers at 5, critic searches at 5", () => {
    // given // when // then
    expect(DEFAULT_TEAM_CAPS).toEqual({ roundCap: 3, explorerCap: 5, criticSearchCap: 5 })
  })
})
