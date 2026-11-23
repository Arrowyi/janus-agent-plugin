// Contract test: MEMORY_TOOL_DEFINITIONS must stay in 1:1 structural parity
// with the Zod validation schemas in schemas.ts. This file walks the Zod v3
// `_def` AST directly (no zod import, no new dependencies) under these
// normalization rules:
// - ZodEffects unwraps to `_def.schema` (a `.refine()` has no provider-safe
//   JSON Schema form and is covered by an explicit description instead).
// - ZodOptional / ZodDefault unwrap for property-value comparison; a property
//   key is in JSON Schema `required[]` iff its outer Zod schema is neither
//   ZodOptional nor ZodDefault.
// - JSON Schema `type: "integer"` matches a ZodNumber with an int check or a
//   ZodUnion of integer ZodLiterals; `type: "number"` matches ZodNumber with
//   or without `.int()`.
// - ZodEnum / ZodUnion of ZodLiteral: JSON Schema `enum` equals the values
//   array in order.
// - ZodArray: `type: "array"` with a defined `items` matching `_def.type`
//   recursively, plus `maxItems` from `_def.maxLength?.value` when defined.
// - ZodObject: `type: "object"`, exact properties key-set equality, exact
//   required set equality, no `additionalProperties`, recursive parity.
// Every advertised node may only carry the provider-safe keys: type /
// properties / required / items / enum / maxItems / description.

import { describe, expect, test } from "bun:test"
import {
  commitInputSchema,
  expandInputSchema,
  manageInputSchema,
  prepareInputSchema,
  recallInputSchema,
} from "./schemas.ts"
import { MEMORY_TOOL_DEFINITIONS, MEMORY_TOOL_NAMES, SOURCE_META_JSON_SCHEMA } from "./tools.ts"

type ZodDef = {
  readonly typeName?: unknown
  readonly shape?: unknown
  readonly innerType?: unknown
  readonly type?: unknown
  readonly maxLength?: unknown
  readonly values?: unknown
  readonly options?: unknown
  readonly value?: unknown
  readonly checks?: unknown
  readonly schema?: unknown
}

type ZodLike = { readonly _def: ZodDef }

type AdvertisedSchema = { readonly [key: string]: unknown }

const PROVIDER_SAFE_KEYS = new Set(["type", "properties", "required", "items", "enum", "maxItems", "description"])

const TOOL_INPUT_SCHEMAS: Readonly<Record<string, unknown>> = {
  memory_recall: recallInputSchema,
  memory_expand: expandInputSchema,
  memory_prepare: prepareInputSchema,
  memory_commit: commitInputSchema,
  memory_manage: manageInputSchema,
}

function defOf(schema: unknown, path: string): ZodDef {
  if (typeof schema !== "object" || schema === null || Array.isArray(schema) || !("_def" in schema)) {
    throw new Error(`${path}: not a zod schema node`)
  }
  return (schema as ZodLike)._def
}

function typeNameOf(schema: unknown, path: string): string {
  const name = defOf(schema, path).typeName
  return typeof name === "string" ? name : ""
}

function objectShapeOf(schema: unknown, path: string): Record<string, unknown> {
  const shape = defOf(schema, path).shape
  if (typeof shape !== "function") throw new Error(`${path}: expected a ZodObject with _def.shape()`)
  return (shape as () => Record<string, unknown>)()
}

function hasIntCheck(schema: unknown, path: string): boolean {
  const checks = defOf(schema, path).checks
  if (!Array.isArray(checks)) return false
  return checks.some(
    (check) => typeof check === "object" && check !== null && (check as { kind?: unknown }).kind === "int",
  )
}

function unwrapForComparison(schema: unknown, path: string): unknown {
  let current = schema
  while (true) {
    const name = typeNameOf(current, path)
    if (name === "ZodEffects") {
      const inner = defOf(current, path).schema
      if (inner === undefined) throw new Error(`${path}: ZodEffects without _def.schema`)
      current = inner
      continue
    }
    if (name === "ZodOptional" || name === "ZodDefault") {
      const inner = defOf(current, path).innerType
      if (inner === undefined) throw new Error(`${path}: ${name} without _def.innerType`)
      current = inner
      continue
    }
    return current
  }
}

function isOptionalProperty(schema: unknown, path: string): boolean {
  let current = schema
  while (true) {
    const name = typeNameOf(current, path)
    if (name === "ZodOptional" || name === "ZodDefault") return true
    if (name === "ZodEffects") {
      const inner = defOf(current, path).schema
      if (inner === undefined) throw new Error(`${path}: ZodEffects without _def.schema`)
      current = inner
      continue
    }
    return false
  }
}

function assertProviderSafeKeys(node: unknown, path: string): void {
  if (typeof node !== "object" || node === null || Array.isArray(node)) {
    throw new Error(`${path}: expected a JSON Schema object`)
  }
  for (const key of Object.keys(node)) {
    if (!PROVIDER_SAFE_KEYS.has(key)) throw new Error(`${path}: non provider-safe key "${key}"`)
  }
  const record = node as AdvertisedSchema
  const properties = record["properties"]
  if (typeof properties === "object" && properties !== null) {
    for (const [key, value] of Object.entries(properties)) {
      assertProviderSafeKeys(value, `${path}.properties.${key}`)
    }
  }
  if (record["items"] !== undefined) assertProviderSafeKeys(record["items"], `${path}.items`)
}

function expectParity(zodSchema: unknown, advertised: unknown, path: string): void {
  const zod = unwrapForComparison(zodSchema, path)
  if (typeof advertised !== "object" || advertised === null || Array.isArray(advertised)) {
    throw new Error(`${path}: expected an advertised JSON Schema object, got ${String(advertised)}`)
  }
  const node = advertised as AdvertisedSchema
  const name = typeNameOf(zod, path)
  switch (name) {
    case "ZodString":
      expect(node).toEqual({ type: "string" })
      return
    case "ZodBoolean":
      expect(node).toEqual({ type: "boolean" })
      return
    case "ZodNumber": {
      if (node["type"] === "integer") {
        if (!hasIntCheck(zod, path)) throw new Error(`${path}: advertised integer but the zod number has no int check`)
        expect(node).toEqual({ type: "integer" })
        return
      }
      expect(node).toEqual({ type: "number" })
      return
    }
    case "ZodEnum": {
      const values = defOf(zod, path).values
      expect(node).toEqual({ type: "string", enum: values })
      return
    }
    case "ZodUnion": {
      const options = defOf(zod, path).options
      if (!Array.isArray(options) || options.length === 0) throw new Error(`${path}: expected a ZodUnion with options`)
      if (!options.every((option) => typeNameOf(option, path) === "ZodLiteral")) {
        throw new Error(`${path}: only unions of zod literals are supported`)
      }
      const values = options.map((option) => defOf(option, path).value)
      const allNumbers = values.every((value) => typeof value === "number")
      expect(node).toEqual(allNumbers ? { type: "integer", enum: values } : { type: "string", enum: values })
      return
    }
    case "ZodArray": {
      const maxLength = defOf(zod, path).maxLength
      const maxValue = typeof maxLength === "object" && maxLength !== null ? (maxLength as { value?: unknown }).value : undefined
      const hasMaxItems = typeof maxValue === "number"
      expect(Object.keys(node).sort()).toEqual(hasMaxItems ? ["items", "maxItems", "type"] : ["items", "type"])
      expect(node["type"]).toBe("array")
      const advertisedItems = node["items"]
      if (advertisedItems === undefined) throw new Error(`${path}: advertised array without an items schema`)
      expectParity(defOf(zod, path).type, advertisedItems, `${path}.items`)
      if (hasMaxItems) {
        expect(node["maxItems"]).toBe(maxValue)
      }
      return
    }
    case "ZodObject": {
      expect(node["type"]).toBe("object")
      expect("additionalProperties" in node).toBe(false)
      const shape = objectShapeOf(zod, path)
      const properties = node["properties"]
      if (typeof properties !== "object" || properties === null || Array.isArray(properties)) {
        throw new Error(`${path}: advertised object without a properties record`)
      }
      expect(Object.keys(properties).sort()).toEqual(Object.keys(shape).sort())
      const expectedRequired = Object.keys(shape)
        .filter((key) => !isOptionalProperty(shape[key], `${path}.${key}`))
        .sort()
      const advertisedRequired = Array.isArray(node["required"]) ? (node["required"] as unknown[]).map(String) : []
      expect(advertisedRequired.sort()).toEqual(expectedRequired)
      for (const [key, propertySchema] of Object.entries(shape)) {
        expectParity(propertySchema, (properties as AdvertisedSchema)[key], `${path}.properties.${key}`)
      }
      return
    }
    default:
      throw new Error(`${path}: unsupported zod type ${name === "" ? "(unnamed)" : name}`)
  }
}

describe("memory tool advertised schema parity", () => {
  for (const tool of MEMORY_TOOL_DEFINITIONS) {
    const inputSchema = TOOL_INPUT_SCHEMAS[tool.name]
    if (inputSchema === undefined) throw new Error(`no zod input schema mapped for ${tool.name}`)

    test(`${tool.name} inputSchema uses provider-safe keys only`, () => {
      assertProviderSafeKeys(tool.inputSchema, tool.name)
    })

    test(`${tool.name} advertised inputSchema matches its zod schema 1:1`, () => {
      expectParity(inputSchema, tool.inputSchema, tool.name)
    })
  }

  test("parity cases cover exactly the five advertised tools", () => {
    expect(new Set(MEMORY_TOOL_DEFINITIONS.map((t) => t.name))).toEqual(new Set([
      "memory_recall",
      "memory_expand",
      "memory_prepare",
      "memory_commit",
      "memory_manage",
    ]))
    expect(new Set(MEMORY_TOOL_NAMES)).toEqual(new Set([
      "memory_recall",
      "memory_expand",
      "memory_prepare",
      "memory_commit",
      "memory_manage",
    ]))
    expect(new Set(Object.keys(TOOL_INPUT_SCHEMAS))).toEqual(new Set(MEMORY_TOOL_NAMES))
  })

  test("source meta advertises the url-or-stableId refine contract", () => {
    expect(SOURCE_META_JSON_SCHEMA.required).toEqual(["title", "accessedAt"])
    expect(SOURCE_META_JSON_SCHEMA.description).toBe(
      "Source metadata; at least one of url or stableId must be provided.",
    )
  })
})
