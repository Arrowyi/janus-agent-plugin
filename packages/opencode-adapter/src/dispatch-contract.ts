import { z } from "zod"

export const DISPATCH_ROLES = [
  "explorer",
  "analyst",
  "critic",
  "arch-critic",
  "auditor",
  "writer",
  "ask-lite",
  "coder-lite",
  "coder",
  "consultant",
] as const
export type DispatchRole = (typeof DISPATCH_ROLES)[number]

/** Roles that may appear in a legacy journal record but are no longer launchable. */
export const LEGACY_DISPATCH_ROLES = ["verifier", "lite", "build"] as const
export type JournalRole = DispatchRole | "build"

export const PRODUCTION_WAIT_BUDGET_MS = 300_000
export const DEFAULT_WAIT_MS = PRODUCTION_WAIT_BUDGET_MS

export function normalizeDispatchRole(value: string): DispatchRole | undefined {
  switch (value) {
    case "explorer":
    case "analyst":
    case "critic":
    case "arch-critic":
    case "auditor":
    case "writer":
    case "ask-lite":
    case "coder-lite":
    case "coder":
    case "consultant":
      return value
    case "verifier":
      return "auditor"
    case "lite":
      return "ask-lite"
    default:
      return undefined
  }
}

const roleSchema = z.string().transform((value, ctx): DispatchRole => {
  if (value === "build") {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'the "build" role was removed; dispatch "coder" with tier: "deep" instead',
    })
    return z.NEVER
  }
  const normalized = normalizeDispatchRole(value)
  if (normalized === undefined) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `expected one of: ${DISPATCH_ROLES.join(", ")} (legacy aliases: verifier, lite)`,
    })
    return z.NEVER
  }
  return normalized
})

const journalRoleSchema = z
  .enum([...DISPATCH_ROLES, "verifier", "lite", "build"])
  .transform((value): JournalRole => {
    if (value === "verifier") return "auditor"
    if (value === "lite") return "ask-lite"
    return value
  })

/** Public role argument schema: canonical names plus the verifier/lite aliases. */
export const DispatchRoleSchema = roleSchema
const messageIdSchema = z.string().regex(/^msg-[A-Za-z0-9_-]+$/, { message: "expected msg-prefixed message id" })
const sessionIdSchema = z.string().min(1, { message: "expected non-empty session id" })

export class DispatchParseError extends Error {
  readonly _tag = "DispatchParseError" as const
  readonly issues: ReadonlyArray<{ readonly path: string; readonly message: string }>

  constructor(message: string, issues?: ReadonlyArray<{ readonly path: string; readonly message: string }>) {
    super(message)
    this.issues = issues ?? []
  }
}

export type DispatchResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: DispatchParseError }

function fromZodError(message: string, zodError: z.ZodError): DispatchParseError {
  const issues = zodError.issues.map((i) => ({
    path: i.path.length === 1 && i.path[0] === "v" ? "version" : i.path.join("."),
    message: i.message,
  }))
  return new DispatchParseError(
    `${message}: ${issues.map((i) => `${i.path}: ${i.message}`).join("; ")}`,
    issues,
  )
}

function journalRecord<K extends string, S extends z.ZodRawShape>(kind: K, shape: S) {
  return z.object({ v: z.literal(1), kind: z.literal(kind), ...shape }).strict()
}

export const JobSpecSchema = journalRecord("job-spec", {
  role: journalRoleSchema,
  agent_name: z.string().min(1),
  model_chain: z.array(z.string().nullable()),
  prompt: z.string(),
  parent_id: sessionIdSchema,
  directory: z.string().min(1),
  created_at: z.number().int(),
  // Continuation fields (Phase 2). `session_id` is the existing dispatch
  // session a continuation job reuses as its attempt-0 target; it is not a
  // child of the continuation job root. `continued_from` is the original job
  // root that owned the target session. Both are absent on a normal launch.
  session_id: sessionIdSchema.optional(),
  continued_from: sessionIdSchema.optional(),
})

export type JobSpec = z.infer<typeof JobSpecSchema>

export const AttemptReservationSchema = journalRecord("attempt-reservation", {
  job_id: sessionIdSchema,
  attempt_index: z.number().int().nonnegative(),
  model: z.string().nullable(),
  message_id: messageIdSchema,
  reserved_at: z.number().int(),
})

export type AttemptReservation = z.infer<typeof AttemptReservationSchema>

export const AttemptReceiptSchema = journalRecord("attempt-receipt", {
  job_id: sessionIdSchema,
  attempt_index: z.number().int().nonnegative(),
  session_id: sessionIdSchema,
  message_id: messageIdSchema,
  received_at: z.number().int(),
})

export type AttemptReceipt = z.infer<typeof AttemptReceiptSchema>

export const CancelIntentSchema = journalRecord("cancel-intent", {
  job_id: sessionIdSchema,
  intent_at: z.number().int(),
  reason: z.string().optional(),
})

export type CancelIntent = z.infer<typeof CancelIntentSchema>

export const JournalRecordSchema = z.discriminatedUnion("kind", [
  JobSpecSchema,
  AttemptReservationSchema,
  AttemptReceiptSchema,
  CancelIntentSchema,
])

export type JournalRecord = z.infer<typeof JournalRecordSchema>

export function parseJournalRecord(input: unknown): DispatchResult<JournalRecord> {
  const result = JournalRecordSchema.safeParse(input)
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, error: fromZodError("invalid journal record", result.error) }
}

const attemptSchema = z.object({
  index: z.number().int().nonnegative(),
  model: z.string().nullable(),
})

const envelopeBaseSchema = z
  .object({
    v: z.literal(1),
    job_id: sessionIdSchema,
    role: journalRoleSchema,
    attempt: attemptSchema,
    session_id: sessionIdSchema,
    waited_ms: z.number().int().nonnegative(),
    reason: z.string(),
    next: z.enum(["janus_dispatch_wait", "janus_dispatch_cancel"]),
  })
  .strict()

export const DispatchEnvelopeSchema = envelopeBaseSchema.extend({
  status: z.enum(["pending", "unknown", "cancelling"], { message: "unsupported envelope status" }),
})

export type DispatchEnvelope = z.infer<typeof DispatchEnvelopeSchema>

export const DispatchCancelledEnvelopeSchema = envelopeBaseSchema.extend({
  status: z.literal("cancelled"),
})

export type DispatchCancelledEnvelope = z.infer<typeof DispatchCancelledEnvelopeSchema>

/**
 * Completed-envelope handle for `janus_dispatch` with `return_handle: true`.
 * Carries the base identity fields plus the success `text`; no `next`
 * action is needed because the job is terminal.
 */
export const DispatchCompletedEnvelopeSchema = z
  .object({
    v: z.literal(1),
    status: z.literal("completed"),
    job_id: sessionIdSchema,
    role: journalRoleSchema,
    attempt: attemptSchema,
    session_id: sessionIdSchema,
    waited_ms: z.number().int().nonnegative(),
    text: z.string(),
  })
  .strict()

export type DispatchCompletedEnvelope = z.infer<typeof DispatchCompletedEnvelopeSchema>

export type DispatchOutcome =
  | { readonly kind: "success"; readonly text: string }
  | { readonly kind: "nonterminal"; readonly envelope: DispatchEnvelope }
  | { readonly kind: "cancelled"; readonly envelope: DispatchCancelledEnvelope }
  | { readonly kind: "failure"; readonly reason: string }

const AnyEnvelopeSchema = z.discriminatedUnion("status", [
  DispatchEnvelopeSchema,
  DispatchCancelledEnvelopeSchema,
  DispatchCompletedEnvelopeSchema,
])

export function parseOutcomeEnvelope(
  json: string,
): DispatchResult<DispatchEnvelope | DispatchCancelledEnvelope | DispatchCompletedEnvelope> {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (e) {
    return { ok: false, error: new DispatchParseError(`outcome is not valid JSON: ${e instanceof Error ? e.message : String(e)}`) }
  }
  const result = AnyEnvelopeSchema.safeParse(parsed)
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, error: fromZodError("invalid outcome envelope", result.error) }
}

export function serializeOutcome(outcome: DispatchOutcome): string {
  switch (outcome.kind) {
    case "success":
      return outcome.text
    case "nonterminal":
    case "cancelled":
      return JSON.stringify(outcome.envelope)
    case "failure":
      return `Error: ${outcome.reason}`
  }
}

export const WaitArgsSchema = z.object({
  job_id: sessionIdSchema,
  wait_ms: z.number().int().min(0).max(PRODUCTION_WAIT_BUDGET_MS).default(DEFAULT_WAIT_MS),
})

export type WaitArgs = z.infer<typeof WaitArgsSchema>

export function parseWaitArgs(input: unknown): DispatchResult<WaitArgs> {
  const result = WaitArgsSchema.safeParse(input)
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, error: fromZodError("invalid wait args", result.error) }
}

/**
 * Args for `janus_dispatch_continue`. `role` is optional: it is inferred
 * from the target session's owning job spec and validated when supplied.
 */
export const ContinueArgsSchema = z
  .object({
    session_id: sessionIdSchema,
    prompt: z.string(),
    role: roleSchema.optional(),
  })
  .strict()

export type ContinueArgs = z.infer<typeof ContinueArgsSchema>

export function parseDispatchRole(input: unknown): DispatchResult<DispatchRole> {
  const result = roleSchema.safeParse(input)
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, error: fromZodError("invalid dispatch role", result.error) }
}

export function parseContinueArgs(input: unknown): DispatchResult<ContinueArgs> {
  const result = ContinueArgsSchema.safeParse(input)
  return result.success
    ? { ok: true, value: result.data }
    : { ok: false, error: fromZodError("invalid continue args", result.error) }
}

export interface SdkSession {
  readonly id: string
  readonly parentID?: string
  readonly directory: string
  readonly title: string
  readonly time: { readonly created: number; readonly updated: number }
}

export interface SdkAssistantMessage {
  readonly id: string
  readonly sessionID: string
  readonly role: "assistant"
  readonly time: { readonly created: number; readonly completed?: number }
  readonly error?: unknown
  readonly parentID: string
  readonly modelID: string
  readonly providerID: string
  readonly finish?: string
}

export interface SdkTextPart {
  readonly type: "text"
  readonly text: string
  readonly synthetic?: boolean
  readonly ignored?: boolean
}

type HostMessages = NonNullable<Awaited<ReturnType<import("@opencode-ai/plugin").PluginInput["client"]["session"]["messages"]>>["data"]>
export type SdkPart = SdkTextPart | Exclude<HostMessages[number]["parts"][number], { readonly type: "text" }>

export interface SdkMessageWithParts {
  readonly info: SdkAssistantMessage | { readonly role: string; readonly id: string; readonly sessionID: string }
  readonly parts: ReadonlyArray<SdkPart>
}

export type SdkQuery = { readonly directory?: string }
export type SdkPath = { readonly id: string }
export type SdkResult<T> = { readonly data?: T; readonly error?: unknown }
export type SdkPromptBody = {
  readonly agent?: string
  readonly model?: { readonly providerID: string; readonly modelID: string }
  readonly parts: ReadonlyArray<SdkTextPart>
  readonly noReply?: boolean
  readonly messageID?: string
}

export interface SdkSessionStatus {
  readonly type: string
}

export interface DispatchSdk {
  readonly session: {
    create(input: { body: { readonly parentID?: string; readonly title?: string }; query: SdkQuery }): Promise<SdkResult<SdkSession>>
    prompt(input: { path: SdkPath; body: SdkPromptBody; query?: SdkQuery }): Promise<
      SdkResult<{ readonly info: SdkAssistantMessage; readonly parts: ReadonlyArray<SdkTextPart> }>
    >
    promptAsync(input: { path: SdkPath; body: SdkPromptBody; query?: SdkQuery }): Promise<SdkResult<void | undefined>>
    abort(input: { path: SdkPath; query?: SdkQuery }): Promise<SdkResult<boolean>>
    get(input: { path: SdkPath; query?: SdkQuery }): Promise<SdkResult<SdkSession>>
    children(input: { path: SdkPath; query?: SdkQuery }): Promise<SdkResult<ReadonlyArray<SdkSession>>>
    messages(input: { path: SdkPath; query?: SdkQuery }): Promise<SdkResult<ReadonlyArray<SdkMessageWithParts>>>
    status(input: { query?: SdkQuery }): Promise<SdkResult<Readonly<Record<string, SdkSessionStatus>>>>
  }
}

export interface Clock {
  now(): number
  sleep(ms: number, signal?: AbortSignal): Promise<void>
}

export interface KeyedMutex {
  withLock<T>(key: string, fn: () => Promise<T>, signal?: AbortSignal): Promise<T>
}

export { createKeyedMutex } from "./dispatch-mutex.ts"
