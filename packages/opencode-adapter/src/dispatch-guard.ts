import { normalizeModelKey } from "./agent-registration.ts"
import { resolveRoleModel, type JanusPluginConfig } from "./plugin-config.ts"
import { loadJobModelForGuard } from "./dispatch-journal.ts"
import {
  AUTHOR_REVIEWER_STAGES,
  DISPATCH_MARKER,
  SOLUTION_REVIEWER_STAGES,
  type AuthorReviewerStage,
  type DispatchPermissionSdk,
  type DispatchProtocol,
  type DispatchRole,
  type DispatchSdk,
  type DispatchStage,
  type DispatchTier,
  type PermissionReplyArgs,
  type SdkAssistantMessage,
  type SdkMessageWithParts,
  type SdkPendingPermission,
  type SdkTokenUsage,
} from "./dispatch-contract.ts"
import {
  MAX_LINEAGE_DEPTH,
  REGISTRY_OUTAGE_GRACE_MS,
  canonicalizeDirectory,
  findLastHumanUserMessageID,
  walkParentLineage,
  type PermissionAskRegistry,
} from "./permission-ask.ts"

/**
 * Runtime author-≠-reviewer guard for the dispatch boundary: a review seat
 * must not run on the same model — or the same model family — as the author
 * it reviews. `janus_dispatch` enforces it per dispatch, resolving the
 * reviewer model with the call's own mode/tier options and reading each
 * reviewed coder job's pinned model through a cross-session read-only
 * journal query. `janus_dispatch_continue` enforces it against the target
 * session's durable pinned model, because a continuation never switches
 * models.
 *
 * Trust boundary: `stage` is caller-declared and persisted in the job spec
 * for audit. A caller lying about stage — or about the completeness of
 * `reviews_job_ids` — sits on the same trust boundary as lying about ids at
 * all; the Stage-2 report contract and the plan ledger audit backstop it.
 * The runtime guarantee is exactly: a declared `stage: "final"` implies full
 * validation against the tech-lead and every listed coder job.
 *
 * The documentation reviewer follows the same shape: every `author-reviewer`
 * dispatch declares one of its four stages and lists the `author-writer`
 * jobs it reviews; each listed job must be an author-writer root on a
 * different model family, and a fast-tier review must not undercut a
 * standard-tier writer job except at the `reader` cold-read stage.
 */

const MODEL_FAMILY_PREFIXES: ReadonlyArray<readonly [prefix: string, family: string]> = [
  ["glm", "glm"],
  ["gemini", "gemini"],
  ["kimi", "kimi"],
  ["claude", "anthropic"],
  ["gpt", "openai"],
  ["o1", "openai"],
  ["o3", "openai"],
  ["o4", "openai"],
  ["deepseek", "deepseek"],
  ["grok", "xai"],
  ["qwen", "qwen"],
  ["minimax", "minimax"],
  ["mimo", "mimo"],
  ["hy", "hunyuan"],
  ["step", "stepfun"],
]

/**
 * Map a provider-prefixed model id to its family key. The id is normalized
 * first (provider prefix stripped, alphanumerics only), then matched
 * against the family prefix table. A model that matches no prefix is its
 * own family: its normalized key is returned unchanged, so two different
 * unknown models never collapse into a shared "unknown" family and an
 * exact-model match can never hide behind family aggregation.
 */
export function resolveModelFamily(modelKey: string): string {
  const normalized = normalizeModelKey(modelKey)
  for (const [prefix, family] of MODEL_FAMILY_PREFIXES) {
    if (normalized.startsWith(prefix)) return family
  }
  return normalized
}

/** True when two model ids are the same normalized model or share a family. */
function sameModelOrFamily(a: string, b: string): boolean {
  return normalizeModelKey(a) === normalizeModelKey(b) || resolveModelFamily(a) === resolveModelFamily(b)
}

export type ReviewGuardOutcome = { readonly ok: true } | { readonly ok: false; readonly message: string }

/**
 * Soft watermark threshold: a caller context at or beyond this many tokens
 * gets a checkpoint marker on the dispatch return.
 */
export const CONTEXT_WATERMARK_TOKENS = 250_000

/**
 * Hard ceiling for the coder target: a caller context at or beyond this
 * many tokens must checkpoint before dispatching more coding work, so
 * `janus_dispatch` rejects the dispatch fail-fast instead.
 */
export const CODER_HARD_CEILING_TOKENS = 350_000

/**
 * Tail window for the caller context read. The newest completed assistant
 * message sits at the session's end, so the read keeps to the tail instead
 * of fetching the caller's full history.
 */
export const CALLER_CONTEXT_MESSAGES_LIMIT = 50

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

/**
 * Context size in tokens for one assistant message:
 * `total ?? input + output + reasoning + cache.read + cache.write`.
 * A message with no usage fields — or a zero sum — carries no tokens.
 */
function assistantTokenTotal(tokens: SdkTokenUsage | undefined): number | undefined {
  if (typeof tokens !== "object" || tokens === null) return undefined
  const total = finiteNumber(tokens.total)
  if (total !== undefined) return total > 0 ? total : undefined
  const parts = [
    finiteNumber(tokens.input),
    finiteNumber(tokens.output),
    finiteNumber(tokens.reasoning),
    finiteNumber(tokens.cache?.read),
    finiteNumber(tokens.cache?.write),
  ]
  if (parts.every((part) => part === undefined)) return undefined
  const value = parts.reduce((sum: number, part) => sum + (part ?? 0), 0)
  return value > 0 ? value : undefined
}

/**
 * Read the caller session's current context size in tokens: the newest
 * completed assistant message whose usage is non-zero, scanning backward
 * from the tail. The value follows `total ?? input + output + reasoning +
 * cache.read + cache.write`.
 *
 * Payload boundary: `session.messages` is read in-process inside the plugin
 * host and only the numeric watermark ever enters a tool return — message
 * payloads never reach a model context through this read.
 *
 * Any failure — SDK error, missing data, malformed entries — returns
 * `undefined` silently: reading the watermark must never block a dispatch.
 */
export async function readCallerContextTokens(
  sdk: DispatchSdk,
  sessionID: string,
  directory: string,
): Promise<number | undefined> {
  try {
    const result = await sdk.session.messages({
      path: { id: sessionID },
      query: { directory, limit: CALLER_CONTEXT_MESSAGES_LIMIT },
    })
    const messages: ReadonlyArray<SdkMessageWithParts> | undefined = result.data
    if (result.error !== undefined || messages === undefined) return undefined
    for (let i = messages.length - 1; i >= 0; i--) {
      const info = messages[i]!.info
      if (info.role !== "assistant" || !("parentID" in info) || info.time?.completed === undefined) continue
      const assistant: SdkAssistantMessage = info
      const tokens = assistantTokenTotal(assistant.tokens)
      if (tokens !== undefined) return tokens
    }
    return undefined
  } catch {
    return undefined
  }
}

function pass(): ReviewGuardOutcome {
  return { ok: true }
}

function fail(message: string): ReviewGuardOutcome {
  return { ok: false, message }
}

function modelConflictMessage(
  seat: string,
  reviewerModel: string,
  authorLabel: string,
  authorModel: string,
  detail: string,
  guidance: string,
): string {
  return `${seat} model conflict: reviewer ${reviewerModel} vs ${authorLabel} ${authorModel}${detail} — the review seat must not share a model or model family with the author it reviews; ${guidance}`
}

/**
 * Review-seat tier floor: a fast-tier reviewer must not review a job that ran
 * on a stronger tier. Only an explicit `fast` reviewer is constrained — an
 * absent tier (the default seat) or an equal/upgraded tier passes — and a
 * reviewed job with no recorded tier (a default-seat dispatch) never
 * triggers the floor. When true, narrows `authorTier` to the violated tier.
 */
function reviewerUndercutsAuthorTier(
  reviewerTier: DispatchTier | undefined,
  authorTier: DispatchTier | undefined,
): authorTier is DispatchTier {
  if (reviewerTier !== "fast") return false
  return authorTier === "standard" || authorTier === "deep"
}

function tierFloorMessage(seat: string, authorLabel: string, authorTier: DispatchTier, jobID: string, guidance: string): string {
  return `${seat} tier floor: the review seat runs tier "fast" but ${authorLabel} job ${jobID} ran on tier "${authorTier}" — a fast-tier review seat must not undercut a stronger-tier ${authorLabel} job; ${guidance}`
}

export interface DispatchReviewGuardInput {
  readonly role: DispatchRole
  readonly protocol: DispatchProtocol | undefined
  readonly stage: DispatchStage | undefined
  readonly reviewsJobIDs: ReadonlyArray<string> | undefined
  /** The model this dispatch actually runs (this call's mode/tier options applied). */
  readonly reviewerModel: string | undefined
  /** The tier this dispatch explicitly requested; undefined means the default senior seat. */
  readonly reviewerTier?: DispatchTier
  readonly config: JanusPluginConfig
  readonly directory: string
}

/**
 * Enforce the review-seat guard for a `janus_dispatch` call, before any
 * session is created or prompted. Non-reviewer roles pass without SDK
 * access; a `stage` declared outside the solution-reviewer +
 * code_plan_review combination is rejected as an argument-integrity error.
 */
export async function enforceDispatchReviewGuard(
  sdk: DispatchSdk,
  input: DispatchReviewGuardInput,
): Promise<ReviewGuardOutcome> {
  const guarded =
    input.role === "coder-reviewer" ||
    input.role === "solution-reviewer" ||
    input.role === "author-reviewer" ||
    input.stage !== undefined
  if (!guarded) return pass()
  if (input.role === "author-reviewer") return enforceAuthorReviewer(sdk, input)
  if (input.stage !== undefined && !(input.role === "solution-reviewer" && input.protocol === "code_plan_review")) {
    return fail(
      "stage is only valid for solution-reviewer with protocol code_plan_review or for author-reviewer; remove stage or change the role/protocol",
    )
  }
  if (input.stage !== undefined && !(SOLUTION_REVIEWER_STAGES as readonly string[]).includes(input.stage)) {
    return fail(`solution-reviewer stage must be one of: ${SOLUTION_REVIEWER_STAGES.join(", ")}`)
  }
  if (input.role === "coder-reviewer") {
    return enforceAgainstCoderJobs(sdk, input, {
      seat: "coder-reviewer",
      reviewerModelKey: "coder_reviewer_model",
      idsRequiredMessage:
        "coder-reviewer requires reviews_job_ids: pass the root job_id of each coder task it reviews (the janus_dispatch job_id of the coder work)",
    })
  }
  if (input.protocol === "code_plan_review") {
    return enforceSolutionReviewerCodePlan(sdk, input)
  }
  if (input.protocol === "design_premortem") {
    return enforceAgainstReferenceModel(
      input.reviewerModel,
      resolveRoleModel(input.config, "architect"),
      "architect",
      "architect_model or consultant_model",
    )
  }
  // A solution-reviewer without a protocol: the guard does not fire; later
  // milestones constrain the seat's usage through registration and prompts.
  return pass()
}

async function enforceSolutionReviewerCodePlan(
  sdk: DispatchSdk,
  input: DispatchReviewGuardInput,
): Promise<ReviewGuardOutcome> {
  if (input.stage === undefined) {
    return fail(
      'solution-reviewer with protocol code_plan_review requires stage: "plan" (review the approved plan.md; reviews_job_ids must be omitted) or "final" (review the integrated final diff; reviews_job_ids is required)',
    )
  }
  if (input.stage === "plan") {
    if (input.reviewsJobIDs !== undefined) {
      return fail(
        'solution-reviewer stage "plan" must not carry reviews_job_ids: plan review validates the reviewer against the tech-lead model only; drop reviews_job_ids, or dispatch stage "final" for the integrated-diff review',
      )
    }
    return enforceAgainstReferenceModel(
      input.reviewerModel,
      resolveRoleModel(input.config, "tech-lead"),
      "tech-lead",
      "tech_lead_model",
    )
  }
  const techLeadOutcome = enforceAgainstReferenceModel(
    input.reviewerModel,
    resolveRoleModel(input.config, "tech-lead"),
    "tech-lead",
    "tech_lead_model",
  )
  if (!techLeadOutcome.ok) return techLeadOutcome
  return enforceAgainstCoderJobs(sdk, input, {
    seat: "solution-reviewer",
    reviewerModelKey: "solution_reviewer_model",
    idsRequiredMessage:
      'solution-reviewer stage "final" requires reviews_job_ids: pass the root job_id of each coder task behind the integrated diff',
  })
}

function enforceAgainstReferenceModel(
  reviewerModel: string | undefined,
  authorModel: string,
  authorLabel: string,
  authorModelKeys: string,
): ReviewGuardOutcome {
  if (reviewerModel === undefined || reviewerModel.length === 0) {
    return fail(
      `solution-reviewer model is not pinned, so the reviewer cannot be verified against the ${authorLabel}; pin it via solution_reviewer_model or tier_models and retry`,
    )
  }
  if (sameModelOrFamily(reviewerModel, authorModel)) {
    return fail(
      modelConflictMessage(
        "solution-reviewer",
        reviewerModel,
        authorLabel,
        authorModel,
        "",
        `change the reviewer model (solution_reviewer_model or tier_models) or the ${authorLabel} model (${authorModelKeys} or tier_models) and retry`,
      ),
    )
  }
  return pass()
}

interface CoderJobsCheck {
  readonly seat: "coder-reviewer" | "solution-reviewer"
  readonly reviewerModelKey: string
  readonly idsRequiredMessage: string
}

async function enforceAgainstCoderJobs(
  sdk: DispatchSdk,
  input: DispatchReviewGuardInput,
  check: CoderJobsCheck,
): Promise<ReviewGuardOutcome> {
  const ids = input.reviewsJobIDs
  if (ids === undefined || ids.length === 0) return fail(check.idsRequiredMessage)
  if (input.reviewerModel === undefined || input.reviewerModel.length === 0) {
    return fail(
      `${check.seat} model is not pinned, so the reviewer cannot be verified against the reviewed coder jobs; pin it via ${check.reviewerModelKey} or tier_models and retry`,
    )
  }
  // Invariant: resolveRoleModelChain returns a single model for every role,
  // so only model_chain[0] of a reviewed job is compared. A future
  // multi-model chain must extend this guard (compare every chain entry)
  // before it ships.
  for (const jobID of ids) {
    const loaded = await loadJobModelForGuard(sdk, { jobID, directory: input.directory, expectedRole: "coder" })
    if (!loaded.ok) return fail(`reviews_job_ids entry ${jobID} rejected: ${loaded.message}`)
    if (reviewerUndercutsAuthorTier(input.reviewerTier, loaded.tier)) {
      return fail(
        tierFloorMessage(
          check.seat,
          "coder",
          loaded.tier,
          jobID,
          're-dispatch the review at tier: "standard" (or omit tier to run the default senior seat) and retry',
        ),
      )
    }
    if (loaded.model === null || loaded.model.length === 0) {
      return fail(
        `coder job ${jobID} pins no model (model_chain[0] is null), so the reviewer cannot be verified against it; pin the coder model via coder_model or tier_models and retry`,
      )
    }
    if (sameModelOrFamily(input.reviewerModel, loaded.model)) {
      return fail(
        modelConflictMessage(
          check.seat,
          input.reviewerModel,
          "coder",
          loaded.model,
          ` (job ${jobID})`,
          `change the reviewer model (${check.reviewerModelKey} or tier_models) or the coder model (coder_model or tier_models) and retry`,
        ),
      )
    }
  }
  return pass()
}

function isAuthorReviewerStage(stage: DispatchStage | undefined): stage is AuthorReviewerStage {
  return stage !== undefined && (AUTHOR_REVIEWER_STAGES as readonly string[]).includes(stage)
}

interface AuthorWriterJobsCheck {
  readonly reviewerModel: string | undefined
  readonly reviewerTier: DispatchTier | undefined
  readonly stage: AuthorReviewerStage
  readonly reviewsJobIDs: ReadonlyArray<string> | undefined
  readonly directory: string
  /** Remediation for a tier-floor or model conflict, phrased for dispatch vs continuation. */
  readonly tierGuidance: string
  readonly conflictGuidance: string
}

/**
 * Verify an author-reviewer against every listed author-writer job: each id
 * is an author-writer root, the reviewer runs a different model family, and
 * outside the `reader` cold-read stage a fast reviewer does not undercut a
 * standard-tier writer job.
 */
async function enforceAgainstAuthorWriterJobs(
  sdk: DispatchSdk,
  check: AuthorWriterJobsCheck,
): Promise<ReviewGuardOutcome> {
  const ids = check.reviewsJobIDs
  if (ids === undefined || ids.length === 0) {
    return fail(
      "author-reviewer requires reviews_job_ids: pass the root job_id of each author-writer unit it reviews (the janus_dispatch job_id of the blueprint or drafting work)",
    )
  }
  if (check.reviewerModel === undefined || check.reviewerModel.length === 0) {
    return fail(
      "author-reviewer model is not pinned, so the reviewer cannot be verified against the reviewed author-writer jobs; pin it via author_reviewer_model or tier_models and retry",
    )
  }
  for (const jobID of ids) {
    const loaded = await loadJobModelForGuard(sdk, { jobID, directory: check.directory, expectedRole: "author-writer" })
    if (!loaded.ok) return fail(`reviews_job_ids entry ${jobID} rejected: ${loaded.message}`)
    if (check.stage !== "reader" && reviewerUndercutsAuthorTier(check.reviewerTier, loaded.tier)) {
      return fail(tierFloorMessage("author-reviewer", "author-writer", loaded.tier, jobID, check.tierGuidance))
    }
    if (loaded.model === null || loaded.model.length === 0) {
      return fail(
        `author-writer job ${jobID} pins no model (model_chain[0] is null), so the reviewer cannot be verified against it; pin the writer model via author_writer_model, writer_delegate_model, or tier_models and retry`,
      )
    }
    if (sameModelOrFamily(check.reviewerModel, loaded.model)) {
      return fail(
        modelConflictMessage(
          "author-reviewer",
          check.reviewerModel,
          "author-writer",
          loaded.model,
          ` (job ${jobID})`,
          check.conflictGuidance,
        ),
      )
    }
  }
  return pass()
}

async function enforceAuthorReviewer(sdk: DispatchSdk, input: DispatchReviewGuardInput): Promise<ReviewGuardOutcome> {
  if (!isAuthorReviewerStage(input.stage)) {
    return fail(
      `author-reviewer requires stage: one of ${AUTHOR_REVIEWER_STAGES.map((stage) => `"${stage}"`).join(", ")} (outline = blueprint pre-review, unit = drafted unit or batch, reader = cold read, final = whole document)`,
    )
  }
  if (input.protocol !== undefined) {
    return fail("author-reviewer takes no protocol; remove protocol and declare the review stage instead")
  }
  return enforceAgainstAuthorWriterJobs(sdk, {
    reviewerModel: input.reviewerModel,
    reviewerTier: input.reviewerTier,
    stage: input.stage,
    reviewsJobIDs: input.reviewsJobIDs,
    directory: input.directory,
    tierGuidance: 're-dispatch the review at tier: "standard" (or omit tier to run the default seat) and retry',
    conflictGuidance:
      "change the reviewer model (author_reviewer_model or tier_models) or the writer model (author_writer_model or tier_models) and retry",
  })
}

export interface ContinueReviewGuardInput {
  readonly targetRole: DispatchRole
  readonly targetProtocol: DispatchProtocol | undefined
  /** The target session's durable pinned model (its job spec's model_chain[0]). */
  readonly targetModel: string | null
  /** The target session's durable pinned tier; undefined for default-seat dispatches. */
  readonly targetTier?: DispatchTier
  /** The target session's durable declared review stage. */
  readonly targetStage?: DispatchStage
  readonly reviewsJobIDs: ReadonlyArray<string> | undefined
  readonly config: JanusPluginConfig
  readonly directory: string
}

/**
 * Enforce the review-seat guard for a `janus_dispatch_continue` call, before
 * the target session is prompted. A coder-reviewer session, an
 * author-reviewer session, or a solution-reviewer session carrying the
 * code_plan_review contract, must again prove reviewer ≠ author — including
 * stage "plan" sessions, whose re-review should be a fresh dispatch; the
 * guard stays strict and opens no plan-stage back door.
 */
export async function enforceContinueReviewGuard(
  sdk: DispatchSdk,
  input: ContinueReviewGuardInput,
): Promise<ReviewGuardOutcome> {
  if (input.targetRole === "author-reviewer") {
    if (!isAuthorReviewerStage(input.targetStage)) {
      return fail("author-reviewer target session records no review stage; start a fresh author-reviewer dispatch with a stage")
    }
    if (input.targetModel === null || input.targetModel.length === 0) {
      return fail(
        "author-reviewer target session pins no model, so the reviewer cannot be verified against the reviewed author-writer jobs; start a fresh review dispatch",
      )
    }
    return enforceAgainstAuthorWriterJobs(sdk, {
      reviewerModel: input.targetModel,
      reviewerTier: input.targetTier,
      stage: input.targetStage,
      reviewsJobIDs: input.reviewsJobIDs,
      directory: input.directory,
      tierGuidance:
        'a continuation cannot raise the session\'s pinned tier; start a fresh review dispatch at tier: "standard" (or omit tier to run the default seat)',
      conflictGuidance:
        "pass the author-writer job_id(s) this session actually reviews, or change tier_models or author_reviewer_model and start a fresh review dispatch",
    })
  }
  const coderReviewer = input.targetRole === "coder-reviewer"
  const planContractReviewer = input.targetRole === "solution-reviewer" && input.targetProtocol === "code_plan_review"
  if (!coderReviewer && !planContractReviewer) return pass()
  const seat = coderReviewer ? "coder-reviewer" : "solution-reviewer"
  const reviewerModelKey = coderReviewer ? "coder_reviewer_model" : "solution_reviewer_model"
  const ids = input.reviewsJobIDs
  if (ids === undefined || ids.length === 0) {
    const planHint = planContractReviewer
      ? ' (a stage "plan" review should be re-reviewed through a fresh dispatch; a continuation still requires the full ids)'
      : ""
    return fail(`${seat} continuation requires reviews_job_ids: pass the root job_id of each coder task the session reviews${planHint}`)
  }
  if (input.targetModel === null || input.targetModel.length === 0) {
    return fail(
      `${seat} target session pins no model, so the reviewer cannot be verified against the reviewed coder jobs; start a fresh review dispatch`,
    )
  }
  if (planContractReviewer) {
    const techLeadModel = resolveRoleModel(input.config, "tech-lead")
    if (sameModelOrFamily(input.targetModel, techLeadModel)) {
      return fail(
        modelConflictMessage(
          seat,
          input.targetModel,
          "tech-lead",
          techLeadModel,
          "",
          `change tier_models, ${reviewerModelKey}, or tech_lead_model and start a fresh review dispatch`,
        ),
      )
    }
  }
  // Same single-model chain invariant as the dispatch guard: only
  // model_chain[0] of a reviewed job is compared; a future multi-model
  // chain must extend this guard before it ships.
  for (const jobID of ids) {
    const loaded = await loadJobModelForGuard(sdk, { jobID, directory: input.directory, expectedRole: "coder" })
    if (!loaded.ok) return fail(`reviews_job_ids entry ${jobID} rejected: ${loaded.message}`)
    if (reviewerUndercutsAuthorTier(input.targetTier, loaded.tier)) {
      return fail(
        tierFloorMessage(
          seat,
          "coder",
          loaded.tier,
          jobID,
          'a continuation cannot raise the session\'s pinned tier; start a fresh review dispatch at tier: "standard" (or omit tier to run the default senior seat)',
        ),
      )
    }
    if (loaded.model === null || loaded.model.length === 0) {
      return fail(
        `coder job ${jobID} pins no model (model_chain[0] is null), so the reviewer cannot be verified against it; start a fresh review dispatch`,
      )
    }
    if (sameModelOrFamily(input.targetModel, loaded.model)) {
      return fail(
        modelConflictMessage(
          seat,
          input.targetModel,
          "coder",
          loaded.model,
          ` (job ${jobID})`,
          `pass the coder job_id(s) this session actually reviews, or change tier_models or ${reviewerModelKey} and start a fresh review dispatch`,
        ),
      )
    }
  }
  return pass()
}

// ---------------------------------------------------------------------------
// janus_permission_reply guard (Gates 1–4)
// ---------------------------------------------------------------------------

const DISPATCHED_CALLER_MESSAGE =
  "Error: dispatched sub-session cannot call janus_permission_reply; surface pending_asks to the top-level user-facing caller"

export type PermissionReplyGuardOutcome =
  | { readonly ok: true; readonly action: "reply" }
  | { readonly ok: true; readonly action: "already-resolved"; readonly message: string }
  | { readonly ok: false; readonly message: string }

export interface PermissionReplyGuardInput {
  /** The calling (top-level) session id. */
  readonly sessionID: string
  readonly directory: string
  readonly args: PermissionReplyArgs
  readonly askRegistry: PermissionAskRegistry
  readonly permissionSdk: DispatchPermissionSdk | undefined
  readonly now: number
}

interface PullOutcome {
  readonly succeeded: boolean
  readonly asks: ReadonlyArray<SdkPendingPermission>
}

async function pullPendingAsks(
  permissionSdk: DispatchPermissionSdk | undefined,
  directory: string,
  sessionID: string,
): Promise<PullOutcome> {
  if (permissionSdk !== undefined) {
    try {
      const global = await permissionSdk.list({ query: { directory } })
      if (global.error === undefined && global.data !== undefined) {
        return { succeeded: true, asks: global.data }
      }
    } catch {
      // fall through to the per-session tier
    }
    if (permissionSdk.listForSession !== undefined) {
      try {
        const scoped = await permissionSdk.listForSession({ path: { sessionID }, query: { directory } })
        if (scoped.error === undefined && scoped.data !== undefined) {
          return { succeeded: true, asks: scoped.data }
        }
      } catch {
        // both tiers unavailable
      }
    }
  }
  return { succeeded: false, asks: [] }
}

type RequestResolution =
  | { readonly kind: "proceed" }
  | { readonly kind: "resolved"; readonly message: string }
  | { readonly kind: "fail"; readonly message: string }

/**
 * Gate 2: three-tier requestID→sessionID resolution. POST
 * /permission/{requestID}/reply is keyed by requestID alone, so the request
 * must be pinned to a session before lineage is trusted.
 */
async function resolvePermissionRequest(
  input: PermissionReplyGuardInput,
  pullStartedAt: number,
): Promise<RequestResolution> {
  const requestID = input.args.requestID
  const expectedSessionID = input.args.sessionID
  const now = input.now
  const pull = await pullPendingAsks(input.permissionSdk, input.directory, expectedSessionID)

  if (pull.succeeded) {
    input.askRegistry.reconcileWithPull(input.directory, pull.asks, pullStartedAt, now)
    const pulled = pull.asks.find((ask) => ask.id === requestID)
    const active = pulled ?? input.askRegistry
      .getActive(input.directory)
      .find((entry) => entry.requestID === requestID && entry.firstSeenAt >= pullStartedAt)
    if (active !== undefined) {
      if (active.sessionID !== expectedSessionID) {
        return {
          kind: "fail",
          message: `Error: permission request ${requestID} belongs to session ${active.sessionID}, not ${expectedSessionID}`,
        }
      }
      return { kind: "proceed" }
    }
    // Outcome B: authoritative-absent. Only a session-matching history entry
    // proves the request was already resolved; anything else is a hard fail.
    const history = input.askRegistry.getHistory(requestID)
    if (history !== undefined && history.sessionID === expectedSessionID) {
      input.askRegistry.evictActive(input.directory, requestID)
      return {
        kind: "resolved",
        message: `Permission request ${requestID} on session ${expectedSessionID} was already resolved (no longer pending).`,
      }
    }
    return {
      kind: "fail",
      message: `Error: permission request ${requestID} was not found in active pending requests`,
    }
  }

  // Outcome C: pull outage. Never claim "already resolved" here; only a
  // recently-seen, unanswered, session-matching history entry may proceed.
  const history = input.askRegistry.getHistory(requestID)
  if (
    history !== undefined &&
    history.sessionID === expectedSessionID &&
    history.replied !== true &&
    now - history.lastSeenAt <= REGISTRY_OUTAGE_GRACE_MS
  ) {
    return { kind: "proceed" }
  }
  return {
    kind: "fail",
    message: `Error: could not verify permission request ${requestID}: the host permission surface is unavailable and no recent pending record exists; retry janus_permission_reply when the permission service recovers`,
  }
}

/** Gate 1: the caller must be the top-level user-facing session. */
async function gateTopLevelCaller(sdk: DispatchSdk, input: PermissionReplyGuardInput): Promise<string | undefined> {
  if (input.askRegistry.dispatchedSessionIDs.has(input.sessionID)) return DISPATCHED_CALLER_MESSAGE
  let session
  try {
    const result = await sdk.session.get({ path: { id: input.sessionID }, query: { directory: input.directory } })
    if (result.error !== undefined || result.data === undefined) {
      return "Error: failed to verify the caller session; retry janus_permission_reply"
    }
    session = result.data
  } catch {
    return "Error: failed to verify the caller session; retry janus_permission_reply"
  }
  if (session.title.startsWith(DISPATCH_MARKER) || session.parentID !== undefined) return DISPATCHED_CALLER_MESSAGE
  return undefined
}

/** Gate 3: the ask's session must descend from the caller within the workspace. */
async function gateLineage(sdk: DispatchSdk, input: PermissionReplyGuardInput): Promise<string | undefined> {
  const targetSessionID = input.args.sessionID
  if (targetSessionID === input.sessionID) {
    return `Error: permission request session ${targetSessionID} is the caller session; janus_permission_reply answers a dispatched sub-session's ask`
  }
  const walk = await walkParentLineage(sdk, {
    startSessionID: targetSessionID,
    directory: input.directory,
    maxDepth: MAX_LINEAGE_DEPTH,
  })
  if (!walk.ok) {
    if (walk.reason === "depth-exceeded") {
      return `Error: session ${targetSessionID} lineage exceeds ${MAX_LINEAGE_DEPTH} hops; janus_permission_reply answers a direct dispatched sub-session`
    }
    if (walk.reason === "directory-mismatch") {
      return `Error: session ${targetSessionID} is outside the caller workspace; janus_permission_reply is limited to the caller's workspace`
    }
    return `Error: could not read the session lineage for ${targetSessionID}; retry janus_permission_reply`
  }
  const expectedDirectory = canonicalizeDirectory(input.directory)
  if (walk.path.some((hop) => canonicalizeDirectory(hop.directory) !== expectedDirectory)) {
    return `Error: session ${targetSessionID} is outside the caller workspace; janus_permission_reply is limited to the caller's workspace`
  }
  if (!walk.path.some((hop) => hop.id === input.sessionID)) {
    return `Error: session ${targetSessionID} is not a descendant of the caller session ${input.sessionID}; janus_permission_reply must answer a request from your own dispatched sub-session`
  }
  return undefined
}

/**
 * Gate 4: the same-turn human-user-message watermark. The ask must have been
 * surfaced to this caller, and the caller's newest real human message must be
 * newer than the watermark recorded at surfacing time.
 */
async function gateSurfacedWatermark(sdk: DispatchSdk, input: PermissionReplyGuardInput): Promise<string | undefined> {
  const requestID = input.args.requestID
  const history = input.askRegistry.getHistory(requestID)
  const surfaced = history?.surfaced
  if (surfaced === undefined || surfaced.callerSessionID !== input.sessionID) {
    return `Error: permission request ${requestID} was not surfaced to this caller; pending_asks must be surfaced to the top-level caller before it can be answered`
  }
  let messages: ReadonlyArray<SdkMessageWithParts>
  try {
    const result = await sdk.session.messages({ path: { id: input.sessionID }, query: { directory: input.directory } })
    if (result.error !== undefined || result.data === undefined) {
      return `Error: failed to read the caller conversation for ${requestID}; retry janus_permission_reply`
    }
    messages = result.data
  } catch {
    return `Error: failed to read the caller conversation for ${requestID}; retry janus_permission_reply`
  }
  const lastHuman = findLastHumanUserMessageID(messages, input.askRegistry.pluginInjectedMessageIDs)
  if (lastHuman === undefined || lastHuman === surfaced.surfacedAtUserMessageID) {
    return `Error: no new human message since permission request ${requestID} was surfaced; end your turn and ask the user to send a plain-text reply in the next turn, then call janus_permission_reply`
  }
  return undefined
}

/**
 * Enforce the four-gate runtime guard for `janus_permission_reply` before any
 * SDK reply call. Returns `action: "reply"` when the tool may answer, an
 * idempotent `already-resolved` message that needs no reply, or a fail-closed
 * error string.
 */
export async function enforcePermissionReplyGuard(
  sdk: DispatchSdk,
  input: PermissionReplyGuardInput,
): Promise<PermissionReplyGuardOutcome> {
  const callerError = await gateTopLevelCaller(sdk, input)
  if (callerError !== undefined) return { ok: false, message: callerError }

  const resolution = await resolvePermissionRequest(input, input.now)
  if (resolution.kind === "fail") return { ok: false, message: resolution.message }
  if (resolution.kind === "resolved") return { ok: true, action: "already-resolved", message: resolution.message }

  const lineageError = await gateLineage(sdk, input)
  if (lineageError !== undefined) return { ok: false, message: lineageError }

  const watermarkError = await gateSurfacedWatermark(sdk, input)
  if (watermarkError !== undefined) return { ok: false, message: watermarkError }

  return { ok: true, action: "reply" }
}
