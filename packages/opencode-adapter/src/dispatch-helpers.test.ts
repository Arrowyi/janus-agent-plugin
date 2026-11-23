import { describe, expect, it } from "bun:test"
import { DISPATCH_ROLES } from "./dispatch-contract.ts"
import {
  ROLE_MODEL_FIELDS,
  buildChainFailureMessage,
  embedsProviderErrorText,
  isProviderErrorText,
  makeEnvelope,
  modelFailureHint,
  observationToOutcome,
} from "./dispatch-helpers.ts"

describe("isProviderErrorText", () => {
  it("recognizes provider error names and rejects the unrecognized fallback", () => {
    expect(isProviderErrorText("APIError: 402")).toBe(true)
    expect(isProviderErrorText("ProviderAuthError: 401")).toBe(true)
    expect(isProviderErrorText("unrecognized provider error")).toBe(false)
  })
})

describe("embedsProviderErrorText", () => {
  it("matches a provider error embedded in wrapper text and rejects plain wrappers", () => {
    expect(embedsProviderErrorText("promptAsync failed: UnknownError: 404")).toBe(true)
    expect(embedsProviderErrorText("promptAsync failed: APIError: 402")).toBe(true)
    expect(embedsProviderErrorText("promptAsync failed: unrecognized provider error")).toBe(false)
    expect(embedsProviderErrorText("failed to persist attempt reservation: journal write was rejected by host")).toBe(false)
    expect(embedsProviderErrorText("UnknownError: 404")).toBe(false)
  })
})

describe("modelFailureHint", () => {
  it("names the model and the config override field", () => {
    const hint = modelFailureHint("common-explorer", "opencode-go/deepseek-v4.1-flash")
    expect(hint).toContain("(model: opencode-go/deepseek-v4.1-flash)")
    expect(hint).toContain('set "common_explorer_model"')
    expect(hint).toContain("~/.config/janus-agent/config.jsonc")
    expect(hint).toContain("$JANUS_CONFIG")
  })

  it("maps hyphenated roles to their underscored config fields", () => {
    expect(modelFailureHint("coder", "opencode-go/glm-5.3")).toContain('set "coder_model"')
    expect(modelFailureHint("tech-lead", "opencode-go/glm-5.3")).toContain('set "tech_lead_model"')
    expect(modelFailureHint("solution-reviewer", "opencode/claude-sonnet-5-5")).toContain('set "solution_reviewer_model"')
    expect(modelFailureHint("simple", null)).toContain('set "simple_model"')
    expect(modelFailureHint("consultant", null)).toContain('set "consultant_model"')
    expect(modelFailureHint("author", null)).toContain('set "author_model"')
  })

  it("maps every dispatch role to a model config field", () => {
    for (const role of DISPATCH_ROLES) {
      expect(ROLE_MODEL_FIELDS[role].length).toBeGreaterThan(0)
    }
  })

  it("omits the model label when the model is null", () => {
    expect(modelFailureHint("simple", null)).not.toContain("(model:")
  })
})

describe("observationToOutcome failure hint", () => {
  it("appends the hint to provider-error failures", () => {
    const outcome = observationToOutcome(
      { kind: "failed", error: "APIError: 402", retryable: false },
      "ses_job",
      "common-explorer",
      { index: 0, model: "opencode-go/deepseek-v4.1-flash", sessionID: "ses_child" },
      100,
    )
    expect(outcome.kind).toBe("failure")
    if (outcome.kind === "failure") {
      expect(outcome.reason).toContain("common-explorer dispatch failed: APIError: 402")
      expect(outcome.reason).toContain("(model: opencode-go/deepseek-v4.1-flash)")
      expect(outcome.reason).toContain('set "common_explorer_model"')
    }
  })

  it("does not append the hint to non-provider failures", () => {
    const outcome = observationToOutcome(
      { kind: "failed", error: "unrecognized provider error", retryable: false },
      "ses_job",
      "consultant-analyst",
      { index: 0, model: "opencode-go/qwen3.8-max", sessionID: "ses_child" },
      100,
    )
    expect(outcome.kind).toBe("failure")
    if (outcome.kind === "failure") {
      expect(outcome.reason).toBe("consultant-analyst dispatch failed: unrecognized provider error")
    }
  })
})

describe("buildChainFailureMessage hint", () => {
  it("carries the hint for provider errors", () => {
    const message = buildChainFailureMessage("author-writer", ["opencode/claude-sonnet-5-5", "opencode-go/glm-5.3"], "APIError: 402")
    expect(message).toContain("failed on every model in the chain")
    expect(message).toContain('set "author_writer_model"')
    expect(message).toContain("degrade by answering inline")
  })

  it("stays unchanged for non-provider errors", () => {
    const message = buildChainFailureMessage("author-writer", ["opencode/claude-sonnet-5-5"], "unrecognized provider error")
    expect(message).not.toContain("Hint:")
  })

  it("names the author_reviewer_model field for the author-reviewer role", () => {
    const message = buildChainFailureMessage("author-reviewer", ["opencode-go/kimi-k3.1-pro"], "APIError: 429")
    expect(message).toContain('set "author_reviewer_model"')
    expect(message).toContain("degrade by answering inline")
  })
})

function envelopeOf(outcome: ReturnType<typeof makeEnvelope>, kind: "nonterminal") {
  if (outcome.kind !== kind) throw new Error(`expected ${kind}`)
  return outcome.envelope
}

describe("health envelope fields and stalled reasons", () => {
  it("spreads only validated, defined health fields onto the envelope", () => {
    const envelope = envelopeOf(makeEnvelope(
      "pending",
      "ses_job",
      "consultant-analyst",
      { index: 0, model: null },
      "ses_child",
      100,
      "waiting",
      { last_activity_ms: 5_000, running_tool: " grep ", running_tool_ms: 4_000, session_status: "busy", stalled_suspect: true },
    ), "nonterminal")
    expect(envelope.last_activity_ms).toBe(5_000)
    expect(envelope.running_tool).toBe("grep")
    expect(envelope.running_tool_ms).toBe(4_000)
    expect(envelope.session_status).toBe("busy")
    expect(envelope.stalled_suspect).toBe(true)
  })

  it("drops invalid or blank health values", () => {
    const envelope = envelopeOf(makeEnvelope(
      "pending",
      "ses_job",
      "consultant-analyst",
      { index: 0, model: null },
      "ses_child",
      100,
      "waiting",
      { last_activity_ms: -1, running_tool: "   ", running_tool_ms: 1.5, session_status: "paused" as never },
    ), "nonterminal")
    expect("last_activity_ms" in envelope).toBe(false)
    expect("running_tool" in envelope).toBe(false)
    expect("running_tool_ms" in envelope).toBe(false)
    expect("session_status" in envelope).toBe(false)
  })

  it("emits the running-tool stalled reason", () => {
    const outcome = observationToOutcome(
      { kind: "pending", diagnostics: { stalled_suspect: true, running_tool: "grep", running_tool_ms: 310_000, last_activity_ms: 310_000, session_status: "busy" } },
      "ses_job", "consultant-analyst", { index: 0, model: null, sessionID: "ses_child" }, 1_000,
    )
    const envelope = envelopeOf(outcome as ReturnType<typeof makeEnvelope>, "nonterminal")
    expect(envelope.reason).toBe('tool "grep" has been running for 310000ms without new activity (stalled_suspect); call janus_dispatch_wait to keep waiting or janus_dispatch_cancel to abort')
  })

  it("emits the no-tool stalled reason", () => {
    const outcome = observationToOutcome(
      { kind: "pending", diagnostics: { stalled_suspect: true, last_activity_ms: 305_000 } },
      "ses_job", "consultant-analyst", { index: 0, model: null, sessionID: "ses_child" }, 1_000,
    )
    const envelope = envelopeOf(outcome as ReturnType<typeof makeEnvelope>, "nonterminal")
    expect(envelope.reason).toBe("no specialist activity for 305000ms (stalled_suspect); call janus_dispatch_wait to keep waiting or janus_dispatch_cancel to abort")
  })

  it("quotes an age at or above the threshold for a blank-name stalled tool with a sub-threshold activity gap", () => {
    const outcome = observationToOutcome(
      { kind: "pending", diagnostics: { stalled_suspect: true, running_tool_ms: 310_000, last_activity_ms: 20_000, session_status: "busy" } },
      "ses_job", "consultant-analyst", { index: 0, model: null, sessionID: "ses_child" }, 1_000,
    )
    const envelope = envelopeOf(outcome as ReturnType<typeof makeEnvelope>, "nonterminal")
    expect(envelope.reason).toBe("no specialist activity for 310000ms (stalled_suspect); call janus_dispatch_wait to keep waiting or janus_dispatch_cancel to abort")
    expect(envelope.reason).not.toContain("20000")
    expect(envelope.running_tool).toBeUndefined()
    expect(envelope.running_tool_ms).toBe(310_000)
  })

  it("never adds a stalled reason on a locally aborted observation", () => {
    const outcome = observationToOutcome(
      { kind: "pending", diagnostics: { aborted: true, stalled_suspect: true, running_tool: "grep", running_tool_ms: 400_000 } },
      "ses_job", "consultant-analyst", { index: 0, model: null, sessionID: "ses_child" }, 1_000,
    )
    const envelope = envelopeOf(outcome as ReturnType<typeof makeEnvelope>, "nonterminal")
    expect(envelope.reason).toBe("observation aborted")
    expect(envelope.stalled_suspect).toBe(true)
  })

  it("uses the observation reason for cancelled and falls back to the default", () => {
    const withReason = observationToOutcome(
      { kind: "cancelled", reason: "child session stopped by host before response completed" },
      "ses_job", "consultant-analyst", { index: 0, model: null, sessionID: "ses_child" }, 10,
    )
    if (withReason.kind !== "cancelled") throw new Error("expected cancelled")
    expect(withReason.envelope.reason).toBe("child session stopped by host before response completed")
    const defaulted = observationToOutcome(
      { kind: "cancelled" },
      "ses_job", "consultant-analyst", { index: 0, model: null, sessionID: "ses_child" }, 10,
    )
    if (defaulted.kind !== "cancelled") throw new Error("expected cancelled")
    expect(defaulted.envelope.reason).toBe("dispatch was cancelled")
  })

  it("forwards diagnostics on unknown envelopes", () => {
    const outcome = observationToOutcome(
      { kind: "unknown", reason: "no durable progress", diagnostics: { session_status: "idle", last_activity_ms: 12_000 } },
      "ses_job", "consultant-analyst", { index: 0, model: null, sessionID: "ses_child" }, 10,
    )
    const envelope = envelopeOf(outcome as ReturnType<typeof makeEnvelope>, "nonterminal")
    expect(envelope.status).toBe("unknown")
    expect(envelope.session_status).toBe("idle")
    expect(envelope.last_activity_ms).toBe(12_000)
  })
})
