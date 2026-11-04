import { describe, expect, test } from "bun:test"
import { z } from "zod"

import {
  CONFIG_FIELDS,
  CONFIG_GROUPS,
  fieldDefault,
  resolveField,
  splitKey,
} from "./config-catalog.ts"
import { CONFIG_MODES, CONFIG_ROLES, CONFIG_TIERS, JanusPluginConfigSchema } from "./plugin-config.ts"

function unwrapObject(schema: z.ZodTypeAny): z.ZodObject<z.ZodRawShape> | undefined {
  let current: z.ZodTypeAny = schema
  while (current instanceof z.ZodOptional || current instanceof z.ZodDefault) {
    current = current instanceof z.ZodOptional ? current.unwrap() : current.removeDefault()
  }
  return current instanceof z.ZodObject ? current : undefined
}

describe("config catalog", () => {
  const shape = JanusPluginConfigSchema.shape

  test("every top-level schema key has a catalog entry", () => {
    for (const key of Object.keys(shape)) {
      expect(resolveField(key)?.field.key).toBe(key)
    }
  })

  test("every catalog entry is rooted in a schema key", () => {
    const topLevel = new Set(Object.keys(shape))
    for (const field of CONFIG_FIELDS) {
      expect(topLevel.has(splitKey(field.key)[0] ?? "")).toBe(true)
    }
  })

  test("every nested object child resolves", () => {
    for (const [key, schema] of Object.entries(shape)) {
      const object = unwrapObject(schema as z.ZodTypeAny)
      if (object === undefined) continue
      for (const [childKey, childSchema] of Object.entries(object.shape)) {
        const grandchild = unwrapObject(childSchema as z.ZodTypeAny)
        if (grandchild === undefined) {
          expect(resolveField(`${key}.${childKey}`)).toBeDefined()
          continue
        }
        for (const leaf of Object.keys(grandchild.shape)) {
          expect(resolveField(`${key}.${childKey}.${leaf}`)).toBeDefined()
        }
      }
    }
  })

  test("routing placeholders cover every mode, tier, and role", () => {
    for (const role of CONFIG_ROLES) {
      for (const mode of CONFIG_MODES) expect(resolveField(`mode_models.${mode}.${role}`)).toBeDefined()
      for (const tier of CONFIG_TIERS) expect(resolveField(`tier_models.${tier}.${role}`)).toBeDefined()
    }
    expect(resolveField("mode_models.unknown.coder")).toBeUndefined()
    expect(resolveField("tier_models.deep.builder")).toBeUndefined()
  })

  test("every field belongs to a known group", () => {
    const groups = new Set(CONFIG_GROUPS.map((group) => group.id))
    for (const field of CONFIG_FIELDS) expect(groups.has(field.group)).toBe(true)
  })

  test("hyphenated role prefixes resolve to the underscore key", () => {
    expect(resolveField("coder-lite_model")?.path).toEqual(["coder_lite_model"])
  })

  test("defaults come from the shipped constants", () => {
    const coder = resolveField("coder_model")
    expect(coder && fieldDefault(coder)).toBe("opencode-go/glm-5.3")
    const cap = resolveField("tier_role_caps.deep.consultant_analyst")
    expect(cap && fieldDefault(cap)).toBe(3)
    const tierCoder = resolveField("tier_models.deep.coder")
    expect(tierCoder && fieldDefault(tierCoder)).toBe("opencode-go/kimi-k3.1-pro")
  })
})
