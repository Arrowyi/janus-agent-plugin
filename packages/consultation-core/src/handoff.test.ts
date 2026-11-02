import { describe, expect, it } from "bun:test"

import { ConsultationError } from "./errors.ts"
import {
  HANDOFF_FACTS_HEADER,
  HANDOFF_LEDGER_HEADER,
  HANDOFF_POINTERS_HEADER,
  HANDOFF_QUESTIONS_HEADER,
  HANDOFF_READ_WINDOW_LINES,
  HANDOFF_SNAPSHOT_HEADER,
  HANDOFF_SNAPSHOT_MAX_LINES,
  createHandoffDocument,
  markHandoffAccepted,
  parseHandoffDocument,
  prependHandoffHop,
  setHandoffStatus,
  type CreateHandoffInput,
  type HandoffHopInput,
} from "./handoff.ts"

const SNAPSHOT = [
  HANDOFF_FACTS_HEADER,
  "- [F1] (verified, basis: repo agent-registration.ts resolveDesignStateDir) state dirs derive from XDG_DATA_HOME — from Hop 1",
  "",
  HANDOFF_QUESTIONS_HEADER,
  "- [Q1 -> architect] Which module owns the new resolver? — from Hop 1",
  "",
  HANDOFF_POINTERS_HEADER,
  "- design.md: ~/.local/share/janus-agent/design/proj-1a2b3c4d/<designId>/design.md — updated Hop 1",
].join("\n")

function makeCreateInput(overrides: Partial<CreateHandoffInput> = {}): CreateHandoffInput {
  return {
    handoffId: "api-gateway-selection",
    title: "API 网关选型与落地",
    fromRole: "consultant",
    toRole: "architect",
    reason: "单向门选型需要架构决策",
    timestamp: "2026-11-02T08:00:00.000Z",
    factRefs: ["F1"],
    questionRefs: ["Q1"],
    snapshot: SNAPSHOT,
    ...overrides,
  }
}

function makeHopInput(overrides: Partial<HandoffHopInput> = {}): HandoffHopInput {
  return {
    fromRole: "architect",
    toRole: "coder",
    reason: "设计已定稿，移交实施",
    timestamp: "2026-11-02T10:30:00.000Z",
    factRefs: [],
    questionRefs: [],
    ...overrides,
  }
}

describe("createHandoffDocument", () => {
  it("renders the canonical frontmatter + two-section document and round-trips through parseHandoffDocument", () => {
    // given
    const input = makeCreateInput()

    // when
    const doc = createHandoffDocument(input)

    // then
    expect(doc.startsWith("---\n")).toBe(true)
    expect(doc).toContain('title: "API 网关选型与落地"')
    expect(doc).toContain("handoff_id: api-gateway-selection")
    expect(doc).toContain("status: active")
    expect(doc).toContain("current_team: architect")
    expect(doc).toContain("hop_state: proposed")
    expect(doc).toContain("hop_count: 1")
    expect(doc).toContain("updated_at: 2026-11-02T08:00:00.000Z")
    expect(doc.indexOf(HANDOFF_SNAPSHOT_HEADER)).toBeGreaterThan(0)
    expect(doc.indexOf(HANDOFF_LEDGER_HEADER)).toBeGreaterThan(doc.indexOf(HANDOFF_SNAPSHOT_HEADER))
    expect(doc).toContain("### Hop 1: consultant -> architect (2026-11-02T08:00:00.000Z)")
    expect(doc).toContain("- Reason: 单向门选型需要架构决策")
    expect(doc).toContain("- Facts: F1")
    expect(doc).toContain("- Questions: Q1")

    const parsed = parseHandoffDocument(doc)
    expect(parsed.frontmatter.hop_count).toBe(1)
    expect(parsed.frontmatter.current_team).toBe("architect")
    expect(parsed.hops).toHaveLength(1)
    expect(parsed.hops[0]!.n).toBe(1)
    expect(parsed.hops[0]!.fromRole).toBe("consultant")
    expect(parsed.hops[0]!.toRole).toBe("architect")
    expect(parsed.snapshot).toBe(SNAPSHOT)
  })

  it("rejects filesystem-unsafe or non-kebab handoff ids", () => {
    // given // when // then
    for (const handoffId of ["../escape", "a/b", "UPPER_CASE", ""]) {
      expect(() => createHandoffDocument(makeCreateInput({ handoffId }))).toThrow(ConsultationError)
    }
  })

  it("rejects an initial snapshot that violates the snapshot contract", () => {
    // given — over the line cap
    const tooManyLines = [
      HANDOFF_FACTS_HEADER,
      ...Array.from({ length: HANDOFF_SNAPSHOT_MAX_LINES }, (_, i) => `- [F${i + 1}] (verified, basis: b) f${i + 1}`),
      "",
      HANDOFF_QUESTIONS_HEADER,
      "",
      HANDOFF_POINTERS_HEADER,
    ].join("\n")
    expect(() => createHandoffDocument(makeCreateInput({ snapshot: tooManyLines }))).toThrow(ConsultationError)

    // and — a fact without the required epistemic label and basis
    const noBasis = [
      HANDOFF_FACTS_HEADER,
      "- [F1] state dirs derive from XDG_DATA_HOME",
      "",
      HANDOFF_QUESTIONS_HEADER,
      "",
      HANDOFF_POINTERS_HEADER,
    ].join("\n")
    expect(() => createHandoffDocument(makeCreateInput({ snapshot: noBasis }))).toThrow(ConsultationError)

    // and — a missing subsection
    const noPointers = [HANDOFF_FACTS_HEADER, "- [F1] (verified, basis: b) f1", "", HANDOFF_QUESTIONS_HEADER].join("\n")
    expect(() => createHandoffDocument(makeCreateInput({ snapshot: noPointers }))).toThrow(ConsultationError)
  })
})

describe("parseHandoffDocument", () => {
  it("parses a two-hop document newest-first with hop bodies", () => {
    // given
    const doc = prependHandoffHop(createHandoffDocument(makeCreateInput()), makeHopInput())

    // when
    const parsed = parseHandoffDocument(doc)

    // then
    expect(parsed.frontmatter.hop_count).toBe(2)
    expect(parsed.frontmatter.current_team).toBe("coder")
    expect(parsed.hops).toHaveLength(2)
    expect(parsed.hops[0]!.n).toBe(2)
    expect(parsed.hops[0]!.toRole).toBe("coder")
    expect(parsed.hops[1]!.n).toBe(1)
    expect(parsed.hops[1]!.toRole).toBe("architect")
  })

  it("intercepts invalid imported documents", () => {
    // given // when // then — no frontmatter at all
    expect(() => parseHandoffDocument("# A random README\n\nSome prose.")).toThrow(ConsultationError)

    // and — missing ledger section
    const noLedger = createHandoffDocument(makeCreateInput()).split(HANDOFF_LEDGER_HEADER)[0]!
    expect(() => parseHandoffDocument(noLedger)).toThrow(ConsultationError)

    // and — content before section 1
    const strayIntro = createHandoffDocument(makeCreateInput()).replace(
      `${HANDOFF_SNAPSHOT_HEADER}`,
      `Some intro prose.\n\n${HANDOFF_SNAPSHOT_HEADER}`,
    )
    expect(() => parseHandoffDocument(strayIntro)).toThrow(ConsultationError)

    // and — hop_count that disagrees with the ledger
    const tampered = createHandoffDocument(makeCreateInput()).replace("hop_count: 1", "hop_count: 2")
    expect(() => parseHandoffDocument(tampered)).toThrow(ConsultationError)

    // and — a non-team hop target (janus routes but never holds a handoff)
    const toJanus = createHandoffDocument(makeCreateInput()).replace(
      "### Hop 1: consultant -> architect",
      "### Hop 1: consultant -> janus",
    )
    expect(() => parseHandoffDocument(toJanus)).toThrow(ConsultationError)

    // and — a hop body that is not list lines
    const proseHop = createHandoffDocument(makeCreateInput()).replace(
      "- Reason: 单向门选型需要架构决策",
      "Reason is written as prose here",
    )
    expect(() => parseHandoffDocument(proseHop)).toThrow(ConsultationError)
  })
})

describe("prependHandoffHop", () => {
  it("inserts the newest hop directly under the ledger heading and refreshes the frontmatter in place", () => {
    // given
    const created = createHandoffDocument(makeCreateInput())

    // when
    const doc = prependHandoffHop(created, makeHopInput())

    // then — newest hop sits at the top of the ledger, Hop 1 at the bottom
    const ledger = doc.slice(doc.indexOf(HANDOFF_LEDGER_HEADER))
    expect(ledger.indexOf("### Hop 2: architect -> coder")).toBeGreaterThan(0)
    expect(ledger.indexOf("### Hop 2")).toBeLessThan(ledger.indexOf("### Hop 1"))
    expect(doc).toContain("hop_count: 2")
    expect(doc).toContain("current_team: coder")
    expect(doc).toContain("hop_state: proposed")
    expect(doc).toContain("updated_at: 2026-11-02T10:30:00.000Z")
  })

  it("keeps the snapshot when no replacement is supplied", () => {
    // given
    const created = createHandoffDocument(makeCreateInput())

    // when
    const doc = prependHandoffHop(created, makeHopInput())

    // then
    expect(parseHandoffDocument(doc).snapshot).toBe(SNAPSHOT)
  })

  it("replaces the snapshot in place, superseding the overturned fact", () => {
    // given
    const created = createHandoffDocument(makeCreateInput())
    const superseding = [
      HANDOFF_FACTS_HEADER,
      "- [F2] (inferred, basis: Hop 1 结论被 Hop 2 实测推翻, supersedes: F1) state dirs follow XDG_DATA_HOME only on Linux — from Hop 2",
      "",
      HANDOFF_QUESTIONS_HEADER,
      "- [Q2 -> coder] Confirm the macOS fallback — from Hop 2",
      "",
      HANDOFF_POINTERS_HEADER,
      "- design.md: ~/.local/share/janus-agent/design/proj-1a2b3c4d/<designId>/design.md — updated Hop 2",
    ].join("\n")

    // when
    const doc = prependHandoffHop(created, makeHopInput({ snapshot: superseding, factRefs: ["F2 (supersedes F1)"] }))

    // then — the new fact replaces the old one in section 1
    const parsed = parseHandoffDocument(doc)
    expect(parsed.snapshot).toBe(superseding)
    expect(doc).toContain("supersedes: F1")
    expect(parsed.snapshot).not.toContain("[F1]")
    // and — the ledger hop references the supersession
    expect(doc).toContain("- Facts: F2 (supersedes F1)")
  })

  it("rejects an invalid replacement snapshot without partial writes", () => {
    // given
    const created = createHandoffDocument(makeCreateInput())
    const broken = [HANDOFF_FACTS_HEADER, "- not a fact entry", "", HANDOFF_QUESTIONS_HEADER, "", HANDOFF_POINTERS_HEADER].join(
      "\n",
    )

    // when // then — a pure function: it either throws or returns a full document
    expect(() => prependHandoffHop(created, makeHopInput({ snapshot: broken }))).toThrow(ConsultationError)
  })
})

describe("constant first-120-line read window", () => {
  it("keeps the full snapshot and the latest hops within the window after ten round trips", () => {
    // given — a near-cap snapshot and a first hop
    const bigSnapshot = [
      HANDOFF_FACTS_HEADER,
      ...Array.from({ length: 30 }, (_, i) => `- [F${i + 1}] (verified, basis: evidence ${i + 1}) fact ${i + 1} — from Hop 1`),
      "",
      HANDOFF_QUESTIONS_HEADER,
      ...Array.from({ length: 20 }, (_, i) => `- [Q${i + 1} -> architect] question ${i + 1}`),
      "",
      HANDOFF_POINTERS_HEADER,
      ...Array.from({ length: 20 }, (_, i) => `- design.md: /tmp/design-${i + 1}/design.md — updated Hop 1`),
    ].join("\n")
    expect(bigSnapshot.split("\n").length).toBeLessThanOrEqual(HANDOFF_SNAPSHOT_MAX_LINES)

    let doc = createHandoffDocument(
      makeCreateInput({ snapshot: bigSnapshot, title: "十跳往返课题", handoffId: "ten-hop-topic" }),
    )

    // when — nine more hops alternate coder -> architect -> coder
    const teams = ["architect", "coder"] as const
    for (let hop = 2; hop <= 10; hop += 1) {
      doc = prependHandoffHop(
        doc,
        makeHopInput({
          fromRole: hop % 2 === 0 ? "coder" : "architect",
          toRole: teams[hop % 2]!,
          reason: `第 ${hop} 跳往返`,
          timestamp: `2026-11-02T${String(10 + hop).padStart(2, "0")}:00:00.000Z`,
        }),
      )
    }

    // then — the document is still fully valid
    const parsed = parseHandoffDocument(doc)
    expect(parsed.frontmatter.hop_count).toBe(10)
    expect(parsed.hops[0]!.n).toBe(10)
    expect(parsed.hops[9]!.n).toBe(1)

    // and — the first 120 lines carry the complete snapshot plus the latest hops
    const window = doc.split("\n").slice(0, HANDOFF_READ_WINDOW_LINES).join("\n")
    expect(window).toContain(HANDOFF_SNAPSHOT_HEADER)
    for (const line of bigSnapshot.split("\n")) {
      expect(window).toContain(line)
    }
    expect(window).toContain("### Hop 10:")
    expect(window).toContain("### Hop 9:")
    expect(window).toContain("### Hop 8:")
    // and — the oldest hops have fallen out of the constant window
    expect(window).not.toContain("### Hop 1:")
    expect(window).not.toContain("### Hop 2:")
  })
})

describe("state flips", () => {
  it("marks the current hop accepted, optionally refreshing updated_at", () => {
    // given
    const created = createHandoffDocument(makeCreateInput())

    // when
    const accepted = markHandoffAccepted(created)

    // then
    const parsed = parseHandoffDocument(accepted)
    expect(parsed.frontmatter.hop_state).toBe("accepted")
    expect(parsed.frontmatter.updated_at).toBe("2026-11-02T08:00:00.000Z")

    // and — with a timestamp
    const stamped = markHandoffAccepted(accepted, "2026-11-02T09:15:00.000Z")
    expect(parseHandoffDocument(stamped).frontmatter.updated_at).toBe("2026-11-02T09:15:00.000Z")
    expect(() => markHandoffAccepted(accepted, "not-a-timestamp")).toThrow(ConsultationError)
  })

  it("flips status between active and archived", () => {
    // given
    const created = createHandoffDocument(makeCreateInput())

    // when
    const archived = setHandoffStatus(created, "archived")
    const revived = setHandoffStatus(archived, "active")

    // then
    expect(parseHandoffDocument(archived).frontmatter.status).toBe("archived")
    expect(parseHandoffDocument(revived).frontmatter.status).toBe("active")
  })
})
