import { normalizeModelKey } from "./agent-registration.ts"
import { resolveRoleModel, type JanusPluginConfig } from "./plugin-config.ts"
import { loadJobModelForGuard } from "./dispatch-journal.ts"
import type {
  DispatchProtocol,
  DispatchRole,
  DispatchSdk,
  DispatchStage,
  DispatchTier,
  JournalRole,
  SdkAssistantMessage,
  SdkMessageWithParts,
  SdkTokenUsage,
} from "./dispatch-contract.ts"

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
 * Review-seat tier floor: a fast-tier reviewer must not review a coder job
 * that ran on a stronger tier. Only an explicit `fast` reviewer is
 * constrained — an absent tier (the default senior seat) or an equal/upgraded
 * tier passes — and a historical coder job with no recorded tier never
 * triggers the floor. When true, narrows `coderTier` to the violated tier.
 */
function reviewerUndercutsCoderTier(
  reviewerTier: DispatchTier | undefined,
  coderTier: DispatchTier | undefined,
): coderTier is DispatchTier {
  if (reviewerTier !== "fast") return false
  return coderTier === "standard" || coderTier === "deep"
}

function tierFloorMessage(seat: string, coderTier: DispatchTier, jobID: string, guidance: string): string {
  return `${seat} tier floor: the review seat runs tier "fast" but coder job ${jobID} ran on tier "${coderTier}" — a fast-tier review seat must not undercut a standard or deep coder job; ${guidance}`
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
  const guarded = input.role === "coder-reviewer" || input.role === "solution-reviewer" || input.stage !== undefined
  if (!guarded) return pass()
  if (input.stage !== undefined && !(input.role === "solution-reviewer" && input.protocol === "code_plan_review")) {
    return fail("stage is only valid for solution-reviewer with protocol code_plan_review; remove stage or change the role/protocol")
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
    const loaded = await loadJobModelForGuard(sdk, { jobID, directory: input.directory })
    if (!loaded.ok) return fail(`reviews_job_ids entry ${jobID} rejected: ${loaded.message}`)
    if (reviewerUndercutsCoderTier(input.reviewerTier, loaded.tier)) {
      return fail(
        tierFloorMessage(
          check.seat,
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

export interface ContinueReviewGuardInput {
  readonly targetRole: JournalRole
  readonly targetProtocol: DispatchProtocol | undefined
  /** The target session's durable pinned model (its job spec's model_chain[0]). */
  readonly targetModel: string | null
  /** The target session's durable pinned tier; undefined for historical specs and the senior seat. */
  readonly targetTier?: DispatchTier
  readonly reviewsJobIDs: ReadonlyArray<string> | undefined
  readonly config: JanusPluginConfig
  readonly directory: string
}

/**
 * Enforce the review-seat guard for a `janus_dispatch_continue` call, after
 * the legacy-role block and before the target session is prompted. A
 * coder-reviewer session, or a solution-reviewer session carrying the
 * code_plan_review contract, must again prove reviewer ≠ author — including
 * stage "plan" sessions, whose re-review should be a fresh dispatch; the
 * guard stays strict and opens no plan-stage back door.
 */
export async function enforceContinueReviewGuard(
  sdk: DispatchSdk,
  input: ContinueReviewGuardInput,
): Promise<ReviewGuardOutcome> {
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
    const loaded = await loadJobModelForGuard(sdk, { jobID, directory: input.directory })
    if (!loaded.ok) return fail(`reviews_job_ids entry ${jobID} rejected: ${loaded.message}`)
    if (reviewerUndercutsCoderTier(input.targetTier, loaded.tier)) {
      return fail(
        tierFloorMessage(
          seat,
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
