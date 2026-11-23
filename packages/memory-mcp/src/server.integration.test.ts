import { afterEach, describe, expect, test } from "bun:test"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

const directories: string[] = []
const packageDirectory = new URL("..", import.meta.url).pathname

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })))
})

function parseTextContent(result: unknown): unknown {
  if (typeof result !== "object" || result === null || !("content" in result) || !Array.isArray(result.content)) {
    throw new Error("expected tool content")
  }
  const first = result.content[0]
  if (typeof first !== "object" || first === null || !("type" in first) || first.type !== "text" || !("text" in first) || typeof first.text !== "string") {
    throw new Error("expected text tool content")
  }
  return JSON.parse(first.text)
}

function assertObjectArrayElementSchema(tool: { readonly name: string }, property: string, requiredElementKey: string): void {
  const schema = (tool as unknown as { inputSchema?: unknown }).inputSchema
  if (typeof schema !== "object" || schema === null) throw new Error(`${tool.name}: expected an inputSchema`)
  const properties = (schema as { properties?: unknown }).properties
  if (typeof properties !== "object" || properties === null) throw new Error(`${tool.name}: expected inputSchema.properties`)
  const propertySchema = (properties as Record<string, unknown>)[property]
  if (typeof propertySchema !== "object" || propertySchema === null) throw new Error(`${tool.name}.${property}: expected an advertised property schema`)
  if ((propertySchema as { type?: unknown }).type !== "array") {
    throw new Error(`${tool.name}.${property}: expected advertised type "array"`)
  }
  const items = (propertySchema as { items?: unknown }).items
  if (typeof items !== "object" || items === null) {
    throw new Error(`${tool.name}.${property}: expected an advertised array element schema (found bare array)`)
  }
  if ((items as { type?: unknown }).type !== "object") {
    throw new Error(`${tool.name}.${property}: expected array element schema type "object"`)
  }
  const elementProperties = (items as { properties?: unknown }).properties
  if (typeof elementProperties !== "object" || elementProperties === null || Object.keys(elementProperties).length === 0) {
    throw new Error(`${tool.name}.${property}: expected non-empty element properties`)
  }
  if (!(requiredElementKey in (elementProperties as Record<string, unknown>))) {
    throw new Error(`${tool.name}.${property}: element properties missing ${requiredElementKey}`)
  }
}

describe("janus-memory-mcp stdio server", () => {
  test("persists, recalls, and forgets an item through all five registered tools", async () => {
    // given
    const directory = await mkdtemp(join(tmpdir(), "janus-memory-mcp-"))
    directories.push(directory)
    const transport = new StdioClientTransport({
      command: "bun",
      args: ["src/server.ts"],
      cwd: packageDirectory,
      env: {
        ...process.env,
        JANUS_DATA_DIR: directory,
        JANUS_STATE_DIR: directory,
        JANUS_CACHE_DIR: directory,
        JANUS_NAMESPACE: "integration-test",
      },
    })
    const client = new Client({ name: "memory-mcp-integration-test", version: "0.1.0" })
    await client.connect(transport)
    const draft = {
      hostSessionId: "host-session",
      title: "Tea choice",
      items: [{
        topicKey: "tea",
        title: "Tea choice",
        oneLineSummary: "Tea is calming.",
        claims: [{ claimType: "verifiable_fact", text: "Tea contains caffeine." }],
        decision: { conclusion: "Choose tea.", confidence: "medium", stability: "conditional" },
      }],
    }

    // when
    const tools = await client.listTools()
    const prepared = parseTextContent(await client.callTool({
      name: "memory_prepare",
      arguments: draft,
    }))
    const statsBeforeCommit = parseTextContent(await client.callTool({
      name: "memory_manage",
      arguments: { action: "stats" },
    }))
    if (typeof prepared !== "object" || prepared === null || !("previewToken" in prepared) || typeof prepared.previewToken !== "string") {
      throw new Error("expected a prepare preview token")
    }
    const committed = parseTextContent(await client.callTool({
      name: "memory_commit",
      arguments: {
        ...draft,
        previewToken: prepared.previewToken,
      },
    }))
    if (typeof committed !== "object" || committed === null || !("sessionExperienceId" in committed) || typeof committed.sessionExperienceId !== "string") {
      throw new Error("expected a committed session")
    }
    const replay = parseTextContent(await client.callTool({
      name: "memory_commit",
      arguments: {
        ...draft,
        previewToken: prepared.previewToken,
      },
    }))
    const recalled = parseTextContent(await client.callTool({
      name: "memory_recall",
      arguments: { text: "calming", tier: "standard" },
    }))
    const statsAfterCommit = parseTextContent(await client.callTool({
      name: "memory_manage",
      arguments: { action: "stats" },
    }))
    if (typeof committed !== "object" || committed === null || !("itemIds" in committed) || typeof committed.itemIds !== "object" || committed.itemIds === null || !("tea" in committed.itemIds) || typeof committed.itemIds.tea !== "string") {
      throw new Error("expected a committed tea item")
    }
    const forgotten = parseTextContent(await client.callTool({
      name: "memory_manage",
      arguments: { action: "forget", itemId: committed.itemIds.tea },
    }))
    const recalledAfterForget = parseTextContent(await client.callTool({
      name: "memory_recall",
      arguments: { text: "calming", tier: "standard" },
    }))

    // then
    expect(tools.tools.map((tool) => tool.name)).toEqual([
      "memory_recall",
      "memory_expand",
      "memory_prepare",
      "memory_commit",
      "memory_manage",
    ])
    const prepareTool = tools.tools.find((tool) => tool.name === "memory_prepare")
    const commitTool = tools.tools.find((tool) => tool.name === "memory_commit")
    if (prepareTool === undefined || commitTool === undefined) {
      throw new Error("expected memory_prepare and memory_commit tool definitions")
    }
    assertObjectArrayElementSchema(prepareTool, "items", "topicKey")
    assertObjectArrayElementSchema(prepareTool, "preferences", "key")
    assertObjectArrayElementSchema(commitTool, "items", "topicKey")
    assertObjectArrayElementSchema(commitTool, "preferences", "key")
    expect(statsBeforeCommit).toMatchObject({ action: "stats", sessions: 0 })
    expect(committed).toMatchObject({ created: true })
    expect(replay).toMatchObject({ created: false, sessionExperienceId: committed.sessionExperienceId })
    expect(recalled).toMatchObject({ candidates: [expect.objectContaining({ title: "Tea choice" })] })
    expect(statsAfterCommit).toMatchObject({ action: "stats", sessions: 1 })
    expect(forgotten).toEqual({ action: "forget", ok: true })
    expect(recalledAfterForget).toMatchObject({ candidates: [] })
    await client.close()
  })
})
