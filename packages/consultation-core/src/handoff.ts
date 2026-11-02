import { z } from "zod"

import { ConsultationError, ConsultationErrorCode } from "./errors.ts"

/**
 * Cross-team handoff document contract (`handoff.md`).
 *
 * A handoff document lives at
 * `$XDG_DATA_HOME/janus-agent/handoff/<projectId>/<handoffId>/handoff.md` and
 * carries only the current truth and the hop ledger between primary entries —
 * never team-internal discussion or raw retrieval noise. Fixed layout:
 *
 *   --- YAML frontmatter ---
 *   ## 1. Current Truth Snapshot        (≤ 80 lines, refreshed in place)
 *   ## 2. Handoff Ledger (Newest First) (latest `### Hop N` on top)
 *
 * A receiver reads the first `HANDOFF_READ_WINDOW_LINES` lines and holds the
 * complete current snapshot plus the latest hops, regardless of how many hops
 * the ledger accumulated. `handoff_id` is filesystem-safe by schema so a
 * parsed (possibly imported) document can never address a path outside its
 * handoff directory.
 */

export const HANDOFF_SNAPSHOT_HEADER = "## 1. Current Truth Snapshot"
export const HANDOFF_LEDGER_HEADER = "## 2. Handoff Ledger (Newest First)"
export const HANDOFF_FACTS_HEADER = "### Confirmed Facts & Constraints"
export const HANDOFF_QUESTIONS_HEADER = "### Open Questions for Next Team"
export const HANDOFF_POINTERS_HEADER = "### Artifact Pointers (Link Only)"

/** Hard line cap on the snapshot section (design D2: ≤ 80 lines). */
export const HANDOFF_SNAPSHOT_MAX_LINES = 80
/** Fixed read window: the receiver mounts a handoff by reading this many lines. */
export const HANDOFF_READ_WINDOW_LINES = 120
/** Pointer lines are paths plus a hop marker, never copied document bodies. */
const HANDOFF_POINTER_MAX_LINE_LENGTH = 200

/** Filesystem-safe, collision-friendly kebab-case id (blocks `..` and `/`). */
export const HANDOFF_ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/

const HANDOFF_ID_MAX_LENGTH = 64

/** Teams a handoff can currently sit with (the current_team / toRole enum). */
export const HandoffTeamSchema = z.enum(["consultant", "architect", "coder", "author"])
/** Roles that may appear as a hop source, including the janus front desk. */
export const HandoffRoleSchema = z.enum(["janus", "consultant", "architect", "coder", "author"])
export const HandoffStatusSchema = z.enum(["active", "archived"])
export const HandoffHopStateSchema = z.enum(["proposed", "accepted"])

export type HandoffTeam = z.infer<typeof HandoffTeamSchema>
export type HandoffRole = z.infer<typeof HandoffRoleSchema>
export type HandoffStatus = z.infer<typeof HandoffStatusSchema>
export type HandoffHopState = z.infer<typeof HandoffHopStateSchema>

export const HandoffFrontmatterSchema = z.object({
  handoff_id: z
    .string()
    .max(HANDOFF_ID_MAX_LENGTH)
    .regex(HANDOFF_ID_PATTERN, "must be lowercase kebab-case (a-z, 0-9, -)"),
  title: z.string().min(1),
  status: HandoffStatusSchema,
  current_team: HandoffTeamSchema,
  hop_state: HandoffHopStateSchema,
  hop_count: z.coerce.number().int().min(1),
  updated_at: z.string().datetime(),
})
export type HandoffFrontmatter = z.infer<typeof HandoffFrontmatterSchema>

/** One hop handed to the next primary entry; `snapshot` replaces section 1. */
export const HandoffHopInputSchema = z.object({
  fromRole: HandoffRoleSchema,
  toRole: HandoffTeamSchema,
  reason: z.string().min(1),
  timestamp: z.string().datetime(),
  factRefs: z.array(z.string().min(1)).default([]),
  questionRefs: z.array(z.string().min(1)).default([]),
  /** Full replacement body for `## 1. Current Truth Snapshot`; omit to keep. */
  snapshot: z.string().optional(),
})
export type HandoffHopInput = z.infer<typeof HandoffHopInputSchema>

/** Lazy-creation input: the first hop plus the initial truth snapshot. */
export const CreateHandoffInputSchema = HandoffHopInputSchema.extend({
  handoffId: z
    .string()
    .max(HANDOFF_ID_MAX_LENGTH)
    .regex(HANDOFF_ID_PATTERN, "must be lowercase kebab-case (a-z, 0-9, -)"),
  title: z.string().min(1),
  snapshot: z.string().min(1),
})
export type CreateHandoffInput = z.infer<typeof CreateHandoffInputSchema>

const FACT_LINE_RE = /^- \[F(\d+)\] \((verified|inferred|unverifiable), basis: .+\)/
const FACT_SUPERSEDES_RE = /, supersedes: F\d+\)/
const QUESTION_LINE_RE = /^- \[Q\d+( -> [a-z]+)?\]/
const POINTER_LINE_RE = /^- \S+: \S+/
const HOP_HEADING_RE = /^### Hop (\d+): (\w+) -> (\w+) \(([^)]+)\)$/
const FRONTMATTER_BLOCK_RE = /^---\n([\s\S]*?)\n---\n?/

function fail(message: string): never {
  throw new ConsultationError(ConsultationErrorCode.VALIDATION_FAILED, message)
}

function parseOrThrow<S extends z.ZodTypeAny>(schema: S, value: unknown, what: string): z.output<S> {
  const result = schema.safeParse(value)
  if (!result.success) {
    const detail = result.error.issues
      .map((issue) => `${issue.path.join(".") || what}: ${issue.message}`)
      .join("; ")
    return fail(`invalid handoff ${what}: ${detail}`)
  }
  return result.data
}

/**
 * Validate the body of `## 1. Current Truth Snapshot`:
 * ≤ 80 lines, the three subsection headers in order, fact entries with a
 * required epistemic label (`verified | inferred | unverifiable`) and a
 * required `basis:`, unique fact ids, well-formed `supersedes` markers, and
 * pointer lines that are path references rather than copied document bodies.
 */
export function validateHandoffSnapshot(snapshot: string): void {
  const text = snapshot.trim()
  if (text.length === 0) fail("handoff snapshot is empty")

  const lines = text.split("\n")
  if (lines.length > HANDOFF_SNAPSHOT_MAX_LINES) {
    fail(`handoff snapshot is ${lines.length} lines, over the ${HANDOFF_SNAPSHOT_MAX_LINES}-line cap`)
  }

  const factsIdx = lines.indexOf(HANDOFF_FACTS_HEADER)
  const questionsIdx = lines.indexOf(HANDOFF_QUESTIONS_HEADER)
  const pointersIdx = lines.indexOf(HANDOFF_POINTERS_HEADER)
  if (factsIdx < 0 || questionsIdx < 0 || pointersIdx < 0) {
    fail("handoff snapshot must contain the Confirmed Facts / Open Questions / Artifact Pointers subsections")
  }
  if (!(factsIdx < questionsIdx && questionsIdx < pointersIdx)) {
    fail("handoff snapshot subsections must appear in the fixed order facts, questions, pointers")
  }
  for (const line of lines.slice(0, factsIdx)) {
    if (line.trim().length > 0) fail("handoff snapshot must start with the facts subsection")
  }

  const seenFactIds = new Set<string>()
  for (const line of lines.slice(factsIdx + 1, questionsIdx)) {
    if (line.trim().length === 0) continue
    const match = FACT_LINE_RE.exec(line)
    if (match === null) {
      fail(`fact line must carry an id, an epistemic label, and a basis: ${JSON.stringify(line)}`)
    }
    if (/supersedes/.test(line) && !FACT_SUPERSEDES_RE.test(line)) {
      fail(`superseded facts must be marked \`supersedes: F<n>\` inside the label parens: ${JSON.stringify(line)}`)
    }
    const factId = `F${match[1]}`
    if (seenFactIds.has(factId)) fail(`duplicate fact id ${factId} in the snapshot`)
    seenFactIds.add(factId)
  }

  for (const line of lines.slice(questionsIdx + 1, pointersIdx)) {
    if (line.trim().length === 0) continue
    if (!QUESTION_LINE_RE.test(line)) {
      fail(`open-question line must be a \`[Q<n>](- <target>)\` entry: ${JSON.stringify(line)}`)
    }
  }

  for (const line of lines.slice(pointersIdx + 1)) {
    if (line.trim().length === 0) continue
    if (!POINTER_LINE_RE.test(line)) {
      fail(`artifact-pointer line must be a \`name: path\` entry: ${JSON.stringify(line)}`)
    }
    if (line.length > HANDOFF_POINTER_MAX_LINE_LENGTH) {
      fail("artifact-pointer line is too long — link the artifact path, never copy its body")
    }
  }
}

export interface ParsedHandoffHop {
  n: number
  fromRole: HandoffRole
  toRole: HandoffTeam
  timestamp: string
  /** List lines only (`- Reason: ...`, `- Facts: ...`, `- Questions: ...`). */
  body: string
}

export interface ParsedHandoffDocument {
  frontmatter: HandoffFrontmatter
  snapshot: string
  /** Newest first, exactly as laid out in the ledger. */
  hops: ParsedHandoffHop[]
}

function parseFrontmatterBlock(markdown: string): { frontmatter: HandoffFrontmatter; body: string } {
  const match = FRONTMATTER_BLOCK_RE.exec(markdown)
  if (match === null) fail("handoff document must start with a YAML frontmatter block")

  const fields = new Map<string, string>()
  for (const line of match[1]!.split("\n")) {
    if (line.trim().length === 0) fail("handoff frontmatter must not contain blank lines")
    const sep = line.indexOf(":")
    if (sep <= 0) fail(`handoff frontmatter line must be \`key: value\`: ${JSON.stringify(line)}`)
    const key = line.slice(0, sep).trim()
    let value = line.slice(sep + 1).trim()
    if (fields.has(key)) fail(`duplicate handoff frontmatter key ${key}`)
    if (value.startsWith('"')) {
      try {
        value = JSON.parse(value) as string
      } catch {
        fail(`unterminated quoted frontmatter value for ${key}`)
      }
    }
    fields.set(key, value)
  }

  const frontmatter = parseOrThrow(HandoffFrontmatterSchema, Object.fromEntries(fields), "frontmatter")
  return { frontmatter, body: markdown.slice(match[0].length) }
}

function parseLedger(lines: string[], hopCount: number): ParsedHandoffHop[] {
  const hops: ParsedHandoffHop[] = []
  let current: { n: number; fromRole: string; toRole: string; timestamp: string; bodyLines: string[] } | null = null

  const pushCurrent = (): void => {
    if (current === null) return
    const body = current.bodyLines.join("\n").trim()
    if (!body.split("\n").some((line) => line.startsWith("- Reason: "))) {
      fail(`Hop ${current.n} is missing its \`- Reason: \` line`)
    }
    for (const line of body.split("\n")) {
      if (line.trim().length > 0 && !line.startsWith("- ")) {
        fail(`Hop ${current.n} body must contain only list lines: ${JSON.stringify(line)}`)
      }
    }
    const fromRole = parseOrThrow(HandoffRoleSchema, current.fromRole, `Hop ${current.n} fromRole`)
    const toRole = parseOrThrow(HandoffTeamSchema, current.toRole, `Hop ${current.n} toRole`)
    const timestamp = parseOrThrow(z.string().datetime(), current.timestamp, `Hop ${current.n} timestamp`)
    hops.push({ n: current.n, fromRole, toRole, timestamp, body })
  }

  for (const line of lines) {
    if (line.startsWith("### ")) {
      pushCurrent()
      const match = HOP_HEADING_RE.exec(line)
      if (match === null) fail(`invalid hop heading: ${JSON.stringify(line)}`)
      current = {
        n: Number(match[1]),
        fromRole: match[2]!,
        toRole: match[3]!,
        timestamp: match[4]!,
        bodyLines: [],
      }
    } else if (current !== null) {
      current.bodyLines.push(line)
    } else if (line.trim().length > 0) {
      fail("the ledger must start directly with a hop heading")
    }
  }
  pushCurrent()

  if (hops.length === 0) fail("the handoff ledger must contain at least one hop")
  for (let index = 0; index < hops.length; index += 1) {
    if (hops[index]!.n !== hopCount - index) {
      fail(`ledger hops must run newest-first from Hop ${hopCount} down to Hop 1`)
    }
  }
  if (hops.length !== hopCount) fail("frontmatter hop_count must equal the number of ledger hops")
  return hops
}

/**
 * Parse and fully validate a handoff document: frontmatter schema, both
 * section headers in order, the snapshot contract, and a newest-first ledger
 * whose hop numbering matches `hop_count`. Throws
 * `ConsultationError(VALIDATION_FAILED)` on any structural violation, so an
 * imported file is accepted only when it satisfies the whole contract.
 */
export function parseHandoffDocument(markdown: string): ParsedHandoffDocument {
  const { frontmatter, body } = parseFrontmatterBlock(markdown)

  const lines = body.split("\n")
  const snapshotIdx = lines.indexOf(HANDOFF_SNAPSHOT_HEADER)
  const ledgerIdx = lines.indexOf(HANDOFF_LEDGER_HEADER)
  if (snapshotIdx < 0 || ledgerIdx < 0) {
    fail(`handoff document must contain the ${HANDOFF_SNAPSHOT_HEADER} and ${HANDOFF_LEDGER_HEADER} sections`)
  }
  if (snapshotIdx > ledgerIdx) fail("the snapshot section must precede the ledger section")
  for (const line of lines.slice(0, snapshotIdx)) {
    if (line.trim().length > 0) fail("no content is allowed before the snapshot section")
  }

  const snapshot = lines.slice(snapshotIdx + 1, ledgerIdx).join("\n").trim()
  validateHandoffSnapshot(snapshot)

  const hops = parseLedger(lines.slice(ledgerIdx + 1), frontmatter.hop_count)
  return { frontmatter, snapshot, hops }
}

function renderFrontmatter(frontmatter: HandoffFrontmatter): string {
  return [
    "---",
    `handoff_id: ${frontmatter.handoff_id}`,
    `title: ${JSON.stringify(frontmatter.title)}`,
    `status: ${frontmatter.status}`,
    `current_team: ${frontmatter.current_team}`,
    `hop_state: ${frontmatter.hop_state}`,
    `hop_count: ${frontmatter.hop_count}`,
    `updated_at: ${frontmatter.updated_at}`,
    "---",
  ].join("\n")
}

type RenderableHop = Pick<
  CreateHandoffInput,
  "fromRole" | "toRole" | "reason" | "timestamp" | "factRefs" | "questionRefs"
>

function renderHopEntry(n: number, hop: RenderableHop): string {
  const lines = [`### Hop ${n}: ${hop.fromRole} -> ${hop.toRole} (${hop.timestamp})`, "", `- Reason: ${hop.reason}`]
  if (hop.factRefs.length > 0) lines.push(`- Facts: ${hop.factRefs.join(", ")}`)
  if (hop.questionRefs.length > 0) lines.push(`- Questions: ${hop.questionRefs.join(", ")}`)
  return lines.join("\n")
}

function renderParsedHop(hop: ParsedHandoffHop): string {
  return `### Hop ${hop.n}: ${hop.fromRole} -> ${hop.toRole} (${hop.timestamp})\n\n${hop.body}`
}

function renderDocument(frontmatter: HandoffFrontmatter, snapshot: string, hopBlocks: string[]): string {
  return [
    renderFrontmatter(frontmatter),
    "",
    HANDOFF_SNAPSHOT_HEADER,
    "",
    snapshot.trim(),
    "",
    HANDOFF_LEDGER_HEADER,
    "",
    hopBlocks.join("\n\n"),
    "",
  ].join("\n")
}

/**
 * Lazily create a handoff document at the first cross-primary handoff (or
 * when janus spots a multi-team compound task): frontmatter with `hop_count:
 * 1`, `status: active`, `hop_state: proposed`, the initial truth snapshot,
 * and Hop 1 at the top of the ledger.
 */
export function createHandoffDocument(input: CreateHandoffInput): string {
  const parsed = parseOrThrow(CreateHandoffInputSchema, input, "creation input")
  validateHandoffSnapshot(parsed.snapshot)
  const frontmatter: HandoffFrontmatter = {
    handoff_id: parsed.handoffId,
    title: parsed.title,
    status: "active",
    current_team: parsed.toRole,
    hop_state: "proposed",
    hop_count: 1,
    updated_at: parsed.timestamp,
  }
  return renderDocument(frontmatter, parsed.snapshot, [renderHopEntry(1, parsed)])
}

/**
 * Append the next hop: insert the newest `### Hop N` directly under the
 * ledger heading (newest first), refresh the frontmatter in place
 * (`hop_count + 1`, `current_team: toRole`, `hop_state: proposed`,
 * `updated_at`), and — when `snapshot` is supplied — replace section 1 with
 * the refreshed truth snapshot (facts superseded in place via
 * `supersedes: F<n>`). The first `HANDOFF_READ_WINDOW_LINES` lines of the
 * result always carry the full snapshot plus the latest hops.
 */
export function prependHandoffHop(markdown: string, hop: HandoffHopInput): string {
  const parsed = parseHandoffDocument(markdown)
  const input = parseOrThrow(HandoffHopInputSchema, hop, "hop input")
  const snapshot = input.snapshot !== undefined ? input.snapshot : parsed.snapshot
  validateHandoffSnapshot(snapshot)

  const n = parsed.frontmatter.hop_count + 1
  const frontmatter: HandoffFrontmatter = {
    ...parsed.frontmatter,
    hop_count: n,
    current_team: input.toRole,
    hop_state: "proposed",
    updated_at: input.timestamp,
  }
  return renderDocument(frontmatter, snapshot, [
    renderHopEntry(n, input),
    ...parsed.hops.map(renderParsedHop),
  ])
}

/**
 * Mark the current hop as accepted by the receiving primary entry (the mount
 * step of the wakeup protocol). `updated_at` is refreshed only when a
 * timestamp is supplied.
 */
export function markHandoffAccepted(markdown: string, timestamp?: string): string {
  const parsed = parseHandoffDocument(markdown)
  const frontmatter: HandoffFrontmatter = {
    ...parsed.frontmatter,
    hop_state: "accepted",
    ...(timestamp !== undefined
      ? { updated_at: parseOrThrow(z.string().datetime(), timestamp, "accept timestamp") }
      : {}),
  }
  return renderDocument(frontmatter, parsed.snapshot, parsed.hops.map(renderParsedHop))
}

/** Flip `status` between `active` and `archived` (manual archive/unarchive). */
export function setHandoffStatus(markdown: string, status: HandoffStatus): string {
  const parsed = parseHandoffDocument(markdown)
  const frontmatter: HandoffFrontmatter = { ...parsed.frontmatter, status }
  return renderDocument(frontmatter, parsed.snapshot, parsed.hops.map(renderParsedHop))
}
