import path from "node:path"

import {
  type AttemptReceipt,
  type AttemptReservation,
  type CancelIntent,
  type Clock,
  type DispatchProtocol,
  type DispatchRole,
  type DispatchSdk,
  type DispatchStage,
  type DispatchTier,
  type JobSpec,
  type JournalRecord,
  type SdkSession,
  type SdkTextPart,
  type SdkPart,
  parseJournalRecord,
} from "./dispatch-contract.ts"
import { errorText } from "./dispatch-helpers.ts"
import { bindJob } from "./dispatch-journal-binding.ts"

export class DispatchJournalError extends Error {
  readonly _tag = "DispatchJournalError" as const
  constructor(
    readonly reason: "job-unavailable" | "invalid-job" | "write-failed" | "read-error",
    message: string,
    readonly jobID?: string,
  ) {
    super(message)
  }
}
export type JournalResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DispatchJournalError }
function ok<T>(value: T): JournalResult<T> {
  return { ok: true, value }
}
function fail(
  reason: "job-unavailable" | "invalid-job" | "write-failed" | "read-error",
  message: string,
): JournalResult<never> {
  return { ok: false, error: new DispatchJournalError(reason, message) }
}

export interface LoadedJob {
  readonly jobID: string
  readonly spec: JobSpec
  readonly reservations: AttemptReservation[]
  readonly receipts: AttemptReceipt[]
  readonly cancelIntents: CancelIntent[]
  readonly children: SdkSession[]
  readonly records: JournalRecord[]
}
export interface CreateJobInput {
  readonly parentID: string
  readonly directory: string
  readonly role: DispatchRole
  readonly agentName: string
  readonly modelChain: ReadonlyArray<string | null>
  readonly prompt: string
  readonly clock: Clock
  /** Protocol whose card prefixed the turn-1 prompt, persisted for the record. */
  readonly protocol?: DispatchProtocol
  /** Caller-declared review stage, persisted for the record (see dispatch-guard.ts). */
  readonly stage?: DispatchStage
  /** Execution tier the dispatch requested, persisted for the review-seat floor. */
  readonly tier?: DispatchTier
  /** Existing dispatch session a continuation job reuses as its attempt-0 target. */
  readonly sessionID?: string
  /** Original job root that owned the reused target session. */
  readonly continuedFrom?: string
}
export interface CreateJobResult {
  readonly jobID: string
}
export interface AppendRecordInput {
  readonly jobID: string
  readonly directory: string
  readonly record: JournalRecord
  readonly messageID?: string
}
export interface AppendRecordResult {
  readonly messageID: string
}
export interface CreateAttemptSessionInput {
  readonly jobID: string
  readonly directory: string
  readonly role: DispatchRole
}
export interface CreateAttemptSessionResult {
  readonly sessionID: string
}
export interface LoadJobInput {
  readonly jobID: string
  readonly directory: string
  readonly expectedParentID: string
}

/**
 * Cross-session read-only query for the review-seat guard: the pinned model
 * and tier of a reviewed job root — a coder task for the R&D review seats, an
 * author-writer unit for the documentation reviewer. Unlike `loadJob`,
 * ownership is deliberately NOT checked — a later controller session must
 * still be able to verify a job dispatched by an earlier controller. A
 * continuation job root (its spec carries `continued_from`) is rejected with
 * a pointer to the original root, whose spec carries the same pinned model
 * and tier; an attempt session id has no spec to read and is rejected as
 * not-found with a root job_id hint.
 */
export type ReviewedJobRole = "coder" | "author-writer"

const REVIEWED_JOB_LABEL: Record<ReviewedJobRole, string> = {
  coder: "coder task",
  "author-writer": "author-writer unit",
}

export type JobModelGuardResult =
  | { readonly ok: true; readonly model: string | null; readonly tier: DispatchTier | undefined }
  | {
      readonly ok: false
      readonly reason: "not-found" | "read-error" | "not-reviewed-root" | "invalid-job"
      readonly message: string
    }

export async function loadJobModelForGuard(
  sdk: DispatchSdk,
  input: { readonly jobID: string; readonly directory: string; readonly expectedRole: ReviewedJobRole },
): Promise<JobModelGuardResult> {
  const directory = path.normalize(input.directory)
  const label = REVIEWED_JOB_LABEL[input.expectedRole]
  const getResult = await sdk.session.get({ path: { id: input.jobID }, query: { directory } })
  if (getResult.error !== undefined) {
    return { ok: false, reason: "read-error", message: `job root read failed for ${input.jobID} in ${directory}` }
  }
  if (getResult.data === undefined) {
    return {
      ok: false,
      reason: "not-found",
      message: `job ${input.jobID} was not found in the current workspace; pass the ${label}'s root job_id (the job_id from janus_dispatch), not a session id`,
    }
  }
  const root = getResult.data
  if (path.normalize(root.directory) !== directory) {
    return {
      ok: false,
      reason: "not-found",
      message: `job ${input.jobID} belongs to a different workspace; reviews_job_ids must reference ${input.expectedRole} jobs in the current workspace`,
    }
  }
  if (!root.title.startsWith(MARKER)) {
    return {
      ok: false,
      reason: "not-found",
      message: `session ${input.jobID} is not a dispatch job root; pass the ${label}'s root job_id (the job_id from janus_dispatch), not an attempt session id`,
    }
  }
  const messagesResult = await sdk.session.messages({ path: { id: input.jobID }, query: { directory } })
  if (messagesResult.error !== undefined) {
    return { ok: false, reason: "read-error", message: `job messages read failed for ${input.jobID} in ${directory}` }
  }
  if (messagesResult.data === undefined) {
    return { ok: false, reason: "invalid-job", message: `could not read job messages for ${input.jobID}` }
  }
  const specs: JobSpec[] = []
  for (const message of messagesResult.data) {
    for (const part of message.parts) {
      if (!isJournalPart(part)) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(part.text)
      } catch {
        return { ok: false, reason: "invalid-job", message: `corrupt journal record in job ${input.jobID}: invalid JSON` }
      }
      const recordResult = parseJournalRecord(parsed)
      if (!recordResult.ok) {
        return { ok: false, reason: "invalid-job", message: `corrupt journal record in job ${input.jobID}: schema rejected` }
      }
      if (recordResult.value.kind === "job-spec") specs.push(recordResult.value)
    }
  }
  if (specs.length === 0) {
    return {
      ok: false,
      reason: "not-found",
      message: `no job spec found for ${input.jobID}; pass the ${label}'s root job_id (the job_id from janus_dispatch), not an attempt session id`,
    }
  }
  if (specs.length > 1) {
    return { ok: false, reason: "invalid-job", message: `multiple job specs found in job ${input.jobID}` }
  }
  const spec = specs[0]
  if (spec === undefined) return { ok: false, reason: "invalid-job", message: `no job spec found in job ${input.jobID}` }
  if (path.normalize(spec.directory) !== directory) {
    return {
      ok: false,
      reason: "not-found",
      message: `job ${input.jobID} records a different workspace; reviews_job_ids must reference ${input.expectedRole} jobs in the current workspace`,
    }
  }
  if (root.title !== `${MARKER}${spec.role}`) {
    return { ok: false, reason: "invalid-job", message: `job ${input.jobID} root title does not match its recorded role` }
  }
  if (spec.continued_from !== undefined) {
    return {
      ok: false,
      reason: "not-reviewed-root",
      message: `job ${input.jobID} is a continuation job root; pass the original ${label}'s root job_id (${spec.continued_from})`,
    }
  }
  if (spec.role !== input.expectedRole) {
    return {
      ok: false,
      reason: "not-reviewed-root",
      message: `job ${input.jobID} records dispatch role ${spec.role}; reviews_job_ids must reference ${label} jobs`,
    }
  }
  return { ok: true, model: spec.model_chain[0] ?? null, tier: spec.tier }
}

const MARKER = "[consultation-dispatch:v1] "
let messageCounter = 0
function makeMessageID(): string {
  messageCounter++
  return `msg-${messageCounter}-${Math.random().toString(36).slice(2, 8)}`
}
function isJournalPart(part: SdkPart): part is SdkTextPart {
  return part.type === "text" && part.synthetic === true && part.ignored === true
}

export async function createJob(
  sdk: DispatchSdk,
  input: CreateJobInput,
): Promise<JournalResult<CreateJobResult>> {
  const directory = path.normalize(input.directory)
  const title = `${MARKER}${input.role}`
  const createResult = await sdk.session.create({
    body: { parentID: input.parentID, title },
    query: { directory },
  })
  if (createResult.error !== undefined || createResult.data === undefined) {
    return fail("write-failed", `failed to create job root session: ${createResult.error !== undefined ? errorText(createResult.error) : "no data"}`)
  }
  const jobID = createResult.data.id
  const spec: JobSpec = {
    v: 1,
    kind: "job-spec",
    role: input.role,
    agent_name: input.agentName,
    model_chain: [...input.modelChain],
    prompt: input.prompt,
    parent_id: input.parentID,
    directory,
    created_at: input.clock.now(),
    ...(input.protocol !== undefined ? { protocol: input.protocol } : {}),
    ...(input.stage !== undefined ? { stage: input.stage } : {}),
    ...(input.tier !== undefined ? { tier: input.tier } : {}),
    ...(input.sessionID !== undefined ? { session_id: input.sessionID } : {}),
    ...(input.continuedFrom !== undefined ? { continued_from: input.continuedFrom } : {}),
  }
  try {
    const append = await appendRecord(sdk, { jobID, directory, record: spec })
    if (!append.ok) return { ok: false, error: new DispatchJournalError(append.error.reason, append.error.message, jobID) }
  } catch {
    return { ok: false, error: new DispatchJournalError("write-failed", "job spec persistence failed", jobID) }
  }
  return ok({ jobID })
}

export async function appendRecord(
  sdk: DispatchSdk,
  input: AppendRecordInput,
): Promise<JournalResult<AppendRecordResult>> {
  const directory = path.normalize(input.directory)
  const messageID = input.messageID ?? makeMessageID()
  const text = JSON.stringify(input.record)
  try {
    await sdk.session.prompt({
      path: { id: input.jobID },
      body: {
        parts: [{ type: "text", text, ignored: true, synthetic: true }],
        noReply: true,
        messageID,
      },
      query: { directory },
    })
  } catch {
    return fail("write-failed", "journal write was rejected by host")
  }

  // Contract item 3: noReply runtime result may not match the generated
  // AssistantMessage type. Verify persistence by reading messages.
  const messagesResult = await sdk.session.messages({
    path: { id: input.jobID },
    query: { directory },
  })
  if (messagesResult.error !== undefined || messagesResult.data === undefined) {
    return fail("write-failed", "journal read-back returned no data")
  }

  const found = messagesResult.data.find((m) => {
    const info = m.info
    return "id" in info && info.id === messageID && m.parts.some((p) => p.type === "text" && p.text === text)
  })
  if (found === undefined) {
    return fail("write-failed", "journal record not confirmed after write")
  }

  return ok({ messageID })
}

export async function createAttemptSession(
  sdk: DispatchSdk,
  input: CreateAttemptSessionInput,
): Promise<JournalResult<CreateAttemptSessionResult>> {
  const directory = path.normalize(input.directory)
  const title = `${MARKER}attempt ${input.role}`
  const result = await sdk.session.create({
    body: { parentID: input.jobID, title },
    query: { directory },
  })
  if (result.error !== undefined || result.data === undefined) {
    return fail("write-failed", "failed to create attempt session")
  }
  return ok({ sessionID: result.data.id })
}

export async function loadJob(
  sdk: DispatchSdk,
  input: LoadJobInput,
): Promise<JournalResult<LoadedJob>> {
  const directory = path.normalize(input.directory)
  const getResult = await sdk.session.get({
    path: { id: input.jobID },
    query: { directory },
  })
  if (getResult.error !== undefined) {
    return fail("read-error", "job root read failed")
  }
  if (getResult.data === undefined) {
    return fail("job-unavailable", "job root not found")
  }
  const root = getResult.data
  if (root.parentID !== input.expectedParentID) {
    return fail("job-unavailable", "job root ownership mismatch")
  }
  if (path.normalize(root.directory) !== directory) {
    return fail("job-unavailable", "job root workspace mismatch")
  }
  if (!root.title.startsWith(MARKER)) {
    return fail("job-unavailable", "job root marker mismatch")
  }

  const [messagesResult, childrenResult] = await Promise.all([
    sdk.session.messages({ path: { id: input.jobID }, query: { directory } }),
    sdk.session.children({ path: { id: input.jobID }, query: { directory } }),
  ])
  if (messagesResult.error !== undefined) {
    return fail("read-error", "job messages read failed")
  }
  if (messagesResult.data === undefined) {
    return fail("invalid-job", "could not read job messages")
  }
  if (childrenResult.error !== undefined) {
    return fail("read-error", "job children read failed")
  }
  if (childrenResult.data === undefined) {
    return fail("invalid-job", "could not read job children")
  }

  const records: JournalRecord[] = []
  for (const message of messagesResult.data) {
    for (const part of message.parts) {
      if (!isJournalPart(part)) continue
      let parsed: unknown
      try {
        parsed = JSON.parse(part.text)
      } catch {
        return fail("invalid-job", "corrupt journal record: invalid JSON")
      }
      const recordResult = parseJournalRecord(parsed)
      if (!recordResult.ok) {
        return fail("invalid-job", "corrupt journal record: schema rejected")
      }
      records.push(recordResult.value)
    }
  }

  return bindJob({ root, records, children: childrenResult.data }, input)
}
