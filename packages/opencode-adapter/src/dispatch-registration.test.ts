import { afterEach, beforeEach, describe, expect, it } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { setImmediate } from "node:timers/promises"
import type { ToolDefinition } from "@opencode-ai/plugin"
import * as dispatchTools from "./dispatch-tool.ts"
import { JanusAgentPlugin } from "./plugin.ts"
import { buildRuntimeBindings, buildCoderRuntimeBindings, buildJanusRuntimeBindings } from "./agent-registration.ts"
import { JanusPluginConfigSchema } from "./plugin-config.ts"
import { createFakeClock } from "./dispatch-test-fixtures.ts"
import { context, envelope, fixture, pluginInput } from "./dispatch-registration-fixtures.ts"

const { createJanusDispatchTools } = dispatchTools

describe("unified dispatch registration", () => {
  let directory: string
  let previousConfig: string | undefined
  beforeEach(() => {
    previousConfig = process.env.JANUS_CONFIG
    directory = mkdtempSync(join(tmpdir(), "dispatch-registration-"))
    process.env.JANUS_CONFIG = join(directory, "config.jsonc")
    writeFileSync(join(directory, "config.jsonc"), "{}")
  })
  afterEach(() => {
    if (previousConfig === undefined) delete process.env.JANUS_CONFIG
    else process.env.JANUS_CONFIG = previousConfig
    rmSync(directory, { recursive: true, force: true })
  })

  it("recovers a soft-expired dispatch through the shared wait tool", async () => {
    // Given a real coordinator set with an injected clock and active work.
    const f = fixture()
    const clock = createFakeClock()
    f.sdk.setStatusResult({ data: { ses_fake_1: { type: "busy" } } })
    const tools = createJanusDispatchTools(pluginInput(f.sdk).client, { clock })
    const launched = tools.janus_dispatch.execute({ role: "analyst", prompt: "analyze" }, context())
    await setImmediate()
    for (let i = 0; i < 300; i++) {
      await setImmediate()
      clock.advance(2_000)
    }
    const job = envelope(await launched)
    expect(job.status).toBe("pending")
    expect(f.aborts).toEqual([])
    f.finish()
    // When a later wait observes the same durable job.
    const result = await tools.janus_dispatch_wait.execute({ job_id: job.job_id, wait_ms: 0 }, context())
    // Then no replacement generation occurs.
    expect(result).toBe("final report")
    expect(f.submissions).toHaveLength(1)
  })

  for (const action of ["wait", "cancel"] as const) {
    it(`uses the plugin hook's ${action} tool on its dispatched job`, async () => {
      // Given an interrupted observation, not an interrupted specialist.
      const f = fixture()
      const controller = new AbortController()
      const submit = f.sdk.session.promptAsync
      f.sdk.session.promptAsync = async (input) => {
        const result = await submit(input)
        controller.abort()
        return result
      }
      const hooks = await JanusAgentPlugin(pluginInput(f.sdk))
      const tools = hooks.tool
      if (!tools) throw new Error("missing plugin tools")
      const dispatch = tools["janus_dispatch"]
      const control = tools[`janus_dispatch_${action}`]
      if (!dispatch || !control) throw new Error("missing job control tool")
      const job = envelope(await dispatch.execute({ role: "explorer", prompt: "search" }, context(controller.signal)))
      if (action === "wait") f.finish()
      else {
        const abort = f.sdk.session.abort
        f.sdk.session.abort = async (input) => {
          const result = await abort(input)
          f.finish("", true)
          return result
        }
      }
      // When controlling the job through the very same hook object.
      const result = await control.execute({ job_id: job.job_id, wait_ms: 0 }, context())
      // Then ownership and generation identity remain intact.
      if (action === "wait") expect(result).toBe("final report")
      else expect(envelope(result).status).toBe("cancelled")
      expect(f.submissions).toHaveLength(1)
      expect(f.aborts).toEqual(action === "cancel" ? [job.session_id] : [])
    })
  }

  it("ignores routing and ownership overrides in cancellation args", async () => {
    // Given a job belonging to another parent and malicious extra fields.
    const f = fixture()
    f.sdk.setPromptAsyncRejection(new Error("lost acknowledgement"))
    const tools = createJanusDispatchTools(pluginInput(f.sdk).client)
    const job = envelope(await tools.janus_dispatch.execute({ role: "writer", prompt: "draft" }, context()))
    expect(Object.keys(tools.janus_dispatch_cancel.args)).toEqual(["job_id"])
    expect(Object.keys(tools.janus_dispatch_wait.args)).toEqual(["job_id", "wait_ms"])
    // When the attacker supplies the actual owner in args instead of context.
    const maliciousArgs = {
      job_id: job.job_id, parentID: "ses_parent", role: "analyst", agent: "evil", model: "evil/model", wait_ms: 0,
    }
    const result = await tools.janus_dispatch_cancel.execute(maliciousArgs, { ...context(), sessionID: "ses_attacker" })
    // Then the context binding prevails and nothing is aborted/generated.
    expect(result).toMatch(/^Error:/)
    expect(f.aborts).toEqual([])
    expect(f.submissions).toHaveLength(1)
  })

  it("names all job-control tools in assembled runtime bindings", () => {
    // Given default role configuration.
    const config = JanusPluginConfigSchema.parse({})
    // When building runtime bindings consumed by the consultant.
    const bindings = buildRuntimeBindings(config, "oc-test")
    // Then routing-bearing structural tool names are available (no prose pin);
    // the consultant line names `janus_dispatch_continue` twice — once in the
    // job-tools list and once in the author-mode writer-session policy.
    expect(bindings.match(/`janus_dispatch(?:_wait|_cancel|_continue)?`/g)).toEqual([
      "`janus_dispatch`", "`janus_dispatch_wait`", "`janus_dispatch_cancel`", "`janus_dispatch_continue`", "`janus_dispatch_continue`",
    ])
    expect(bindings).toContain("`return_handle: true`")
    expect(bindings).toContain("`writer_session_id`")
    const coderBindings = buildCoderRuntimeBindings(config)
    expect(coderBindings).toContain("`janus_dispatch_continue`")
    expect(coderBindings).toContain("`return_handle: true`")
    const janusBindings = buildJanusRuntimeBindings(config)
    expect(janusBindings).toContain("`janus_dispatch_continue`")
    expect(janusBindings).toContain("`return_handle: true`")
  })

  it("registers the continue tool with a session_id/prompt/role arg surface", () => {
    // Given the shared factory.
    const f = fixture()
    const tools = createJanusDispatchTools(pluginInput(f.sdk).client)
    // Then the fourth job tool is present with exactly the contract args.
    expect(Object.keys(tools)).toEqual(["janus_dispatch", "janus_dispatch_wait", "janus_dispatch_cancel", "janus_dispatch_continue"])
    expect(Object.keys(tools.janus_dispatch.args)).toEqual(["role", "prompt", "return_handle", "mode", "tier", "protocol"])
    expect(Object.keys(tools.janus_dispatch_continue.args)).toEqual(["session_id", "prompt", "role"])
    expect(tools.janus_dispatch_continue.description).toContain("session_id")
  })

  it("continues an owned writer session through the shared factory", async () => {
    // Given a completed writer dispatch captured through return_handle.
    const f = fixture()
    const submit = f.sdk.session.promptAsync
    f.sdk.session.promptAsync = async (input) => {
      const result = await submit(input)
      f.finish()
      return result
    }
    const tools = createJanusDispatchTools(pluginInput(f.sdk).client)
    const dispatchResult = await tools.janus_dispatch.execute(
      { role: "writer", prompt: "draft chapter one", return_handle: true },
      context(),
    )
    const parsed = envelope(dispatchResult)
    if (parsed.status !== "completed") throw new Error(`expected completed envelope: ${JSON.stringify(parsed)}`)
    // When continuing the writer's session with a maintenance prompt.
    const result = await tools.janus_dispatch_continue.execute(
      { session_id: parsed.session_id, prompt: "apply the review fix", role: "writer" },
      context(),
    )
    // Then the same session is prompted again and the result is plain text.
    expect(result).toBe("final report")
    expect(f.submissions.map((s) => s.sessionID)).toEqual([parsed.session_id, parsed.session_id])
  })

  it("rejects a continue from a foreign caller with zero extra prompts", async () => {
    // Given a completed writer job owned by ses_parent.
    const f = fixture()
    const submit = f.sdk.session.promptAsync
    f.sdk.session.promptAsync = async (input) => {
      const result = await submit(input)
      f.finish()
      return result
    }
    const tools = createJanusDispatchTools(pluginInput(f.sdk).client)
    const dispatchResult = await tools.janus_dispatch.execute(
      { role: "writer", prompt: "draft chapter one", return_handle: true },
      context(),
    )
    const parsed = envelope(dispatchResult)
    if (parsed.status !== "completed") throw new Error("expected completed envelope")
    // When a different caller session tries to reuse it.
    const result = await tools.janus_dispatch_continue.execute(
      { session_id: parsed.session_id, prompt: "apply the review fix" },
      { ...context(), sessionID: "ses_attacker" },
    )
    // Then ownership prevails and no prompt is issued.
    expect(result).toMatch(/^Error: target dispatch session is not owned by this caller/)
    expect(f.submissions).toHaveLength(1)
  })

  for (const scenario of [
    { role: "explorer", field: "explorer", agent: "explorer", model: "opencode-go/deepseek-v4.1-flash" },
    { role: "arch-critic", field: "arch_critic", agent: "arch-critic", model: "opencode/gemini-3.8-flash" },
    { role: "ask-lite", field: "ask_lite", agent: "ask-lite", model: "opencode-go/deepseek-v4.1-flash" },
  ] as const) {
    for (const custom of [false, true]) {
      it(`routes ${scenario.role} through the shared factory with ${custom ? "custom" : "default"} configuration`, async () => {
        // Given distinct default/override routes and a completed specialist.
        const agent = custom ? `custom-${scenario.role}` : scenario.agent
        const model = custom ? `custom/${scenario.role}` : scenario.model
        if (custom) writeFileSync(join(directory, "config.jsonc"), JSON.stringify({
          [`${scenario.field}_agent`]: agent, [`${scenario.field}_model`]: model,
        }))
        const f = fixture()
        const submit = f.sdk.session.promptAsync
        f.sdk.session.promptAsync = async (input) => {
          const result = await submit(input)
          f.finish()
          return result
        }
        const tools = createJanusDispatchTools(pluginInput(f.sdk).client)
        // When dispatching the configured role.
        const result = await tools.janus_dispatch.execute({ role: scenario.role, prompt: "bounded task" }, context())
        // Then the actual generating request uses the selected route.
        expect(result).toBe("final report")
        expect(f.submissions.map((s) => ({ agent: s.body.agent, model: s.body.model }))).toEqual([{
          agent, model: { providerID: model.split("/")[0] ?? "", modelID: model.split("/")[1] ?? "" },
        }])
      })
    }
  }

  it("rejects an invalid role without SDK access", async () => {
    // Given an unsupported role arriving at the execution boundary.
    const f = fixture()
    const tools = createJanusDispatchTools(pluginInput(f.sdk).client)
    // When dispatching an invalid role.
    const dispatch: ToolDefinition = tools.janus_dispatch
    const result = await dispatch.execute({ role: "general", prompt: "task" }, context())
    // Then no child or generating request is created.
    expect(result).toMatch(/^Error:/)
    expect(f.sdk.calls).toEqual([])
  })

  for (const pinned of [false, true]) {
    it(`retains the disabled-bundled writer delegate override with ${pinned ? "a pinned model" : "host model selection"}`, async () => {
      // Given a delegate whose configuration differs from the bundled fallback.
      writeFileSync(join(directory, "config.jsonc"), JSON.stringify({
        writer_enabled: false, writer_delegate_agent: "host-writer",
        ...(pinned ? { writer_delegate_model: "delegate/pinned" } : {}),
      }))
      const f = fixture()
      const submit = f.sdk.session.promptAsync
      f.sdk.session.promptAsync = async (input) => {
        const result = await submit(input)
        f.finish()
        return result
      }
      const tools = createJanusDispatchTools(pluginInput(f.sdk).client)
      // When dispatching the delegated writer despite the bundled disable flag.
      const result = await tools.janus_dispatch.execute({ role: "writer", prompt: "draft" }, context())
      // Then host routing, optional model pinning and single-attempt semantics survive.
      expect(result).toBe("final report")
      expect(f.submissions.map((s) => ({ agent: s.body.agent, model: s.body.model }))).toEqual([{
        agent: "host-writer", model: pinned ? { providerID: "delegate", modelID: "pinned" } : undefined,
      }])
    })
  }
})
