import { readFile } from "node:fs/promises"

import { resolveAsset } from "./asset-paths.ts"
import type { DispatchRole } from "./dispatch-contract.ts"

export const DISPATCH_PROTOCOLS = [
  "counter_evidence",
  "hypothesis_matrix",
  "plan_robustness",
  "design_premortem",
  "code_plan_review",
] as const

export type DispatchProtocol = (typeof DISPATCH_PROTOCOLS)[number]

const PROTOCOL_ASSETS: Readonly<Record<DispatchProtocol, string>> = {
  counter_evidence: "protocols/counter_evidence.md",
  hypothesis_matrix: "protocols/hypothesis_matrix.md",
  plan_robustness: "protocols/plan_robustness.md",
  design_premortem: "protocols/design_premortem.md",
  code_plan_review: "protocols/code_plan_review.md",
}

/** Protocol → the review roles that carry the matching output contract. */
export const PROTOCOL_ROLES: Readonly<Record<DispatchProtocol, readonly DispatchRole[]>> = {
  counter_evidence: ["critic"],
  hypothesis_matrix: ["critic"],
  plan_robustness: ["critic"],
  design_premortem: ["arch-critic"],
  code_plan_review: ["arch-critic"],
}

export class ProtocolCardError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "ProtocolCardError"
  }
}

/**
 * Load a methodology card from the shipped protocol assets. A missing or empty
 * card is a deployment error: the dispatch boundary must not silently send a
 * protocol-shaped request without its instructions.
 */
export async function loadProtocolCard(protocol: DispatchProtocol): Promise<string> {
  const asset = PROTOCOL_ASSETS[protocol]
  let text: string
  try {
    text = (await readFile(resolveAsset(asset), "utf8")).trim()
  } catch {
    throw new ProtocolCardError(`protocol card ${protocol} is missing at ${asset}`)
  }
  if (text.length === 0) throw new ProtocolCardError(`protocol card ${protocol} is empty at ${asset}`)
  return text
}

/** The card is the first bytes of the turn-1 task message. */
export function prependProtocolCard(prompt: string, card: string): string {
  return card.length === 0 ? prompt : `${card}\n\n${prompt}`
}
