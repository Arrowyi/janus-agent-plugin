import { realpathSync } from "node:fs"
import path from "node:path"

import {
  DISPATCH_MARKER,
  DISPATCH_ROLES,
  normalizeDispatchRole,
  type Clock,
  type DispatchPermissionSdk,
  type DispatchRole,
  type DispatchSdk,
  type PendingAsk,
  type PendingAskJobHop,
  type SdkMessageWithParts,
  type SdkPendingPermission,
  type SdkResult,
  type SdkSession,
} from "./dispatch-contract.ts"

/**
 * Permission-ask foundation layer.
 *
 * The host emits permission events when a dispatched sub-session hits an
 * approval gate. A sub-session cannot answer its own ask, so the plugin
 * records asks in a process-wide registry, escalates the still-pending ones
 * to the top-level caller on the next dispatch envelope, and answers them
 * through `janus_permission_reply`. This module owns that registry, the
 * host-surface adapter, the shared lineage walk, the production pending-asks
 * probe, and the event hook that feeds the registry.
 */

/** How long a pull outage may be bridged from registry history before fail-closed. */
export const REGISTRY_OUTAGE_GRACE_MS = 60_000
/** Damping window for re-yielding after a wake when nothing new arrived. */
export const RE_YIELD_DAMPING_MS = 10_000
/** Maximum upward parent hops a lineage walk may take before it fails closed. */
export const MAX_LINEAGE_DEPTH = 10
/** Maximum length of one sanitized permission pattern. */
export const MAX_PATTERN_LENGTH = 512
/** Maximum number of sanitized permission patterns kept per ask. */
export const MAX_PATTERNS_COUNT = 16
/** Ask-history LRU capacity. */
export const MAX_ASK_HISTORY = 256

const CONTROL_CHARS = /[\x00-\x1F\x7F]/g
const MAX_PERMISSION_LENGTH = 64
const MAX_TOAST_LENGTH = 120

export interface PendingAskSurfaced {
  readonly callerSessionID: string
  readonly surfacedAtUserMessageID: string | undefined
  readonly surfacedAt: number
}

/** One recorded ask; the same object is referenced from the active map and history. */
export interface PermissionAskEntry {
  readonly requestID: string
  sessionID: string
  directory: string
  permission: string
  patterns: string[]
  readonly firstSeenAt: number
  lastSeenAt: number
  surfaced?: PendingAskSurfaced
  replied?: boolean
}

export interface PendingAskInput {
  readonly requestID: string
  readonly sessionID: string
  readonly directory: string
  readonly permission: string
  readonly patterns: ReadonlyArray<string>
}

export interface CoordinatorTurnEnded {
  readonly coordinatorSessionID: string
  readonly descendantJobIDs: ReadonlyArray<string>
}

interface WakeListener {
  resolve(): void
}

function stripControlChars(value: string): string {
  return value.replace(CONTROL_CHARS, "")
}

function canonicalKey(directory: string): string {
  return canonicalizeDirectory(directory)
}

/**
 * Canonicalize a workspace directory for registry keying: resolve to an
 * absolute path and prefer the filesystem realpath, falling back to a
 * normalized absolute path when the path cannot be resolved (e.g. a deleted
 * directory or a permission-denied ancestor).
 */
export function canonicalizeDirectory(directory: string): string {
  const resolved = path.resolve(directory)
  try {
    return realpathSync(resolved)
  } catch {
    return path.normalize(resolved)
  }
}

function toPatternList(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string")
  if (typeof value === "string") return [value]
  return []
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Normalize one host permission record (V1 or V2 field names) into the
 * plugin's `SdkPendingPermission` shape. Returns undefined for a record that
 * carries no usable id/session identity.
 */
function toSdkPendingPermission(item: unknown): SdkPendingPermission | undefined {
  if (!isRecord(item)) return undefined
  const id = typeof item.id === "string" ? item.id : typeof item.requestID === "string" ? item.requestID : undefined
  const sessionID =
    typeof item.sessionID === "string" ? item.sessionID : isRecord(item.session) && typeof item.session.id === "string" ? item.session.id : undefined
  if (id === undefined || sessionID === undefined) return undefined
  const permission =
    typeof item.permission === "string"
      ? item.permission
      : typeof item.type === "string"
        ? item.type
        : typeof item.action === "string"
          ? item.action
          : "unknown"
  const patterns = toPatternList(item.patterns ?? item.pattern ?? item.resources)
  const createdAt =
    isRecord(item.time) && typeof item.time.created === "number"
      ? item.time.created
      : typeof item.createdAt === "number"
        ? item.createdAt
        : undefined
  const metadata = isRecord(item.metadata) ? item.metadata : undefined
  return {
    id,
    sessionID,
    permission,
    patterns,
    ...(metadata !== undefined ? { metadata } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
  }
}

function normalizeAskList(result: unknown): SdkResult<ReadonlyArray<SdkPendingPermission>> {
  if (isRecord(result) && "error" in result && result.error !== undefined) {
    return { error: result.error }
  }
  let raw: unknown = isRecord(result) && "data" in result ? result.data : result
  if (isRecord(raw) && Array.isArray(raw.data)) raw = raw.data
  if (!Array.isArray(raw)) return { data: [] }
  const asks: SdkPendingPermission[] = []
  for (const item of raw) {
    const mapped = toSdkPendingPermission(item)
    if (mapped !== undefined) asks.push(mapped)
  }
  return { data: asks }
}

function normalizeReplyResult(result: unknown): SdkResult<boolean> {
  if (isRecord(result) && "error" in result && result.error !== undefined) {
    return { error: result.error }
  }
  const value = isRecord(result) && "data" in result ? result.data : result
  return { data: value !== false }
}

interface ListReplySurface {
  readonly list?: (...args: never[]) => unknown
  readonly reply?: (...args: never[]) => unknown
}

function asListReplySurface(value: unknown): ListReplySurface | undefined {
  if (!isRecord(value)) return undefined
  const list = typeof value.list === "function" ? (value.list as ListReplySurface["list"]) : undefined
  const reply = typeof value.reply === "function" ? (value.reply as ListReplySurface["reply"]) : undefined
  if (list === undefined && reply === undefined) return undefined
  return { ...(list !== undefined ? { list } : {}), ...(reply !== undefined ? { reply } : {}) }
}

function createV2PermissionSdk(
  globalSurface: ListReplySurface | undefined,
  sessionSurface: ListReplySurface | undefined,
): DispatchPermissionSdk {
  return {
    async list(input) {
      if (globalSurface?.list === undefined) return { error: "permission list surface unavailable" }
      try {
        return normalizeAskList(await globalSurface.list({ directory: input.query?.directory } as never))
      } catch (error: unknown) {
        return { error }
      }
    },
    ...(sessionSurface?.list !== undefined
      ? {
          async listForSession(input: { path: { readonly sessionID: string }; query?: { readonly directory?: string } }) {
            try {
              return normalizeAskList(await sessionSurface.list!({ sessionID: input.path.sessionID } as never))
            } catch (error: unknown) {
              return { error }
            }
          },
        }
      : {}),
    async reply(input) {
      const message = input.body.message
      try {
        if (globalSurface?.reply !== undefined) {
          return normalizeReplyResult(
            await globalSurface.reply({
              requestID: input.path.requestID,
              directory: input.query?.directory,
              reply: input.body.reply,
              ...(message !== undefined ? { message } : {}),
            } as never),
          )
        }
        if (sessionSurface?.reply !== undefined) {
          return normalizeReplyResult(
            await sessionSurface.reply({
              sessionID: input.path.sessionID,
              requestID: input.path.requestID,
              reply: input.body.reply,
              ...(message !== undefined ? { message } : {}),
            } as never),
          )
        }
        return { error: "permission reply surface unavailable" }
      } catch (error: unknown) {
        return { error }
      }
    },
  }
}

interface HeyApiTransport {
  readonly get: (input: unknown) => unknown
  readonly post?: (input: unknown) => unknown
}

function asHeyApiTransport(value: unknown): HeyApiTransport | undefined {
  if (!isRecord(value)) return undefined
  if (typeof value.get !== "function") return undefined
  return {
    get: value.get as HeyApiTransport["get"],
    ...(typeof value.post === "function" ? { post: value.post as NonNullable<HeyApiTransport["post"]> } : {}),
  }
}

function createHeyApiPermissionSdk(
  transport: HeyApiTransport,
  sessionReply: ((input: unknown) => unknown) | undefined,
): DispatchPermissionSdk {
  return {
    async list(input) {
      try {
        return normalizeAskList(await transport.get({ url: "/permission", query: { directory: input.query?.directory } }))
      } catch (error: unknown) {
        return { error }
      }
    },
    async listForSession(input) {
      try {
        return normalizeAskList(
          await transport.get({
            url: `/api/session/${encodeURIComponent(input.path.sessionID)}/permission`,
            query: { directory: input.query?.directory },
          }),
        )
      } catch (error: unknown) {
        return { error }
      }
    },
    async reply(input) {
      const message = input.body.message
      const body = { reply: input.body.reply, ...(message !== undefined ? { message } : {}) }
      try {
        if (transport.post !== undefined) {
          return normalizeReplyResult(
            await transport.post({
              url: `/permission/${encodeURIComponent(input.path.requestID)}/reply`,
              query: { directory: input.query?.directory },
              body,
            }),
          )
        }
        if (sessionReply !== undefined) {
          return normalizeReplyResult(
            await sessionReply({
              path: { id: input.path.sessionID, permissionID: input.path.requestID },
              body: { response: input.body.reply },
              query: { directory: input.query?.directory },
            }),
          )
        }
        return { error: "permission reply surface unavailable" }
      } catch (error: unknown) {
        return { error }
      }
    },
  }
}

function createSessionReplyOnlyPermissionSdk(sessionReply: (input: unknown) => unknown): DispatchPermissionSdk {
  return {
    async list() {
      return { error: "permission list surface unavailable" }
    },
    async reply(input) {
      try {
        return normalizeReplyResult(
          await sessionReply({
            path: { id: input.path.sessionID, permissionID: input.path.requestID },
            body: { response: input.body.reply },
            query: { directory: input.query?.directory },
          }),
        )
      } catch (error: unknown) {
        return { error }
      }
    },
  }
}

/**
 * Resolve the host permission surface lazily at call time. A host may expose
 * the V2 permission client (`client.permission` and/or
 * `client.v2.session.permission`), the V1 HeyAPI transport
 * (`client._client` / `client.client` with get/post), the V1 session reply
 * endpoint (`client.postSessionIdPermissionsPermissionId`), or none of them.
 * A surface-less client (e.g. an unseeded test fake) yields undefined — never
 * a throw.
 */
export function resolvePermissionSdk(client: unknown): DispatchPermissionSdk | undefined {
  if (client === null || client === undefined || (typeof client !== "object" && typeof client !== "function")) {
    return undefined
  }
  const c = client as Record<string, unknown>
  const v2 = isRecord(c.v2) ? c.v2 : undefined
  const v2Session = v2 !== undefined && isRecord(v2.session) ? v2.session : undefined
  const globalSurface = asListReplySurface(c.permission)
  const sessionSurface = asListReplySurface(v2Session?.permission) ?? asListReplySurface(isRecord(c.session) ? c.session.permission : undefined)
  if (globalSurface !== undefined || sessionSurface !== undefined) {
    return createV2PermissionSdk(globalSurface, sessionSurface)
  }
  const raw = asHeyApiTransport(c._client) ?? asHeyApiTransport(c.client)
  const sessionReply =
    typeof c.postSessionIdPermissionsPermissionId === "function"
      ? (c.postSessionIdPermissionsPermissionId as (input: unknown) => unknown)
      : undefined
  if (raw !== undefined) return createHeyApiPermissionSdk(raw, sessionReply)
  if (sessionReply !== undefined) return createSessionReplyOnlyPermissionSdk(sessionReply)
  return undefined
}

export interface LineageHop {
  readonly id: string
  readonly parentID?: string
  readonly directory: string
  readonly title: string
}

export type LineageWalkReason = "unreadable" | "depth-exceeded" | "directory-mismatch"

export type LineageWalkResult =
  | { readonly ok: true; readonly path: ReadonlyArray<LineageHop> }
  | { readonly ok: false; readonly reason: LineageWalkReason; readonly path: ReadonlyArray<LineageHop> }

export interface LineageWalkInput {
  readonly startSessionID: string
  readonly directory: string
  readonly maxDepth?: number
  /** Per-observation hop cache; never share across jobs. */
  readonly cache?: Map<string, LineageHop | null>
}

async function readHop(
  sdk: DispatchSdk,
  sessionID: string,
  directory: string | undefined,
  cache: Map<string, LineageHop | null> | undefined,
): Promise<LineageHop | null> {
  const cached = cache?.get(sessionID)
  if (cached !== undefined) return cached
  let hop: LineageHop | null = null
  try {
    // A caller that already knows the workspace passes it so the host can
    // scope the read; a bootstrap read has no directory yet and must NOT send
    // the session id as one.
    const query = directory !== undefined ? { directory } : undefined
    const result = await sdk.session.get(
      query === undefined ? { path: { id: sessionID } } : { path: { id: sessionID }, query },
    )
    if (result.error === undefined && result.data !== undefined) hop = toLineageHop(result.data)
  } catch {
    hop = null
  }
  cache?.set(sessionID, hop)
  return hop
}

function toLineageHop(session: SdkSession): LineageHop {
  return {
    id: session.id,
    ...(session.parentID !== undefined ? { parentID: session.parentID } : {}),
    directory: session.directory,
    title: session.title,
  }
}

/**
 * The single shared upward `parentID` walker. Starts at `startSessionID`,
 * reads every hop through `sdk.session.get`, and fails closed on an unreadable
 * hop, a cross-workspace hop, or more than `maxDepth` (default
 * `MAX_LINEAGE_DEPTH`) nodes. A partial path is returned alongside a failure
 * so callers can degrade rather than throw.
 */
export async function walkParentLineage(sdk: DispatchSdk, input: LineageWalkInput): Promise<LineageWalkResult> {
  const expectedDirectory = canonicalizeDirectory(input.directory)
  const maxDepth = input.maxDepth ?? MAX_LINEAGE_DEPTH
  const path: LineageHop[] = []
  let currentID: string | undefined = input.startSessionID
  while (currentID !== undefined) {
    if (path.length >= maxDepth) {
      return { ok: false, reason: "depth-exceeded", path }
    }
    const hop = await readHop(sdk, currentID, input.directory, input.cache)
    if (hop === null) return { ok: false, reason: "unreadable", path }
    if (canonicalizeDirectory(hop.directory) !== expectedDirectory) {
      return { ok: false, reason: "directory-mismatch", path }
    }
    path.push(hop)
    currentID = hop.parentID
  }
  return { ok: true, path }
}

function roleFromJobRootTitle(title: string): DispatchRole | undefined {
  if (!title.startsWith(DISPATCH_MARKER)) return undefined
  const suffix = title.slice(DISPATCH_MARKER.length)
  return normalizeDispatchRole(suffix)
}

function isAttemptTitleFor(title: string, role: DispatchRole): boolean {
  return title === `${DISPATCH_MARKER}attempt ${role}`
}

/**
 * Build the job nesting chain for one observed job: hop 0 is the observed job
 * itself; each outer dispatch job root found in the upward path contributes a
 * hop paired with its attempt child when that child sits directly below it.
 */
async function buildJobChain(
  sdk: DispatchSdk,
  context: { readonly jobID: string; readonly childSessionID: string; readonly role: DispatchRole; readonly directory: string },
  cache: Map<string, LineageHop | null>,
): Promise<PendingAskJobHop[]> {
  const chain: PendingAskJobHop[] = [{ job_id: context.jobID, role: context.role, session_id: context.childSessionID }]
  const walk = await walkParentLineage(sdk, {
    startSessionID: context.jobID,
    directory: context.directory,
    cache,
  })
  const ancestry = walk.path
  for (let i = 1; i + 1 < ancestry.length; i++) {
    const child = ancestry[i]
    const parent = ancestry[i + 1]
    if (child === undefined || parent === undefined) break
    const role = roleFromJobRootTitle(parent.title)
    if (role !== undefined && isAttemptTitleFor(child.title, role)) {
      chain.push({ job_id: parent.id, role, session_id: child.id })
      i++
    }
  }
  return chain
}

async function readCancelIntentTimes(
  sdk: DispatchSdk,
  jobID: string,
  directory: string,
  cache: Map<string, number[]>,
): Promise<number[]> {
  const cached = cache.get(jobID)
  if (cached !== undefined) return cached
  const intents: number[] = []
  try {
    const result = await sdk.session.messages({ path: { id: jobID }, query: { directory } })
    if (result.error === undefined && result.data !== undefined) {
      for (const message of result.data) {
        for (const part of message.parts) {
          if (part.type !== "text" || part.synthetic !== true || part.ignored !== true) continue
          let parsed: unknown
          try {
            parsed = JSON.parse(part.text)
          } catch {
            continue
          }
          if (
            isRecord(parsed) &&
            parsed.kind === "cancel-intent" &&
            typeof parsed.intent_at === "number" &&
            parsed.job_id === jobID
          ) {
            intents.push(parsed.intent_at)
          }
        }
      }
    }
  } catch {
    // Fail open to "no persisted intent": never crash the probe on a read.
  }
  cache.set(jobID, intents)
  return intents
}

/**
 * True when `parentID` is itself a dispatched sub-session (so an ask must keep
 * escalating upward rather than surface to it). Returns "unknown" when the
 * session read fails; the caller treats unknown as not-yet-known and delays
 * the early-yield decision.
 */
export async function isDispatchedSubsessionCaller(
  sdk: DispatchSdk,
  askRegistry: PermissionAskRegistry,
  parentID: string | undefined,
): Promise<boolean | "unknown"> {
  if (parentID === undefined) return false
  if (askRegistry.dispatchedSessionIDs.has(parentID)) return true
  try {
    const result = await sdk.session.get({ path: { id: parentID } })
    if (result.error !== undefined || result.data === undefined) return "unknown"
    return result.data.title.startsWith(DISPATCH_MARKER) || result.data.parentID !== undefined
  } catch {
    return "unknown"
  }
}

/**
 * True when every recorded ask already carries a surfacing watermark for this
 * caller and the caller's current last human message — i.e. nothing new to
 * surface in this turn.
 */
export function allAlreadySurfacedInCurrentTurn(
  entries: ReadonlyArray<PermissionAskEntry>,
  lastHumanUserMessageID: string | undefined,
  callerSessionID: string,
): boolean {
  if (entries.length === 0) return false
  if (lastHumanUserMessageID === undefined) return false
  return entries.every(
    (entry) =>
      entry.surfaced !== undefined &&
      entry.surfaced.callerSessionID === callerSessionID &&
      entry.surfaced.surfacedAtUserMessageID === lastHumanUserMessageID,
  )
}

/**
 * The single owner of D3 sanitization for pending asks: strip ASCII control
 * characters, cap permission/pattern lengths and pattern count, default an
 * empty pattern list to `["*"]`, and floor the age to a non-negative integer.
 */
export function sanitizePendingAsk(input: SanitizePendingAskInput, now: number): PendingAsk {
  const requestID = stripControlChars(input.requestID)
  const sessionID = stripControlChars(input.sessionID)
  const permission = stripControlChars(input.permission).slice(0, MAX_PERMISSION_LENGTH) || "unknown"
  const patterns = sanitizePatterns(input.patterns)
  const age = Math.floor(now - input.firstSeenAt)
  const ageMs = Number.isFinite(age) && age > 0 ? age : 0
  const jobChain = input.job_chain.map((hop) => ({
    job_id: stripControlChars(hop.job_id),
    role: hop.role,
    session_id: stripControlChars(hop.session_id),
  }))
  // Zod's `.nonempty()` infers a non-empty tuple; the runtime arrays are
  // guaranteed non-empty by the fallbacks above.
  const safePatterns = patterns as unknown as PendingAsk["patterns"]
  const safeChain = (
    jobChain.length > 0 ? jobChain : [{ job_id: "unknown", role: input.job_chain[0]?.role ?? "coder", session_id: "unknown" }]
  ) as unknown as PendingAsk["job_chain"]
  return {
    requestID: requestID.length > 0 ? requestID : "unknown",
    sessionID: sessionID.length > 0 ? sessionID : "unknown",
    permission,
    patterns: safePatterns,
    age_ms: ageMs,
    job_chain: safeChain,
  }
}

export interface SanitizePendingAskInput {
  readonly requestID: string
  readonly sessionID: string
  readonly permission: string
  readonly patterns: ReadonlyArray<string>
  readonly firstSeenAt: number
  readonly job_chain: ReadonlyArray<PendingAskJobHop>
}

function sanitizePatterns(patterns: ReadonlyArray<string>): string[] {
  const sanitized: string[] = []
  for (const pattern of patterns) {
    const cleaned = stripControlChars(pattern).slice(0, MAX_PATTERN_LENGTH)
    if (cleaned.length > 0) sanitized.push(cleaned)
    if (sanitized.length >= MAX_PATTERNS_COUNT) break
  }
  return sanitized.length > 0 ? sanitized : ["*"]
}

/**
 * Positive definition of the newest real human user message: a `user` message
 * that the plugin did not inject, carries a non-synthetic non-empty text part,
 * and is neither a compaction nor a subtask. A synthetic `@file` part does not
 * disqualify a message that also has real text.
 */
export function findLastHumanUserMessageID(
  messages: ReadonlyArray<SdkMessageWithParts>,
  pluginInjectedMessageIDs: ReadonlySet<string>,
): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message === undefined) continue
    const info = message.info
    if (info.role !== "user") continue
    if (pluginInjectedMessageIDs.has(info.id)) continue
    const parts = message.parts
    if (parts.some((part) => part.type === "compaction" || part.type === "subtask")) continue
    const hasRealText = parts.some(
      (part) => part.type === "text" && part.synthetic !== true && part.ignored !== true && part.text.trim().length > 0,
    )
    if (hasRealText) return info.id
  }
  return undefined
}

export interface PendingAskProbeContext {
  readonly jobID: string
  readonly childSessionID: string
  readonly parentID: string | undefined
  readonly role: DispatchRole
}

/**
 * One probe observation. `asks` always carries the sanitized relevant asks,
 * even when the caller is a dispatched sub-session or the asks were already
 * surfaced this turn — those are caller-side decisions (hold / re-yield) the
 * M2 observer makes from the exposed status fields, never a reason to drop an
 * ask silently. `isDispatchedSubsessionCaller` is `"unknown"` when the caller
 * read fails, letting the consumer delay rather than guess.
 */
export interface PendingAsksProbeResult {
  /** Sanitized relevant asks after cancel-epoch, persisted-intent and outage-grace filtering. */
  readonly asks: ReadonlyArray<PendingAsk>
  readonly isDispatchedSubsessionCaller: boolean | "unknown"
  readonly allAlreadySurfacedInCurrentTurn: boolean
}

export type PendingAsksProbe = (context: PendingAskProbeContext) => Promise<PendingAsksProbeResult>

/**
 * Build the production pending-asks probe. Each call is one job observation
 * with its own hop and cancel-intent caches (never shared across jobs).
 */
export function createPendingAsksProbe(
  client: unknown,
  askRegistry: PermissionAskRegistry,
  clock: Clock,
): PendingAsksProbe {
  const sdk = client as DispatchSdk
  return async (context: PendingAskProbeContext): Promise<PendingAsksProbeResult> => {
    const hopCache = new Map<string, LineageHop | null>()
    const cancelIntentCache = new Map<string, number[]>()
    // Bootstrap without a directory: the job id is a session id, never a
    // filesystem path. Every later walk uses the real directory the hop
    // carries back.
    const root = await readHop(sdk, context.jobID, undefined, hopCache)
    if (root === null) {
      return {
        asks: [],
        isDispatchedSubsessionCaller: await isDispatchedSubsessionCaller(sdk, askRegistry, context.parentID),
        allAlreadySurfacedInCurrentTurn: false,
      }
    }
    const directory = root.directory

    const permissionSdk = resolvePermissionSdk(client)
    let pullSucceeded = false
    if (permissionSdk !== undefined) {
      const pullStartedAt = clock.now()
      let pulled: ReadonlyArray<SdkPendingPermission> | undefined
      const globalResult = await permissionSdk.list({ query: { directory } })
      if (globalResult.error === undefined && globalResult.data !== undefined) {
        pulled = globalResult.data
      } else if (permissionSdk.listForSession !== undefined) {
        const sessionResult = await permissionSdk.listForSession({
          path: { sessionID: context.childSessionID },
          query: { directory },
        })
        if (sessionResult.error === undefined && sessionResult.data !== undefined) pulled = sessionResult.data
      }
      if (pulled !== undefined) {
        askRegistry.reconcileWithPull(directory, pulled, pullStartedAt, clock.now())
        pullSucceeded = true
      }
    }

    const jobChain = await buildJobChain(sdk, { ...context, directory }, hopCache)
    const now = clock.now()
    const active = askRegistry.getActive(directory)
    // On a pull outage the registry is the only source; surface only entries
    // seen within the shared outage grace window, and drop staler ones so the
    // probe never escalates an ask the host may have resolved long ago.
    const visible = pullSucceeded
      ? active
      : active.filter((entry) => now - entry.lastSeenAt <= REGISTRY_OUTAGE_GRACE_MS)
    const relevant: PermissionAskEntry[] = []
    for (const entry of visible) {
      if (!(await askBelongsToJob(sdk, entry, context, directory, hopCache))) continue
      if (await askIsCancelled(askRegistry, sdk, entry, jobChain, directory, cancelIntentCache)) continue
      relevant.push(entry)
    }

    const callerStatus = await isDispatchedSubsessionCaller(sdk, askRegistry, context.parentID)
    const lastHuman =
      relevant.length > 0 && context.parentID !== undefined
        ? await readLastHumanUserMessageID(sdk, context.parentID, directory, askRegistry)
        : undefined
    const allSurfaced =
      context.parentID !== undefined && allAlreadySurfacedInCurrentTurn(relevant, lastHuman, context.parentID)

    const asks = relevant.map((entry) =>
      sanitizePendingAsk(
        {
          requestID: entry.requestID,
          sessionID: entry.sessionID,
          permission: entry.permission,
          patterns: entry.patterns,
          firstSeenAt: entry.firstSeenAt,
          job_chain: jobChain,
        },
        now,
      ),
    )

    return {
      asks,
      isDispatchedSubsessionCaller: callerStatus,
      allAlreadySurfacedInCurrentTurn: allSurfaced,
    }
  }
}

async function readLastHumanUserMessageID(
  sdk: DispatchSdk,
  sessionID: string,
  directory: string,
  askRegistry: PermissionAskRegistry,
): Promise<string | undefined> {
  try {
    const result = await sdk.session.messages({ path: { id: sessionID }, query: { directory } })
    if (result.error !== undefined || result.data === undefined) return undefined
    return findLastHumanUserMessageID(result.data, askRegistry.pluginInjectedMessageIDs)
  } catch {
    return undefined
  }
}

async function askBelongsToJob(
  sdk: DispatchSdk,
  entry: PermissionAskEntry,
  context: PendingAskProbeContext,
  directory: string,
  hopCache: Map<string, LineageHop | null>,
): Promise<boolean> {
  if (entry.sessionID === context.childSessionID || entry.sessionID === context.jobID) return true
  const walk = await walkParentLineage(sdk, { startSessionID: entry.sessionID, directory, cache: hopCache })
  return walk.path.some((hop) => hop.id === context.jobID)
}

async function askIsCancelled(
  askRegistry: PermissionAskRegistry,
  sdk: DispatchSdk,
  entry: PermissionAskEntry,
  jobChain: ReadonlyArray<PendingAskJobHop>,
  directory: string,
  cancelIntentCache: Map<string, number[]>,
): Promise<boolean> {
  for (const hop of jobChain) {
    const cancelledAt = askRegistry.getCancelledAt(hop.job_id)
    if (cancelledAt !== undefined && entry.firstSeenAt <= cancelledAt) return true
    const intents = await readCancelIntentTimes(sdk, hop.job_id, directory, cancelIntentCache)
    if (intents.some((intentAt) => intentAt >= entry.firstSeenAt)) return true
  }
  return false
}

interface PermissionEvent {
  readonly type: string
  readonly properties?: unknown
}

/** Host event hook that feeds permission asks into the registry. */
export type PermissionEventHook = (input: { readonly event: PermissionEvent }) => Promise<void>

function eventDirectory(properties: Record<string, unknown>): string | undefined {
  return typeof properties.directory === "string" ? properties.directory : undefined
}

async function resolveSessionDirectory(client: unknown, sessionID: string): Promise<string | undefined> {
  const sdk = client as DispatchSdk | undefined
  if (sdk === undefined || sdk === null || typeof sdk.session?.get !== "function") return undefined
  try {
    const result = await sdk.session.get({ path: { id: sessionID } })
    if (result.error !== undefined || result.data === undefined) return undefined
    return result.data.directory
  } catch {
    return undefined
  }
}

function resolveTui(client: unknown): { showToast?: (input: unknown) => unknown } | undefined {
  if (!isRecord(client)) return undefined
  const direct = isRecord(client.tui) ? client.tui : undefined
  if (direct !== undefined) return direct as { showToast?: (input: unknown) => unknown }
  const v2 = isRecord(client.v2) && isRecord(client.v2.tui) ? client.v2.tui : undefined
  return v2 as { showToast?: (input: unknown) => unknown } | undefined
}

/**
 * Event hook for `permission.asked` (+ `permission.updated` /
 * `permission.v2.asked` aliases), `permission.replied` (+
 * `permission.v2.replied`), and `session.deleted`. Best-effort: every host
 * interaction is guarded so an event can never crash the plugin, and the
 * client is resolved lazily inside the handler (never at construction).
 */
export function createPermissionEventHook(
  askRegistry: PermissionAskRegistry,
  client: unknown,
  clock: Clock,
): PermissionEventHook {
  const toasted = new Set<string>()
  return async ({ event }) => {
    const type = event.type
    if (type === "permission.asked" || type === "permission.updated" || type === "permission.v2.asked") {
      await onAskedEvent(askRegistry, client, clock, event.properties, toasted)
      return
    }
    if (type === "permission.replied" || type === "permission.v2.replied") {
      onRepliedEvent(askRegistry, clock, event.properties)
      return
    }
    if (type === "session.deleted") {
      onSessionDeletedEvent(askRegistry, event.properties)
    }
  }
}

async function onAskedEvent(
  askRegistry: PermissionAskRegistry,
  client: unknown,
  clock: Clock,
  properties: unknown,
  toasted: Set<string>,
): Promise<void> {
  if (!isRecord(properties)) return
  const requestID =
    typeof properties.id === "string"
      ? properties.id
      : typeof properties.requestID === "string"
        ? properties.requestID
        : typeof properties.permissionID === "string"
          ? properties.permissionID
          : undefined
  const sessionID = typeof properties.sessionID === "string" ? properties.sessionID : undefined
  if (requestID === undefined || sessionID === undefined) return
  const permission =
    typeof properties.permission === "string"
      ? properties.permission
      : typeof properties.type === "string"
        ? properties.type
        : typeof properties.action === "string"
          ? properties.action
          : "unknown"
  const patterns = toPatternList(properties.patterns ?? properties.pattern ?? properties.resources)
  const directory =
    eventDirectory(properties) ?? (await resolveSessionDirectory(client, sessionID)) ?? process.cwd()
  askRegistry.onAsked({ requestID, sessionID, directory, permission, patterns }, clock.now())
  if (!askRegistry.dispatchedSessionIDs.has(sessionID) || toasted.has(requestID)) return
  toasted.add(requestID)
  await emitToast(client, directory, permission, patterns)
}

async function emitToast(
  client: unknown,
  directory: string,
  permission: string,
  patterns: ReadonlyArray<string>,
): Promise<void> {
  const tui = resolveTui(client)
  if (tui === undefined || typeof tui.showToast !== "function") return
  const patternText = patterns.length > 0 ? ` (${patterns.join(", ")})` : ""
  const message = stripControlChars(`Permission requested: ${permission}${patternText}`).slice(0, MAX_TOAST_LENGTH)
  try {
    await tui.showToast({ body: { message, variant: "warning" }, query: { directory } })
  } catch {
    // Best-effort toast: a TUI failure never affects ask recording.
  }
}

function onRepliedEvent(askRegistry: PermissionAskRegistry, clock: Clock, properties: unknown): void {
  if (!isRecord(properties)) return
  const requestID =
    typeof properties.permissionID === "string"
      ? properties.permissionID
      : typeof properties.requestID === "string"
        ? properties.requestID
        : typeof properties.id === "string"
          ? properties.id
          : undefined
  if (requestID === undefined) return
  askRegistry.onReplied(requestID, clock.now())
}

function onSessionDeletedEvent(askRegistry: PermissionAskRegistry, properties: unknown): void {
  if (!isRecord(properties)) return
  const info = isRecord(properties.info) ? properties.info : undefined
  const sessionID =
    (info !== undefined && typeof info.id === "string" ? info.id : undefined) ??
    (typeof properties.sessionID === "string" ? properties.sessionID : undefined) ??
    (typeof properties.id === "string" ? properties.id : undefined)
  if (sessionID === undefined) return
  askRegistry.removeSession(sessionID)
}

/**
 * One process-wide ask registry. Active asks are keyed per canonical
 * directory; a bounded LRU history records every ask seen (including those
 * already evicted from active) so the reply guard can recognise an
 * already-resolved request.
 */
export class PermissionAskRegistry {
  readonly dispatchedSessionIDs = new Set<string>()
  readonly pluginInjectedMessageIDs = new Set<string>()

  private readonly activeByDirectory = new Map<string, Map<string, PermissionAskEntry>>()
  private readonly askHistory = new Map<string, PermissionAskEntry>()
  private readonly versionByDirectory = new Map<string, number>()
  private readonly wakeListeners = new Map<string, Set<WakeListener>>()
  private readonly cancelEpochs = new Map<string, { at: number; seq: number }>()
  private readonly coordinatorTurnEndedByJob = new Map<string, CoordinatorTurnEnded>()
  private cancelSeq = 0

  onAsked(input: PendingAskInput, now: number): PermissionAskEntry {
    const key = canonicalKey(input.directory)
    const active = this.activeByDirectory.get(key) ?? new Map<string, PermissionAskEntry>()
    this.activeByDirectory.set(key, active)
    const existing = active.get(input.requestID)
    let entry: PermissionAskEntry
    if (existing !== undefined) {
      existing.permission = input.permission
      existing.patterns = [...input.patterns]
      existing.directory = input.directory
      existing.lastSeenAt = now
      entry = existing
    } else {
      entry = {
        requestID: input.requestID,
        sessionID: input.sessionID,
        directory: input.directory,
        permission: input.permission,
        patterns: [...input.patterns],
        firstSeenAt: now,
        lastSeenAt: now,
      }
      active.set(input.requestID, entry)
    }
    this.touchHistory(entry)
    this.bumpVersion(key)
    this.fireWake(key)
    return entry
  }

  getActive(directory: string): ReadonlyArray<PermissionAskEntry> {
    const active = this.activeByDirectory.get(canonicalKey(directory))
    return active === undefined ? [] : [...active.values()]
  }

  getHistory(requestID: string): PermissionAskEntry | undefined {
    const entry = this.askHistory.get(requestID)
    if (entry !== undefined) this.touchHistory(entry)
    return entry
  }

  getVersion(directory: string): number {
    return this.versionByDirectory.get(canonicalKey(directory)) ?? 0
  }

  waitForAskWake(directory: string, seenVersion: number, signal?: AbortSignal): Promise<void> {
    const key = canonicalKey(directory)
    if ((this.versionByDirectory.get(key) ?? 0) > seenVersion) return Promise.resolve()
    if (signal?.aborted === true) {
      return Promise.reject(new DOMException("aborted", "AbortError"))
    }
    return new Promise<void>((resolve, reject) => {
      const listeners = this.wakeListeners.get(key) ?? new Set<WakeListener>()
      this.wakeListeners.set(key, listeners)
      const listener: WakeListener = {
        resolve: () => {
          cleanup()
          resolve()
        },
      }
      const onAbort = (): void => {
        cleanup()
        reject(new DOMException("aborted", "AbortError"))
      }
      const cleanup = (): void => {
        listeners.delete(listener)
        signal?.removeEventListener("abort", onAbort)
      }
      listeners.add(listener)
      signal?.addEventListener("abort", onAbort, { once: true })
    })
  }

  reconcileWithPull(
    directory: string,
    pulledAsks: ReadonlyArray<SdkPendingPermission>,
    pullStartedAt: number,
    now: number,
  ): void {
    const key = canonicalKey(directory)
    const active = this.activeByDirectory.get(key) ?? new Map<string, PermissionAskEntry>()
    this.activeByDirectory.set(key, active)
    const pulledByID = new Map(pulledAsks.map((ask) => [ask.id, ask]))
    for (const [requestID, entry] of [...active]) {
      if (entry.firstSeenAt < pullStartedAt && !pulledByID.has(requestID)) {
        active.delete(requestID)
      }
    }
    for (const ask of pulledByID.values()) {
      const existing = active.get(ask.id)
      if (existing !== undefined) {
        existing.lastSeenAt = now
        this.touchHistory(existing)
        continue
      }
      const entry: PermissionAskEntry = {
        requestID: ask.id,
        sessionID: ask.sessionID,
        directory,
        permission: ask.permission,
        patterns: [...ask.patterns],
        firstSeenAt: now,
        lastSeenAt: now,
      }
      active.set(ask.id, entry)
      this.touchHistory(entry)
    }
  }

  evictActive(directory: string, requestID: string): void {
    this.activeByDirectory.get(canonicalKey(directory))?.delete(requestID)
  }

  markSurfaced(requestID: string, surfaced: PendingAskSurfaced): void {
    const entry = this.askHistory.get(requestID)
    if (entry === undefined) return
    if (entry.surfaced !== undefined) return
    entry.surfaced = surfaced
    this.touchHistory(entry)
  }

  onReplied(requestID: string, now: number): void {
    const entry = this.askHistory.get(requestID)
    if (entry === undefined) return
    entry.replied = true
    entry.lastSeenAt = now
    this.activeByDirectory.get(canonicalKey(entry.directory))?.delete(requestID)
    this.touchHistory(entry)
  }

  markCancelEpoch(sessionOrJobID: string, now: number): void {
    this.cancelSeq += 1
    this.cancelEpochs.set(sessionOrJobID, { at: now, seq: this.cancelSeq })
  }

  getCancelledAt(nodeID: string): number | undefined {
    return this.cancelEpochs.get(nodeID)?.at
  }

  clearSessionCancelled(sessionID: string): void {
    this.cancelEpochs.delete(sessionID)
  }

  recordCoordinatorTurnEnded(jobID: string, value: CoordinatorTurnEnded): void {
    this.coordinatorTurnEndedByJob.set(jobID, value)
  }

  peekCoordinatorTurnEnded(jobID: string): CoordinatorTurnEnded | undefined {
    return this.coordinatorTurnEndedByJob.get(jobID)
  }

  consumeCoordinatorTurnEnded(jobID: string): CoordinatorTurnEnded | undefined {
    const value = this.coordinatorTurnEndedByJob.get(jobID)
    this.coordinatorTurnEndedByJob.delete(jobID)
    return value
  }

  removeSession(sessionID: string): void {
    for (const [key, active] of this.activeByDirectory) {
      for (const [requestID, entry] of [...active]) {
        if (entry.sessionID === sessionID) active.delete(requestID)
      }
      if (active.size === 0) this.activeByDirectory.delete(key)
    }
    for (const [requestID, entry] of [...this.askHistory]) {
      if (entry.sessionID === sessionID) this.askHistory.delete(requestID)
    }
    this.dispatchedSessionIDs.delete(sessionID)
    this.cancelEpochs.delete(sessionID)
    for (const [jobID, value] of [...this.coordinatorTurnEndedByJob]) {
      if (
        jobID === sessionID ||
        value.coordinatorSessionID === sessionID ||
        value.descendantJobIDs.includes(sessionID)
      ) {
        this.coordinatorTurnEndedByJob.delete(jobID)
      }
    }
  }

  private touchHistory(entry: PermissionAskEntry): void {
    this.askHistory.delete(entry.requestID)
    this.askHistory.set(entry.requestID, entry)
    while (this.askHistory.size > MAX_ASK_HISTORY) {
      const oldest = this.askHistory.keys().next()
      if (oldest.done === true) break
      this.askHistory.delete(oldest.value)
    }
  }

  private bumpVersion(key: string): void {
    this.versionByDirectory.set(key, (this.versionByDirectory.get(key) ?? 0) + 1)
  }

  private fireWake(key: string): void {
    const listeners = this.wakeListeners.get(key)
    if (listeners === undefined) return
    this.wakeListeners.delete(key)
    for (const listener of listeners) listener.resolve()
  }
}
