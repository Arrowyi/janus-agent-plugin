import { describe, expect, it } from "bun:test"
import { z } from "zod"

import {
  AnalysisDraftBaseSchema,
  AnalysisDraftSchema,
  CandidateAttributeValueSchema,
  CandidateTaxonomyBucketSchema,
  CodePlanReviewSchema,
  CritiqueDraftSchema,
  DEFAULT_TEAM_CAPS,
  DiscoveredCandidateSchema,
  ExplorerClaimReportSchema,
  ExplorerReportBaseSchema,
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
import type { DecomposedClaim, GradedSource } from "./research-contracts.ts"

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

describe("CodePlanReviewSchema", () => {
  it("parses a full code plan review and rejects an unknown verdict", () => {
    const parsed = CodePlanReviewSchema.parse({
      verdict: "revise",
      deviations: ["step 2 edits an unapproved file"],
      missingTasks: ["the schema decision has no task"],
      untestedInterfaces: ["the schema interface has no parse test"],
      correctnessRisks: ["the snapshot refresh could be skipped"],
      scopeCreep: ["a formatting-only edit rides along"],
      residualUncertainty: ["eval coverage stays unverified"],
    })
    expect(parsed.verdict).toBe("revise")
    expect(parsed.missingTasks).toHaveLength(1)
    expect(parsed.residualUncertainty).toEqual(["eval coverage stays unverified"])
    expect(() => CodePlanReviewSchema.parse({ verdict: "ship it" })).toThrow()
  })

  it("defaults every list to empty and stays optional and nullable on CritiqueDraftSchema", () => {
    const parsed = CodePlanReviewSchema.parse({ verdict: "pass" })
    expect(parsed.deviations).toEqual([])
    expect(parsed.scopeCreep).toEqual([])

    const draft = CritiqueDraftSchema.parse({
      ...crit(true, 1),
      codePlanReview: { verdict: "block", correctnessRisks: ["the migration path is untested"] },
    })
    expect(draft.codePlanReview?.verdict).toBe("block")
    expect(CritiqueDraftSchema.parse(crit(true, 1)).codePlanReview).toBeUndefined()
    expect(CritiqueDraftSchema.parse({ ...crit(true, 1), codePlanReview: null }).codePlanReview).toBeNull()
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
    expect(TeamRoleSchema.options).toEqual(["common_explorer", "consultant_analyst", "consultant_critic", "coder_reviewer", "consultant_auditor", "author_writer"])
  })
})

describe("tierRoleCaps", () => {
  it("encodes the tier matrix including writer", () => {
    // given // when // then
    expect(tierRoleCaps("fast")).toEqual({ common_explorer: 5, consultant_analyst: 0, consultant_critic: 0, coder_reviewer: 0, consultant_auditor: 0, author_writer: 0 })
    expect(tierRoleCaps("standard")).toEqual({ common_explorer: 5, consultant_analyst: 1, consultant_critic: 1, coder_reviewer: 1, consultant_auditor: 1, author_writer: 1 })
    expect(tierRoleCaps("deep")).toEqual({ common_explorer: 5, consultant_analyst: 3, consultant_critic: 2, coder_reviewer: 2, consultant_auditor: 2, author_writer: 2 })
  })
})

describe("DEFAULT_TEAM_CAPS", () => {
  it("caps rounds at 3, explorers at 5, critic searches at 5", () => {
    // given // when // then
    expect(DEFAULT_TEAM_CAPS).toEqual({ roundCap: 3, explorerCap: 5, criticSearchCap: 5 })
  })
})

describe("ExplorerReportSchema discovery payloads", () => {
  type AttributePayload = z.infer<typeof CandidateAttributeValueSchema>
  type BucketPayload = z.infer<typeof CandidateTaxonomyBucketSchema>
  type CandidatePayload = z.infer<typeof DiscoveredCandidateSchema>
  type ClaimPayload = z.infer<typeof ExplorerClaimReportSchema>
  type DiscoveryPayload = {
    claims: ClaimPayload[]
    sources: GradedSource[]
    candidateTaxonomy: BucketPayload[]
    emergingBucketStatus?: string
    candidatePool: CandidatePayload[]
  }

  const highSource: GradedSource = {
    id: "s1",
    title: "Standards body spec page",
    isPrimary: true,
    accountable: true,
    methodTransparent: true,
    independenceChainId: "chain-a",
    hasCommercialOrIdeologicalConflict: false,
    recent: true,
    applicable: true,
    grade: "high",
    accessedAt: "2026-11-09",
  }
  const mediumSource: GradedSource = {
    id: "s2",
    title: "Neutral product directory",
    isPrimary: false,
    accountable: true,
    methodTransparent: true,
    independenceChainId: "chain-b",
    hasCommercialOrIdeologicalConflict: false,
    recent: true,
    applicable: true,
    grade: "medium",
    accessedAt: "2026-11-09",
  }
  const lowSource: GradedSource = {
    id: "s3",
    title: "Commercial platform directory",
    isPrimary: false,
    accountable: false,
    methodTransparent: true,
    independenceChainId: "chain-c",
    hasCommercialOrIdeologicalConflict: true,
    recent: true,
    applicable: true,
    grade: "low",
    accessedAt: "2026-11-09",
  }
  const leadSource: GradedSource = {
    id: "s4",
    title: "Unverified forum lead",
    isPrimary: false,
    accountable: false,
    methodTransparent: true,
    independenceChainId: "chain-d",
    hasCommercialOrIdeologicalConflict: false,
    recent: false,
    applicable: false,
    grade: "lead_only",
    accessedAt: "2026-11-09",
  }

  const discoveryBaseline: DiscoveryPayload = {
    claims: [],
    sources: [highSource, mediumSource, lowSource],
    candidateTaxonomy: [
      {
        bucketId: "b1",
        label: "Premium all-mountain boards",
        definingCriteria: "Wider waist and heavier build than a trail board",
        isEmergingOrNiche: false,
        provisional: false,
        sourceIds: ["s1"],
      },
      {
        bucketId: "b2",
        label: "Value boards",
        definingCriteria: "Cheapest boards still carrying a verified spec sheet",
        isEmergingOrNiche: false,
        provisional: false,
        sourceIds: ["s2"],
      },
      {
        bucketId: "b3",
        label: "Emerging niche boards",
        definingCriteria: "New brands with thin public documentation",
        isEmergingOrNiche: true,
        provisional: false,
        sourceIds: ["s3"],
      },
    ],
    candidatePool: [
      {
        candidateId: "cand1",
        name: "Candidate A",
        bucketId: "b1",
        attributes: { topSheet: { value: "carbon", sourceIds: ["s1"] } },
        discoveryChannels: ["retail catalogue scan", "independent forum sweep"],
        sourceIds: ["s1"],
        evidenceSparse: false,
      },
      {
        candidateId: "cand2",
        name: "Candidate B",
        bucketId: "b3",
        attributes: {},
        discoveryChannels: ["niche brand sites"],
        sourceIds: ["s3"],
        evidenceSparse: false,
        constraintCheck: { passed: false, exclusionReason: "exceeds the hard budget cap", sourceIds: ["s2"] },
      },
    ],
  }

  function withReplaced<T>(items: readonly T[], index: number, update: (item: T) => T): T[] {
    return items.map((item, i) => (i === index ? update(item) : item))
  }

  it("the baseline discovery payload parses", () => {
    expect(ExplorerReportSchema.parse(discoveryBaseline)).toBeDefined()
  })

  it("parses a pure discovery payload with the claims key omitted", () => {
    const payload = {
      sources: discoveryBaseline.sources,
      candidateTaxonomy: discoveryBaseline.candidateTaxonomy,
      candidatePool: discoveryBaseline.candidatePool,
    }
    expect(ExplorerReportSchema.parse(payload)).toBeDefined()
  })

  it("parses a merged payload where a claim carries an unreferenced source", () => {
    const claimSource: GradedSource = {
      id: "s9",
      title: "Claim-only lead",
      isPrimary: false,
      accountable: false,
      methodTransparent: false,
      independenceChainId: "chain-f",
      hasCommercialOrIdeologicalConflict: false,
      recent: false,
      applicable: true,
      grade: "lead_only",
      accessedAt: "2026-11-09",
    }
    const payload = {
      ...discoveryBaseline,
      claims: [{ claimId: "c1", findings: "Merged-wave finding.", sources: [claimSource], gaps: [] }],
    }
    expect(ExplorerReportSchema.parse(payload)).toBeDefined()
  })

  it("lets a top-level source degrade below its computed grade", () => {
    const payload = {
      ...discoveryBaseline,
      sources: [highSource, mediumSource, { ...lowSource, grade: "lead_only" }],
    }
    expect(ExplorerReportSchema.parse(payload)).toBeDefined()
  })

  it("rejects a top-level source declared high while the computed grade is low", () => {
    const payload = {
      ...discoveryBaseline,
      sources: [highSource, mediumSource, { ...lowSource, grade: "high" }],
    }
    expect(() => ExplorerReportSchema.parse(payload)).toThrow()
  })

  it("rejects an unreferenced top-level source that over-claims its grade", () => {
    const vendorSource: GradedSource = {
      id: "s5",
      title: "Vendor marketing directory",
      isPrimary: false,
      accountable: false,
      methodTransparent: true,
      independenceChainId: "chain-e",
      hasCommercialOrIdeologicalConflict: true,
      recent: true,
      applicable: true,
      grade: "high",
      accessedAt: "2026-11-09",
    }
    const payload = {
      ...discoveryBaseline,
      sources: [...discoveryBaseline.sources, vendorSource],
    }
    expect(() => ExplorerReportSchema.parse(payload)).toThrow()
  })

  it("rejects a non-emerging non-provisional bucket citing only a lead_only source", () => {
    const payload = {
      ...discoveryBaseline,
      sources: [...discoveryBaseline.sources, leadSource],
      candidateTaxonomy: withReplaced(discoveryBaseline.candidateTaxonomy, 0, (b) => ({
        ...b,
        sourceIds: ["s4"],
      })),
    }
    expect(() => ExplorerReportSchema.parse(payload)).toThrow()
  })

  it("rejects a provisional bucket citing only a lead_only source", () => {
    const payload = {
      ...discoveryBaseline,
      sources: [...discoveryBaseline.sources, leadSource],
      candidateTaxonomy: [
        ...discoveryBaseline.candidateTaxonomy,
        {
          bucketId: "b4",
          label: "Provisional newcomer picks",
          definingCriteria: "Community-named boards without a verified spec",
          isEmergingOrNiche: false,
          provisional: true,
          sourceIds: ["s4"],
        },
      ],
    }
    expect(() => ExplorerReportSchema.parse(payload)).toThrow()
  })

  it("accepts a provisional bucket citing a low-grade source", () => {
    const payload = {
      ...discoveryBaseline,
      candidateTaxonomy: [
        ...discoveryBaseline.candidateTaxonomy,
        {
          bucketId: "b5",
          label: "Provisional value picks",
          definingCriteria: "Community-priced picks without a verified spec",
          isEmergingOrNiche: false,
          provisional: true,
          sourceIds: ["s3"],
        },
      ],
    }
    expect(ExplorerReportSchema.parse(payload)).toBeDefined()
  })

  it("accepts an emerging bucket citing only a lead_only source", () => {
    const payload = {
      ...discoveryBaseline,
      sources: [...discoveryBaseline.sources, leadSource],
      candidateTaxonomy: withReplaced(discoveryBaseline.candidateTaxonomy, 2, (b) => ({
        ...b,
        sourceIds: ["s4"],
      })),
    }
    expect(ExplorerReportSchema.parse(payload)).toBeDefined()
  })

  it("rejects a candidate whose bucketId is not in the taxonomy", () => {
    const payload = {
      ...discoveryBaseline,
      candidatePool: withReplaced(discoveryBaseline.candidatePool, 0, (c) => ({
        ...c,
        bucketId: "b-unknown",
      })),
    }
    expect(() => ExplorerReportSchema.parse(payload)).toThrow()
  })

  it("rejects a candidate pool without a candidate taxonomy, even with claims", () => {
    const payload = {
      claims: [{ claimId: "c1", findings: "Counter-evidence collected.", sources: [highSource], gaps: [] }],
      sources: [highSource, mediumSource, lowSource],
      candidatePool: discoveryBaseline.candidatePool,
    }
    expect(() => ExplorerReportSchema.parse(payload)).toThrow()
  })

  it("rejects a candidate citing an unknown sourceId", () => {
    const payload = {
      ...discoveryBaseline,
      candidatePool: withReplaced(discoveryBaseline.candidatePool, 0, (c) => ({
        ...c,
        sourceIds: ["s-ghost-a"],
      })),
    }
    expect(() => ExplorerReportSchema.parse(payload)).toThrow()
  })

  it("rejects an attribute citing an unknown sourceId", () => {
    const payload = {
      ...discoveryBaseline,
      candidatePool: withReplaced(discoveryBaseline.candidatePool, 0, (c) => ({
        ...c,
        attributes: { topSheet: { value: "carbon", sourceIds: ["s-ghost-b"] } },
      })),
    }
    expect(() => ExplorerReportSchema.parse(payload)).toThrow()
  })

  it("rejects a constraint check citing an unknown sourceId", () => {
    const payload = {
      ...discoveryBaseline,
      candidatePool: withReplaced(discoveryBaseline.candidatePool, 1, (c) => ({
        ...c,
        constraintCheck: {
          passed: false,
          exclusionReason: "exceeds the hard budget cap",
          sourceIds: ["s-ghost-c"],
        },
      })),
    }
    expect(() => ExplorerReportSchema.parse(payload)).toThrow()
  })

  it("rejects a failed constraint check without an exclusion reason", () => {
    const payload = {
      ...discoveryBaseline,
      candidatePool: withReplaced(discoveryBaseline.candidatePool, 1, (c) => ({
        ...c,
        constraintCheck: { passed: false, sourceIds: ["s2"] },
      })),
    }
    expect(() => ExplorerReportSchema.parse(payload)).toThrow()
  })

  it("rejects a failed constraint check citing only a low-grade source", () => {
    const payload = {
      ...discoveryBaseline,
      candidatePool: withReplaced(discoveryBaseline.candidatePool, 1, (c) => ({
        ...c,
        constraintCheck: { passed: false, exclusionReason: "too stiff", sourceIds: ["s3"] },
      })),
    }
    expect(() => ExplorerReportSchema.parse(payload)).toThrow()
  })

  it("rejects a non-unknown attribute with an empty sourceIds list", () => {
    const payload = {
      ...discoveryBaseline,
      candidatePool: withReplaced(discoveryBaseline.candidatePool, 0, (c) => ({
        ...c,
        attributes: { topSheet: { value: "carbon", sourceIds: [] } },
      })),
    }
    expect(() => ExplorerReportSchema.parse(payload)).toThrow()
  })

  it("rejects an empty report with no claims and no discovery fields", () => {
    expect(() => ExplorerReportSchema.parse({})).toThrow()
    expect(() => ExplorerReportSchema.parse(discoveryBaseline)).not.toThrow()
    expect(() => ExplorerReportSchema.parse({ claims: [] })).toThrow()
  })
})
