import { describe, expect, it } from "bun:test"
import { mkdtempSync, realpathSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

import {
  MAX_ASK_HISTORY,
  MAX_LINEAGE_DEPTH,
  MAX_PATTERN_LENGTH,
  MAX_PATTERNS_COUNT,
  REGISTRY_OUTAGE_GRACE_MS,
  RE_YIELD_DAMPING_MS,
  PermissionAskRegistry,
  allAlreadySurfacedInCurrentTurn,
  canonicalizeDirectory,
  createPendingAsksProbe,
  createPermissionEventHook,
  findLastHumanUserMessageID,
  isDispatchedSubsessionCaller,
  resolvePermissionSdk,
  sanitizePendingAsk,
  walkParentLineage,
  type PermissionAskEntry,
} from "./permission-ask.ts"
import {
  DISPATCH_MARKER,
  PendingAskSchema,
  type Clock,
  type DispatchSdk,
  type SdkMessageWithParts,
  type SdkPart,
  type SdkPendingPermission,
  type SdkSession,
  type SdkTextPart,
} from "./dispatch-contract.ts"
import { FAKE_DIRECTORY, createFakeClock, createFakeSdk, type FakePermissionCall } from "./dispatch-test-fixtures.ts"

const DIR = FAKE_DIRECTORY

function session(id: string, parentID: string | undefined, title: string, directory = DIR): SdkSession {
  return {
    id,
    ...(parentID !== undefined ? { parentID } : {}),
    directory,
    title,
    time: { created: 0, updated: 0 },
  }
}

function sdkOf(fake: ReturnType<typeof createFakeSdk>): DispatchSdk {
  return fake as unknown as DispatchSdk
}

function textPart(text: string, synthetic?: boolean, ignored?: boolean): SdkTextPart {
  return {
    type: "text",
    text,
    ...(synthetic !== undefined ? { synthetic } : {}),
    ...(ignored !== undefined ? { ignored } : {}),
  }
}

function userMessage(id: string, parts: ReadonlyArray<unknown>, sessionID = "ses_parent"): SdkMessageWithParts {
  return { info: { role: "user", id, sessionID }, parts: parts as unknown as ReadonlyArray<SdkPart> }
}

function pendingAsk(overrides: Partial<SdkPendingPermission> = {}): SdkPendingPermission {
  return { id: "req-1", sessionID: "ses_child", permission: "bash", patterns: ["ls"], ...overrides }
}

function askEntry(overrides: Partial<PermissionAskEntry> = {}): PermissionAskEntry {
  return {
    requestID: "req-1",
    sessionID: "ses_child",
    directory: DIR,
    permission: "bash",
    patterns: ["ls"],
    firstSeenAt: 0,
    lastSeenAt: 0,
    ...overrides,
  }
}

function baseSessions(): SdkSession[] {
  return [
    session("ses_parent", undefined, "human"),
    session("ses_job", "ses_parent", `${DISPATCH_MARKER}coder`),
    session("ses_child", "ses_job", "attempt"),
  ]
}

function probeContext(overrides: Record<string, unknown> = {}) {
  return {
    jobID: "ses_job",
    childSessionID: "ses_child",
    parentID: "ses_parent" as string | undefined,
    role: "coder" as const,
    ...overrides,
  }
}

describe("permission-ask constants", () => {
  it("exports the contract fitness numbers", () => {
    expect(REGISTRY_OUTAGE_GRACE_MS).toBe(60_000)
    expect(RE_YIELD_DAMPING_MS).toBe(10_000)
    expect(MAX_LINEAGE_DEPTH).toBe(10)
    expect(MAX_PATTERN_LENGTH).toBe(512)
    expect(MAX_PATTERNS_COUNT).toBe(16)
    expect(MAX_ASK_HISTORY).toBe(256)
  })
})

describe("canonicalizeDirectory", () => {
  it("resolves an existing directory to its realpath", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "perm-ask-"))
    try {
      expect(canonicalizeDirectory(dir)).toBe(realpathSync(dir))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("falls back to a normalized absolute path for a missing directory", () => {
    const missing = `perm-ask-missing-${Date.now()}-${Math.random()}`
    expect(canonicalizeDirectory(missing)).toBe(path.normalize(path.resolve(missing)))
  })
})

describe("resolvePermissionSdk", () => {
  it("drives the V2 permission surface: list, listForSession and reply with a message", async () => {
    const fake = createFakeSdk({ seedPermission: true })
    const sdk = resolvePermissionSdk(fake)
    expect(sdk).toBeDefined()
    const ask = pendingAsk()
    fake.permission!.seedAsks([ask])
    fake.v2!.session.permission.seedAsks([ask])

    const listed = await sdk!.list({ query: { directory: DIR } })
    expect(listed.error).toBeUndefined()
    expect(listed.data).toEqual([ask])

    const scoped = await sdk!.listForSession!({ path: { sessionID: "ses_child" }, query: { directory: DIR } })
    expect(scoped.data).toEqual([ask])

    const replied = await sdk!.reply({
      path: { requestID: "req-1", sessionID: "ses_child" },
      body: { reply: "once", message: "allow" },
      query: { directory: DIR },
    })
    expect(replied).toEqual({ data: true })

    const methods = fake.permission!.calls.map((call) => call.method)
    expect(methods).toContain("list")
    expect(methods).toContain("listForSession")
    expect(methods).toContain("reply")
    const replyCall = fake.permission!.calls.find((call) => call.method === "reply")
    expect(replyCall?.input).toEqual({ requestID: "req-1", directory: DIR, reply: "once", message: "allow" })
  })

  it("falls back to the V2 session surface when no global permission client is mounted", async () => {
    const listCalls: unknown[] = []
    const replyCalls: unknown[] = []
    const sessionAsk = pendingAsk({ id: "req-session", sessionID: "ses_child" })
    const client = {
      v2: {
        session: {
          permission: {
            async list(input: unknown) {
              listCalls.push(input)
              return { data: { data: [sessionAsk] } }
            },
            async reply(input: unknown) {
              replyCalls.push(input)
              return { data: true }
            },
          },
        },
      },
    }

    const sdk = resolvePermissionSdk(client)
    expect(sdk).toBeDefined()
    expect(await sdk!.list({})).toEqual({ error: "permission list surface unavailable" })
    const scoped = await sdk!.listForSession!({ path: { sessionID: "ses_child" } })
    expect(scoped.data).toEqual([sessionAsk])
    expect(await sdk!.reply({ path: { requestID: "req-session", sessionID: "ses_child" }, body: { reply: "always" } })).toEqual({
      data: true,
    })
    expect(listCalls[0]).toEqual({ sessionID: "ses_child" })
    expect(replyCalls[0]).toEqual({ sessionID: "ses_child", requestID: "req-session", reply: "always" })
  })

  it("drives the V1 HeyAPI transport (get/post) and the session reply endpoint", async () => {
    const getCalls: Array<{ url: string; query?: { directory?: string } }> = []
    const postCalls: Array<{ url: string; query?: unknown; body: unknown }> = []
    const client = {
      _client: {
        async get(input: { url: string; query?: { directory?: string } }) {
          getCalls.push(input)
          return { data: [pendingAsk()] }
        },
        async post(input: { url: string; query?: unknown; body: unknown }) {
          postCalls.push(input)
          return { data: true }
        },
      },
    }

    const sdk = resolvePermissionSdk(client)
    expect(sdk).toBeDefined()
    expect((await sdk!.list({ query: { directory: DIR } })).data).toEqual([pendingAsk()])
    await sdk!.listForSession!({ path: { sessionID: "ses child" }, query: { directory: DIR } })
    await sdk!.reply({ path: { requestID: "req/1", sessionID: "ses_child" }, body: { reply: "reject", message: "no" }, query: { directory: DIR } })

    expect(getCalls[0]).toEqual({ url: "/permission", query: { directory: DIR } })
    expect(getCalls[1]?.url).toBe(`/api/session/${encodeURIComponent("ses child")}/permission`)
    expect(postCalls[0]).toEqual({
      url: `/permission/${encodeURIComponent("req/1")}/reply`,
      query: { directory: DIR },
      body: { reply: "reject", message: "no" },
    })
  })

  it("accepts the V1 transport under the client.client alias", async () => {
    const client = {
      client: {
        async get() {
          return { data: [] }
        },
      },
    }
    const sdk = resolvePermissionSdk(client)
    expect(sdk).toBeDefined()
    expect((await sdk!.list({})).data).toEqual([])
  })

  it("falls back to postSessionIdPermissionsPermissionId when no transport is mounted", async () => {
    const replyCalls: unknown[] = []
    const client = {
      async postSessionIdPermissionsPermissionId(input: unknown) {
        replyCalls.push(input)
        return { data: true }
      },
    }
    const sdk = resolvePermissionSdk(client)
    expect(sdk).toBeDefined()
    expect((await sdk!.list({})).error).toBeDefined()
    expect(sdk!.listForSession).toBeUndefined()
    const replied = await sdk!.reply({
      path: { requestID: "req-1", sessionID: "ses_child" },
      body: { reply: "once" },
      query: { directory: DIR },
    })
    expect(replied).toEqual({ data: true })
    expect(replyCalls[0]).toEqual({
      path: { id: "ses_child", permissionID: "req-1" },
      body: { response: "once" },
      query: { directory: DIR },
    })
  })

  it("returns undefined (never throws) when no permission surface is mounted", () => {
    for (const value of [undefined, null, {}, { session: {} }, "not-an-object", 42]) {
      expect(resolvePermissionSdk(value)).toBeUndefined()
    }
  })

  it("propagates host list/reply errors instead of throwing", async () => {
    const fake = createFakeSdk({ seedPermission: true })
    fake.permission!.setListResult({ error: "down" })
    fake.permission!.setReplyResult({ error: "nope" })
    const sdk = resolvePermissionSdk(fake)
    expect(sdk).toBeDefined()
    expect(await sdk!.list({})).toEqual({ error: "down" })
    expect(await sdk!.reply({ path: { requestID: "r", sessionID: "s" }, body: { reply: "once" } })).toEqual({ error: "nope" })
  })
})

describe("findLastHumanUserMessageID", () => {
  const none = new Set<string>()

  it("returns the newest real human user message", () => {
    const messages = [userMessage("msg-1", [textPart("first")]), userMessage("msg-2", [textPart("second")])]
    expect(findLastHumanUserMessageID(messages, none)).toBe("msg-2")
  })

  it("skips plugin-injected message ids", () => {
    const injected = new Set(["msg-2"])
    const messages = [userMessage("msg-1", [textPart("real")]), userMessage("msg-2", [textPart("injected")])]
    expect(findLastHumanUserMessageID(messages, injected)).toBe("msg-1")
  })

  it("skips compaction and subtask messages", () => {
    const messages = [
      userMessage("msg-1", [textPart("real")]),
      userMessage("msg-2", [{ type: "compaction" } as unknown as SdkPart]),
      userMessage("msg-3", [{ type: "subtask" } as unknown as SdkPart]),
    ]
    expect(findLastHumanUserMessageID(messages, none)).toBe("msg-1")
  })

  it("skips synthetic-only and ignored-only text", () => {
    const messages = [
      userMessage("msg-1", [textPart("real")]),
      userMessage("msg-2", [textPart("journal", true, true)]),
      userMessage("msg-3", [textPart("ignored", undefined, true)]),
    ]
    expect(findLastHumanUserMessageID(messages, none)).toBe("msg-1")
  })

  it("advances on a human message carrying a synthetic @file part plus real text", () => {
    const messages = [
      userMessage("msg-1", [textPart("real")]),
      userMessage("msg-2", [textPart("@file src/x.ts", true), textPart("please allow this")]),
    ]
    expect(findLastHumanUserMessageID(messages, none)).toBe("msg-2")
  })

  it("returns undefined when no qualifying message exists", () => {
    expect(findLastHumanUserMessageID([], none)).toBeUndefined()
    const assistant: SdkMessageWithParts = {
      info: { role: "assistant", id: "msg-a", sessionID: "ses" },
      parts: [textPart("hi")],
    }
    expect(findLastHumanUserMessageID([assistant], none)).toBeUndefined()
  })
})

describe("walkParentLineage", () => {
  it("walks parentID hops up to the root", async () => {
    const fake = createFakeSdk({
      sessions: [
        session("ses_root", undefined, "root"),
        session("ses_mid", "ses_root", "mid"),
        session("ses_leaf", "ses_mid", "leaf"),
      ],
    })
    const result = await walkParentLineage(sdkOf(fake), { startSessionID: "ses_leaf", directory: DIR })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.path.map((hop) => hop.id)).toEqual(["ses_leaf", "ses_mid", "ses_root"])
  })

  it("fails closed past MAX_LINEAGE_DEPTH", async () => {
    const chain: SdkSession[] = []
    for (let i = 0; i <= MAX_LINEAGE_DEPTH; i++) {
      chain.push(session(`ses_n${i}`, i < MAX_LINEAGE_DEPTH ? `ses_n${i + 1}` : undefined, `n${i}`))
    }
    const fake = createFakeSdk({ sessions: chain })
    const result = await walkParentLineage(sdkOf(fake), { startSessionID: "ses_n0", directory: DIR })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("depth-exceeded")
    expect(result.path).toHaveLength(MAX_LINEAGE_DEPTH)
  })

  it("succeeds at exactly MAX_LINEAGE_DEPTH hops", async () => {
    const chain: SdkSession[] = []
    for (let i = 0; i < MAX_LINEAGE_DEPTH; i++) {
      chain.push(session(`ses_m${i}`, i < MAX_LINEAGE_DEPTH - 1 ? `ses_m${i + 1}` : undefined, `m${i}`))
    }
    const fake = createFakeSdk({ sessions: chain })
    const result = await walkParentLineage(sdkOf(fake), { startSessionID: "ses_m0", directory: DIR })
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.path).toHaveLength(MAX_LINEAGE_DEPTH)
  })

  it("treats an unreadable hop as non-attribution without throwing", async () => {
    const fake = createFakeSdk({ sessions: [session("ses_leaf", "ses_missing", "leaf")] })
    const result = await walkParentLineage(sdkOf(fake), { startSessionID: "ses_leaf", directory: DIR })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("unreadable")
    expect(result.path.map((hop) => hop.id)).toEqual(["ses_leaf"])
  })

  it("rejects a canonicalized-directory mismatch", async () => {
    const fake = createFakeSdk({
      sessions: [
        session("ses_leaf", "ses_other", "leaf", DIR),
        session("ses_other", undefined, "other", "/tmp/other-workspace"),
      ],
    })
    const result = await walkParentLineage(sdkOf(fake), { startSessionID: "ses_leaf", directory: DIR })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe("directory-mismatch")
  })

  it("treats a throwing session read as unreadable", async () => {
    const fake = createFakeSdk({ sessions: [session("ses_leaf", "ses_bad", "leaf")] })
    const base = sdkOf(fake)
    const throwing = {
      session: {
        ...base.session,
        async get(input: { path: { id: string } }) {
          if (input.path.id === "ses_bad") throw new Error("transport")
          return base.session.get(input)
        },
      },
    } as unknown as DispatchSdk
    const result = await walkParentLineage(throwing, { startSessionID: "ses_leaf", directory: DIR })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.reason).toBe("unreadable")
  })
})

describe("isDispatchedSubsessionCaller", () => {
  it("returns false without a parent id", async () => {
    expect(await isDispatchedSubsessionCaller(sdkOf(createFakeSdk()), new PermissionAskRegistry(), undefined)).toBe(false)
  })

  it("returns true for a seeded dispatched session id without reading the host", async () => {
    const fake = createFakeSdk()
    const registry = new PermissionAskRegistry()
    registry.dispatchedSessionIDs.add("ses_job")
    expect(await isDispatchedSubsessionCaller(sdkOf(fake), registry, "ses_job")).toBe(true)
    expect(fake.calls).toHaveLength(0)
  })

  it("returns true for a DISPATCH_MARKER title or a defined parentID", async () => {
    const marker = createFakeSdk({ sessions: [session("ses_job", undefined, `${DISPATCH_MARKER}coder`)] })
    expect(await isDispatchedSubsessionCaller(sdkOf(marker), new PermissionAskRegistry(), "ses_job")).toBe(true)
    const child = createFakeSdk({ sessions: [session("ses_job", "ses_up", "job")] })
    expect(await isDispatchedSubsessionCaller(sdkOf(child), new PermissionAskRegistry(), "ses_job")).toBe(true)
  })

  it("returns false for a plain top-level session", async () => {
    const fake = createFakeSdk({ sessions: [session("ses_top", undefined, "human")] })
    expect(await isDispatchedSubsessionCaller(sdkOf(fake), new PermissionAskRegistry(), "ses_top")).toBe(false)
  })

  it('returns "unknown" on a missing session or a transport failure (delay, not fail-closed)', async () => {
    const fake = createFakeSdk()
    expect(await isDispatchedSubsessionCaller(sdkOf(fake), new PermissionAskRegistry(), "ses_missing")).toBe("unknown")
    const base = sdkOf(fake)
    const throwing = {
      session: {
        ...base.session,
        async get() {
          throw new Error("down")
        },
      },
    } as unknown as DispatchSdk
    expect(await isDispatchedSubsessionCaller(throwing, new PermissionAskRegistry(), "ses_x")).toBe("unknown")
  })
})

describe("allAlreadySurfacedInCurrentTurn", () => {
  it("is false for an empty set or an unknown human message", () => {
    expect(allAlreadySurfacedInCurrentTurn([], "msg-1", "ses_parent")).toBe(false)
    expect(allAlreadySurfacedInCurrentTurn([askEntry()], undefined, "ses_parent")).toBe(false)
  })

  it("is true when every entry was surfaced to this caller at the current human message", () => {
    const surfaced = { callerSessionID: "ses_parent", surfacedAtUserMessageID: "msg-1", surfacedAt: 5 }
    expect(
      allAlreadySurfacedInCurrentTurn([askEntry({ surfaced }), askEntry({ requestID: "req-2", surfaced })], "msg-1", "ses_parent"),
    ).toBe(true)
  })

  it("is false when an entry is unsurfaced, surfaced elsewhere, or at an older message", () => {
    const atCurrent = { callerSessionID: "ses_parent", surfacedAtUserMessageID: "msg-1", surfacedAt: 5 }
    expect(
      allAlreadySurfacedInCurrentTurn([askEntry({ surfaced: atCurrent }), askEntry({ requestID: "req-2" })], "msg-1", "ses_parent"),
    ).toBe(false)
    const elsewhere = { callerSessionID: "ses_other", surfacedAtUserMessageID: "msg-1", surfacedAt: 5 }
    expect(allAlreadySurfacedInCurrentTurn([askEntry({ surfaced: elsewhere })], "msg-1", "ses_parent")).toBe(false)
    const older = { callerSessionID: "ses_parent", surfacedAtUserMessageID: "msg-0", surfacedAt: 5 }
    expect(allAlreadySurfacedInCurrentTurn([askEntry({ surfaced: older })], "msg-1", "ses_parent")).toBe(false)
  })
})

describe("sanitizePendingAsk", () => {
  it("strips control characters, caps lengths/counts, and floors the age", () => {
    const patterns = ["a".repeat(600), "\x01", "ok"]
    for (let i = 0; i < 20; i++) patterns.push(`p${i}`)
    const out = sanitizePendingAsk(
      {
        requestID: "req\x00\x01",
        sessionID: "ses\x7F",
        permission: "bash\x07".repeat(40),
        patterns,
        firstSeenAt: 9_999,
        job_chain: [{ job_id: "j\x00", role: "coder", session_id: "c\x01" }],
      },
      10_000,
    )
    expect(out.requestID).toBe("req")
    expect(out.sessionID).toBe("ses")
    expect(out.permission).toBe("bash".repeat(40).slice(0, 64))
    expect(out.patterns).toHaveLength(MAX_PATTERNS_COUNT)
    expect(out.patterns[0]?.length).toBe(MAX_PATTERN_LENGTH)
    expect(out.age_ms).toBe(1)
    expect(out.job_chain).toEqual([{ job_id: "j", role: "coder", session_id: "c" }])
    expect(PendingAskSchema.safeParse(out).success).toBe(true)
  })

  it("defaults an empty pattern list to ['*'] and an all-control permission to 'unknown'", () => {
    const out = sanitizePendingAsk(
      { requestID: "", sessionID: "", permission: "\x00\x01", patterns: [], firstSeenAt: 100, job_chain: [] },
      100,
    )
    expect(out.requestID).toBe("unknown")
    expect(out.sessionID).toBe("unknown")
    expect(out.permission).toBe("unknown")
    expect(out.patterns).toEqual(["*"])
    expect(out.age_ms).toBe(0)
    expect(out.job_chain).toEqual([{ job_id: "unknown", role: "coder", session_id: "unknown" }])
    expect(PendingAskSchema.safeParse(out).success).toBe(true)
  })

  it("floors a negative age and a fractional age to a non-negative integer", () => {
    const negative = sanitizePendingAsk(
      { requestID: "r", sessionID: "s", permission: "p", patterns: ["*"], firstSeenAt: 10_500, job_chain: [{ job_id: "j", role: "coder", session_id: "s" }] },
      10_000,
    )
    expect(negative.age_ms).toBe(0)
    const fractional = sanitizePendingAsk(
      { requestID: "r", sessionID: "s", permission: "p", patterns: ["*"], firstSeenAt: 9_998.2, job_chain: [{ job_id: "j", role: "coder", session_id: "s" }] },
      10_000,
    )
    expect(fractional.age_ms).toBe(1)
    expect(Number.isInteger(fractional.age_ms)).toBe(true)
  })
})

describe("PermissionAskRegistry", () => {
  it("records, updates, and resolves asks per canonical directory", () => {
    const registry = new PermissionAskRegistry()
    registry.onAsked({ requestID: "req-1", sessionID: "ses_child", directory: DIR, permission: "bash", patterns: ["ls"] }, 1000)
    expect(registry.getActive(DIR).map((entry) => entry.requestID)).toEqual(["req-1"])
    registry.onAsked({ requestID: "req-1", sessionID: "ses_child", directory: DIR, permission: "edit", patterns: ["x"] }, 1005)
    const entry = registry.getHistory("req-1")
    expect(entry?.permission).toBe("edit")
    expect(entry?.firstSeenAt).toBe(1000)
    expect(entry?.lastSeenAt).toBe(1005)
    registry.onReplied("req-1", 1010)
    expect(registry.getActive(DIR)).toEqual([])
    expect(registry.getHistory("req-1")?.replied).toBe(true)
  })

  it("marks a surfaced watermark write-once", () => {
    const registry = new PermissionAskRegistry()
    registry.onAsked({ requestID: "req-1", sessionID: "ses_child", directory: DIR, permission: "bash", patterns: ["ls"] }, 1000)
    registry.markSurfaced("req-1", { callerSessionID: "ses_parent", surfacedAtUserMessageID: "msg-1", surfacedAt: 1000 })
    registry.markSurfaced("req-1", { callerSessionID: "ses_parent", surfacedAtUserMessageID: "msg-2", surfacedAt: 2000 })
    expect(registry.getHistory("req-1")?.surfaced).toEqual({
      callerSessionID: "ses_parent",
      surfacedAtUserMessageID: "msg-1",
      surfacedAt: 1000,
    })
  })

  it("retains a post-pull-start push entry and preserves its watermark (pull-start eviction)", () => {
    const registry = new PermissionAskRegistry()
    registry.onAsked({ requestID: "req-push", sessionID: "ses_child", directory: DIR, permission: "bash", patterns: ["ls"] }, 1005)
    registry.markSurfaced("req-push", { callerSessionID: "ses_parent", surfacedAtUserMessageID: "msg-1", surfacedAt: 1005 })
    // pull starts t=1000 (before the push) and completes t=1010 without the ask
    registry.reconcileWithPull(DIR, [], 1000, 1010)
    expect(registry.getActive(DIR).map((entry) => entry.requestID)).toEqual(["req-push"])
    expect(registry.getHistory("req-push")?.surfaced?.surfacedAtUserMessageID).toBe("msg-1")
  })

  it("evicts an entry first seen before the pull when the pull omits it", () => {
    const registry = new PermissionAskRegistry()
    registry.onAsked({ requestID: "req-old", sessionID: "ses_child", directory: DIR, permission: "bash", patterns: ["ls"] }, 995)
    registry.reconcileWithPull(DIR, [], 1000, 1010)
    expect(registry.getActive(DIR)).toEqual([])
    expect(registry.getHistory("req-old")).toBeDefined()
  })

  it("adds pulled asks and refreshes pulled entries", () => {
    const registry = new PermissionAskRegistry()
    registry.reconcileWithPull(DIR, [pendingAsk({ id: "req-new", sessionID: "ses_child" })], 1000, 1010)
    expect(registry.getActive(DIR).map((entry) => entry.requestID)).toEqual(["req-new"])
    registry.reconcileWithPull(DIR, [pendingAsk({ id: "req-new", sessionID: "ses_child" })], 1010, 1020)
    expect(registry.getHistory("req-new")?.lastSeenAt).toBe(1020)
  })

  it("bumps the per-directory version and wakes a listener at 0 ms (level-triggered)", async () => {
    const registry = new PermissionAskRegistry()
    expect(registry.getVersion(DIR)).toBe(0)
    const wake = registry.waitForAskWake(DIR, 0)
    registry.onAsked({ requestID: "req-1", sessionID: "ses_child", directory: DIR, permission: "bash", patterns: ["ls"] }, 1)
    await wake
    expect(registry.getVersion(DIR)).toBe(1)
    // A version already ahead resolves immediately with no further event.
    await registry.waitForAskWake(DIR, 0)
  })

  it("rejects an aborted wait", async () => {
    const registry = new PermissionAskRegistry()
    const controller = new AbortController()
    controller.abort()
    await expect(registry.waitForAskWake(DIR, 5, controller.signal)).rejects.toThrow(/aborted/)
  })

  it("records and clears cancel epochs", () => {
    const registry = new PermissionAskRegistry()
    registry.markCancelEpoch("ses_job", 42)
    expect(registry.getCancelledAt("ses_job")).toBe(42)
    registry.clearSessionCancelled("ses_job")
    expect(registry.getCancelledAt("ses_job")).toBeUndefined()
  })

  it("caps ask history at MAX_ASK_HISTORY with LRU eviction", () => {
    const registry = new PermissionAskRegistry()
    for (let i = 0; i <= MAX_ASK_HISTORY; i++) {
      registry.onAsked({ requestID: `req-${i}`, sessionID: "ses_child", directory: DIR, permission: "bash", patterns: ["ls"] }, i)
    }
    expect(registry.getHistory("req-0")).toBeUndefined()
    expect(registry.getHistory(`req-${MAX_ASK_HISTORY}`)).toBeDefined()
    expect(registry.getHistory(`req-${MAX_ASK_HISTORY - 1}`)).toBeDefined()
  })

  it("keeps coordinator-turn-end records peekable then consumable exactly once", () => {
    const registry = new PermissionAskRegistry()
    const value = { coordinatorSessionID: "ses_l1", descendantJobIDs: ["ses_l2"] }
    registry.recordCoordinatorTurnEnded("ses_job", value)
    expect(registry.peekCoordinatorTurnEnded("ses_job")).toEqual(value)
    expect(registry.consumeCoordinatorTurnEnded("ses_job")).toEqual(value)
    expect(registry.peekCoordinatorTurnEnded("ses_job")).toBeUndefined()
    expect(registry.consumeCoordinatorTurnEnded("ses_job")).toBeUndefined()
  })

  it("evictActive removes only the live entry, leaving history intact", () => {
    const registry = new PermissionAskRegistry()
    registry.onAsked({ requestID: "req-1", sessionID: "ses_child", directory: DIR, permission: "bash", patterns: ["ls"] }, 1)
    registry.evictActive(DIR, "req-1")
    expect(registry.getActive(DIR)).toEqual([])
    expect(registry.getHistory("req-1")).toBeDefined()
  })

  it("ignores lifecycle events for unknown request ids", () => {
    const registry = new PermissionAskRegistry()
    registry.onReplied("req-missing", 1)
    registry.markSurfaced("req-missing", { callerSessionID: "ses_parent", surfacedAtUserMessageID: "msg", surfacedAt: 1 })
    expect(registry.getHistory("req-missing")).toBeUndefined()
  })

  it("clears every session-scoped record on removeSession", () => {
    const registry = new PermissionAskRegistry()
    registry.onAsked({ requestID: "req-1", sessionID: "ses_child", directory: DIR, permission: "bash", patterns: ["ls"] }, 1)
    registry.dispatchedSessionIDs.add("ses_child")
    registry.markCancelEpoch("ses_child", 1)
    registry.recordCoordinatorTurnEnded("ses_job", { coordinatorSessionID: "ses_child", descendantJobIDs: ["ses_child"] })
    registry.removeSession("ses_child")
    expect(registry.getActive(DIR)).toEqual([])
    expect(registry.getHistory("req-1")).toBeUndefined()
    expect(registry.dispatchedSessionIDs.has("ses_child")).toBe(false)
    expect(registry.getCancelledAt("ses_child")).toBeUndefined()
    expect(registry.peekCoordinatorTurnEnded("ses_job")).toBeUndefined()
  })
})

describe("createPermissionEventHook", () => {
  function makeClient(opts: { directory?: string; toasts?: unknown[]; sessionDirs?: Record<string, string> } = {}) {
    const toasts = opts.toasts
    return {
      session: {
        async get(input: { path: { id: string } }) {
          const dir = opts.sessionDirs?.[input.path.id] ?? opts.directory
          if (dir === undefined) return { data: undefined }
          return { data: { id: input.path.id, directory: dir, title: "s", time: { created: 0, updated: 0 } } }
        },
      },
      ...(toasts !== undefined
        ? {
            tui: {
              async showToast(input: unknown) {
                toasts.push(input)
              },
            },
          }
        : {}),
    }
  }

  function fakeClock(): Clock {
    return createFakeClock(123)
  }

  it("records permission.asked and its V1/V2 aliases", async () => {
    const registry = new PermissionAskRegistry()
    const hook = createPermissionEventHook(registry, makeClient(), fakeClock())
    for (const type of ["permission.asked", "permission.updated", "permission.v2.asked"]) {
      const id = `req-${type}`
      await hook({
        event: { type, properties: { id, sessionID: "ses_child", directory: DIR, permission: "bash", patterns: ["ls"] } },
      })
      expect(registry.getActive(DIR).map((entry) => entry.requestID)).toContain(id)
    }
  })

  it("resolves the directory from the session when the event omits it", async () => {
    const registry = new PermissionAskRegistry()
    const hook = createPermissionEventHook(registry, makeClient({ sessionDirs: { ses_child: "/tmp/resolved" } }), fakeClock())
    await hook({
      event: { type: "permission.asked", properties: { id: "req-1", sessionID: "ses_child", permission: "bash", patterns: ["ls"] } },
    })
    expect(registry.getActive("/tmp/resolved").map((entry) => entry.requestID)).toEqual(["req-1"])
  })

  it("removes an ask on permission.replied and permission.v2.replied", async () => {
    const registry = new PermissionAskRegistry()
    const hook = createPermissionEventHook(registry, makeClient(), fakeClock())
    await hook({
      event: { type: "permission.asked", properties: { id: "req-1", sessionID: "ses_child", directory: DIR, permission: "bash", patterns: ["ls"] } },
    })
    await hook({ event: { type: "permission.replied", properties: { permissionID: "req-1" } } })
    expect(registry.getActive(DIR)).toEqual([])
    expect(registry.getHistory("req-1")?.replied).toBe(true)
    await hook({
      event: { type: "permission.asked", properties: { id: "req-2", sessionID: "ses_child", directory: DIR, permission: "bash", patterns: ["ls"] } },
    })
    await hook({ event: { type: "permission.v2.replied", properties: { requestID: "req-2" } } })
    expect(registry.getActive(DIR)).toEqual([])
  })

  it("clears session state on session.deleted", async () => {
    const registry = new PermissionAskRegistry()
    const hook = createPermissionEventHook(registry, makeClient(), fakeClock())
    await hook({
      event: { type: "permission.asked", properties: { id: "req-1", sessionID: "ses_child", directory: DIR, permission: "bash", patterns: ["ls"] } },
    })
    registry.dispatchedSessionIDs.add("ses_child")
    registry.markCancelEpoch("ses_child", 1)
    registry.recordCoordinatorTurnEnded("ses_job", { coordinatorSessionID: "ses_child", descendantJobIDs: ["ses_job"] })
    await hook({ event: { type: "session.deleted", properties: { info: { id: "ses_child" } } } })
    expect(registry.getActive(DIR)).toEqual([])
    expect(registry.getHistory("req-1")).toBeUndefined()
    expect(registry.dispatchedSessionIDs.has("ses_child")).toBe(false)
    expect(registry.getCancelledAt("ses_child")).toBeUndefined()
    expect(registry.peekCoordinatorTurnEnded("ses_job")).toBeUndefined()
  })

  it("emits at most one control-char-stripped toast per requestID and only for dispatched sessions", async () => {
    const registry = new PermissionAskRegistry()
    const toasts: unknown[] = []
    const hook = createPermissionEventHook(registry, makeClient({ toasts }), fakeClock())

    await hook({
      event: { type: "permission.asked", properties: { id: "req-plain", sessionID: "ses_plain", directory: DIR, permission: "bash", patterns: ["ls"] } },
    })
    expect(toasts).toHaveLength(0)

    registry.dispatchedSessionIDs.add("ses_child")
    for (let i = 0; i < 2; i++) {
      await hook({
        event: { type: "permission.asked", properties: { id: "req-1", sessionID: "ses_child", directory: DIR, permission: "bash\x07", patterns: ["ls"] } },
      })
    }
    expect(toasts).toHaveLength(1)
    const toast = toasts[0] as { body: { message: string } }
    expect(toast.body.message).toContain("bash")
    expect(toast.body.message.includes("\x07")).toBe(false)
  })

  it("never throws when the host client is unavailable", async () => {
    const registry = new PermissionAskRegistry()
    const hook = createPermissionEventHook(registry, undefined, fakeClock())
    await hook({ event: { type: "permission.asked", properties: { id: "req-1", sessionID: "ses_child", permission: "bash", patterns: ["ls"] } } })
    expect(registry.getActive(process.cwd()).map((entry) => entry.requestID)).toEqual(["req-1"])
    await hook({ event: { type: "session.idle" } })
  })
})

describe("createPendingAsksProbe", () => {
  it("never sends the job id as the workspace directory on the bootstrap read (Defect 1 regression)", async () => {
    const getDirs: Array<{ id: string; directory: string | undefined }> = []
    const fake = createFakeSdk({
      sessions: baseSessions(),
      onSessionGet: (input) => getDirs.push({ id: input.path.id, directory: input.query?.directory }),
    })
    const registry = new PermissionAskRegistry()
    const clock = createFakeClock(1000)
    registry.onAsked({ requestID: "req-1", sessionID: "ses_child", directory: DIR, permission: "bash", patterns: ["ls"] }, 1000)

    await createPendingAsksProbe(fake, registry, clock)(probeContext())

    // The bootstrap read of the job root carries no directory...
    expect(getDirs[0]).toEqual({ id: "ses_job", directory: undefined })
    // ...so the session id is never sent where a workspace path belongs.
    expect(getDirs.some((entry) => entry.directory === "ses_job")).toBe(false)
    // Any scoped read uses the real workspace directory only.
    for (const entry of getDirs.slice(1)) {
      expect(entry.directory === undefined || entry.directory === DIR).toBe(true)
    }
  })

  it("surfaces a pending ask for a direct child with sanitized fields", async () => {
    const fake = createFakeSdk({ sessions: baseSessions() })
    const registry = new PermissionAskRegistry()
    const clock = createFakeClock(1000)
    registry.onAsked({ requestID: "req-1", sessionID: "ses_child", directory: DIR, permission: "bash", patterns: ["ls"] }, 1000)
    const result = await createPendingAsksProbe(fake, registry, clock)(probeContext())
    expect(result.isDispatchedSubsessionCaller).toBe(false)
    expect(result.allAlreadySurfacedInCurrentTurn).toBe(false)
    expect(result.asks).toHaveLength(1)
    expect(result.asks[0]?.requestID).toBe("req-1")
    expect(result.asks[0]?.sessionID).toBe("ses_child")
    expect(result.asks[0]?.age_ms).toBe(0)
    expect(result.asks[0]?.job_chain).toEqual([{ job_id: "ses_job", role: "coder", session_id: "ses_child" }])
    expect(PendingAskSchema.safeParse(result.asks[0]).success).toBe(true)
  })

  it("pairs a nested root with its attempt child in job_chain", async () => {
    const fake = createFakeSdk({
      sessions: [
        session("ses_parent", undefined, "human"),
        session("ses_jobB", "ses_parent", `${DISPATCH_MARKER}tech-lead`),
        session("ses_attemptB", "ses_jobB", `${DISPATCH_MARKER}attempt tech-lead`),
        session("ses_jobA", "ses_attemptB", `${DISPATCH_MARKER}coder`),
      ],
    })
    const registry = new PermissionAskRegistry()
    const clock = createFakeClock(1000)
    registry.onAsked({ requestID: "req-1", sessionID: "ses_attemptA", directory: DIR, permission: "bash", patterns: ["ls"] }, 1000)
    const result = await createPendingAsksProbe(fake, registry, clock)({
      jobID: "ses_jobA",
      childSessionID: "ses_attemptA",
      parentID: "ses_parent",
      role: "coder",
    })
    expect(result.asks).toHaveLength(1)
    expect(result.asks[0]?.job_chain).toEqual([
      { job_id: "ses_jobA", role: "coder", session_id: "ses_attemptA" },
      { job_id: "ses_jobB", role: "tech-lead", session_id: "ses_attemptB" },
    ])
  })

  it("excludes an ask covered by a cancel epoch, and keeps one from before the epoch", async () => {
    const fake = createFakeSdk({ sessions: baseSessions() })
    const clock = createFakeClock(1000)
    const cancelled = new PermissionAskRegistry()
    cancelled.onAsked({ requestID: "req-1", sessionID: "ses_child", directory: DIR, permission: "bash", patterns: ["ls"] }, 1000)
    cancelled.markCancelEpoch("ses_job", 1000)
    expect((await createPendingAsksProbe(fake, cancelled, clock)(probeContext())).asks).toEqual([])

    const earlier = new PermissionAskRegistry()
    earlier.onAsked({ requestID: "req-1", sessionID: "ses_child", directory: DIR, permission: "bash", patterns: ["ls"] }, 1000)
    earlier.markCancelEpoch("ses_job", 999)
    expect((await createPendingAsksProbe(fake, earlier, clock)(probeContext())).asks).toHaveLength(1)
  })

  it("excludes an ask with a persisted cancel-intent at or after firstSeenAt but not an earlier one", async () => {
    const clock = createFakeClock(1000)
    const intentPart = (intentAt: number) => ({
      type: "text" as const,
      text: JSON.stringify({ kind: "cancel-intent", intent_at: intentAt, job_id: "ses_job" }),
      synthetic: true,
      ignored: true,
    })
    const messageWithIntent = (intentAt: number): SdkMessageWithParts => ({
      info: { role: "assistant", id: "msg-j", sessionID: "ses_job" },
      parts: [intentPart(intentAt)],
    })

    const at = createFakeSdk({ sessions: baseSessions(), messages: { ses_job: [messageWithIntent(1000)] } })
    const atRegistry = new PermissionAskRegistry()
    atRegistry.onAsked({ requestID: "req-1", sessionID: "ses_child", directory: DIR, permission: "bash", patterns: ["ls"] }, 1000)
    expect((await createPendingAsksProbe(at, atRegistry, clock)(probeContext())).asks).toEqual([])

    const before = createFakeSdk({ sessions: baseSessions(), messages: { ses_job: [messageWithIntent(999)] } })
    const beforeRegistry = new PermissionAskRegistry()
    beforeRegistry.onAsked({ requestID: "req-1", sessionID: "ses_child", directory: DIR, permission: "bash", patterns: ["ls"] }, 1000)
    expect((await createPendingAsksProbe(before, beforeRegistry, clock)(probeContext())).asks).toHaveLength(1)
  })

  it("returns asks with isDispatchedSubsessionCaller true so an L1 observer can hold (Defect 2)", async () => {
    const fake = createFakeSdk({ sessions: baseSessions() })
    const registry = new PermissionAskRegistry()
    registry.dispatchedSessionIDs.add("ses_parent")
    const clock = createFakeClock(1000)
    registry.onAsked({ requestID: "req-1", sessionID: "ses_child", directory: DIR, permission: "bash", patterns: ["ls"] }, 1000)
    const result = await createPendingAsksProbe(fake, registry, clock)(probeContext())
    expect(result.isDispatchedSubsessionCaller).toBe(true)
    expect(result.asks).toHaveLength(1)
    expect(result.asks[0]?.requestID).toBe("req-1")
  })

  it('exposes an unknown caller status as a delay, then reveals the caller once readable (Defect 2)', async () => {
    const fake = createFakeSdk({
      sessions: [session("ses_job", undefined, `${DISPATCH_MARKER}coder`), session("ses_child", "ses_job", "attempt")],
    })
    const registry = new PermissionAskRegistry()
    const clock = createFakeClock(1000)
    registry.onAsked({ requestID: "req-1", sessionID: "ses_child", directory: DIR, permission: "bash", patterns: ["ls"] }, 1000)
    const probe = createPendingAsksProbe(fake, registry, clock)
    const context = { jobID: "ses_job", childSessionID: "ses_child", parentID: "ses_missing", role: "coder" as const }

    const delayed = await probe(context)
    expect(delayed.isDispatchedSubsessionCaller).toBe("unknown")
    expect(delayed.asks).toHaveLength(1)
    expect(delayed.asks[0]?.requestID).toBe("req-1")

    // The caller becomes readable on a later observation: the still-active ask
    // is kept and the status resolves instead of being dropped.
    fake.seedSession(session("ses_missing", undefined, "human"))
    const resolved = await probe(context)
    expect(resolved.isDispatchedSubsessionCaller).toBe(false)
    expect(resolved.asks).toHaveLength(1)
    expect(resolved.asks[0]?.requestID).toBe("req-1")
  })

  it("returns asks with allAlreadySurfacedInCurrentTurn true instead of suppressing them (Defect 2)", async () => {
    const human = (id: string): SdkMessageWithParts => ({
      info: { role: "user", id, sessionID: "ses_parent" },
      parts: [textPart("hello")],
    })
    const fake = createFakeSdk({ sessions: baseSessions(), messages: { ses_parent: [human("msg-1")] } })
    const registry = new PermissionAskRegistry()
    const clock = createFakeClock(1000)
    registry.onAsked({ requestID: "req-1", sessionID: "ses_child", directory: DIR, permission: "bash", patterns: ["ls"] }, 1000)
    registry.markSurfaced("req-1", { callerSessionID: "ses_parent", surfacedAtUserMessageID: "msg-1", surfacedAt: 1000 })

    const sameTurn = await createPendingAsksProbe(fake, registry, clock)(probeContext())
    expect(sameTurn.allAlreadySurfacedInCurrentTurn).toBe(true)
    expect(sameTurn.asks).toHaveLength(1)

    fake.seedMessages("ses_parent", [human("msg-2")])
    const nextTurn = await createPendingAsksProbe(fake, registry, clock)(probeContext())
    expect(nextTurn.allAlreadySurfacedInCurrentTurn).toBe(false)
    expect(nextTurn.asks).toHaveLength(1)
  })

  it("reconciles with a pull: evicts a stale pre-pull entry and adds the pulled ask", async () => {
    const fake = createFakeSdk({ seedPermission: true, sessions: baseSessions() })
    const registry = new PermissionAskRegistry()
    registry.onAsked({ requestID: "req-stale", sessionID: "ses_child", directory: DIR, permission: "bash", patterns: ["ls"] }, 1000)
    fake.permission!.seedAsks([pendingAsk({ id: "req-new", sessionID: "ses_child", permission: "edit", patterns: ["x"] })])
    const clock = createFakeClock(2000)
    const result = await createPendingAsksProbe(fake, registry, clock)(probeContext())
    expect(result.asks.map((ask) => ask.requestID)).toEqual(["req-new"])
    expect(registry.getActive(DIR).map((entry) => entry.requestID)).toEqual(["req-new"])
    expect(fake.permission!.calls.some((call: FakePermissionCall) => call.method === "list")).toBe(true)
  })

  it("falls back to registry records on pull outage, bounded by the outage grace window on both sides", async () => {
    const fake = createFakeSdk({ seedPermission: true, sessions: baseSessions() })
    fake.permission!.setListResult({ error: "down" })
    fake.v2!.session.permission.setListResult({ error: "down" })
    const registry = new PermissionAskRegistry()
    registry.onAsked({ requestID: "req-1", sessionID: "ses_child", directory: DIR, permission: "bash", patterns: ["ls"] }, 1000)

    const within = createFakeClock(1000 + REGISTRY_OUTAGE_GRACE_MS)
    expect((await createPendingAsksProbe(fake, registry, within)(probeContext())).asks).toHaveLength(1)

    const beyond = createFakeClock(1001 + REGISTRY_OUTAGE_GRACE_MS)
    expect((await createPendingAsksProbe(fake, registry, beyond)(probeContext())).asks).toEqual([])
  })
})
