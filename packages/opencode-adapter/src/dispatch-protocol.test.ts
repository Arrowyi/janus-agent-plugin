import { describe, expect, it } from "bun:test"

import {
  DISPATCH_PROTOCOLS,
  PROTOCOL_ROLES,
  loadProtocolCard,
  prependProtocolCard,
} from "./dispatch-protocol.ts"

describe("dispatch protocol cards", () => {
  it("ships all five protocol assets as non-empty cards", async () => {
    expect([...DISPATCH_PROTOCOLS]).toEqual([
      "counter_evidence",
      "hypothesis_matrix",
      "plan_robustness",
      "design_premortem",
      "code_plan_review",
    ])
    for (const protocol of DISPATCH_PROTOCOLS) {
      const card = await loadProtocolCard(protocol)
      expect(card.length).toBeGreaterThan(0)
      expect(card).toContain(`Protocol: ${protocol}`)
    }
  })

  it("maps critic protocols and arch-critic protocols to their review roles", () => {
    expect(PROTOCOL_ROLES.counter_evidence).toEqual(["critic"])
    expect(PROTOCOL_ROLES.hypothesis_matrix).toEqual(["critic"])
    expect(PROTOCOL_ROLES.plan_robustness).toEqual(["critic"])
    expect(PROTOCOL_ROLES.design_premortem).toEqual(["arch-critic"])
    expect(PROTOCOL_ROLES.code_plan_review).toEqual(["arch-critic"])
  })

  it("prepends the card as the first bytes of the turn-1 task message", async () => {
    const card = await loadProtocolCard("plan_robustness")
    const prompt = prependProtocolCard("review this roadmap", card)
    expect(prompt.startsWith("## Protocol: plan_robustness")).toBe(true)
    expect(prompt.endsWith("review this roadmap")).toBe(true)
    expect(prependProtocolCard("plain", "")).toBe("plain")
  })
})
