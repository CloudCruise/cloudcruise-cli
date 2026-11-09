import { SearchIndex } from "./search.js"

export type Surface = "cli" | "mcp"

export type JsonSchema = Record<string, unknown>

/** MCP's tool-annotation names, copied from the operation's `x-strata-hints`. */
export interface Hints {
  readOnlyHint: boolean
  destructiveHint: boolean
  idempotentHint: boolean
  openWorldHint: boolean
}

/** What search returns: everything an agent needs to call the operation. */
export interface Operation {
  /** Stable dotted name from `x-strata-name`, e.g. `runs.start`. */
  name: string
  summary?: string
  description?: string
  hints: Hints
  /** The arguments `call` takes: path and query parameters, plus `body`. */
  input: JsonSchema
  /** The first 2xx JSON response schema, when the spec has one. */
  output?: JsonSchema
}

/** An operation plus what `call` needs to build the request. */
export interface Plan {
  operation: Operation
  method: string
  path: string
  pathParams: string[]
  queryParams: string[]
  /** JSON of `input`, compared before and after a refresh to detect a change. */
  inputKey: string
  /** The operation's OpenAPI tags. */
  tags: string[]
  /** Text search matches besides the name, summary and description. */
  keywords: string
}

/** The operations one surface can reach in one spec, and their search index. */
export interface View {
  plans: Map<string, Plan>
  /** Tags of the reachable operations, in the spec's tag order. */
  categories: string[]
  index: SearchIndex
  /** False when no spec has been fetched yet: the view is empty because the API is unreachable. */
  loaded: boolean
}

type Obj = Record<string, unknown>

const METHODS = ["get", "put", "post", "delete", "patch"] as const
// Unknown hints get the most cautious reading.
const SAFE_HINTS: Readonly<Hints> = {
  readOnlyHint: false,
  destructiveHint: true,
  idempotentHint: false,
  openWorldHint: true
}
const MAX_REF_DEPTH = 32
const DROPPED_KEYS = new Set(["nullable", "example", "discriminator", "xml", "externalDocs"])

function isObj(value: unknown): value is Obj {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** True when the value looks enough like an OpenAPI document to build a view from. */
export function isSpec(value: unknown): value is Obj {
  return isObj(value) && isObj(value.paths)
}

function resolveRef(doc: Obj, ref: string): unknown {
  if (!ref.startsWith("#/")) return undefined
  let node: unknown = doc
  for (const part of ref.slice(2).split("/")) {
    if (!isObj(node)) return undefined
    node = node[part.replace(/~1/g, "/").replace(/~0/g, "~")]
  }
  return node
}

function deref(doc: Obj, value: unknown): unknown {
  let node = value
  for (let i = 0; i < MAX_REF_DEPTH && isObj(node) && typeof node.$ref === "string"; i++) {
    node = resolveRef(doc, node.$ref)
  }
  return node
}

/**
 * Converts an OpenAPI 3.0 schema to plain JSON Schema: `$ref`s are copied in place,
 * `nullable` becomes a `null` type, and OpenAPI-only keys are dropped.
 */
export function toJsonSchema(doc: Obj, schema: unknown, seen: readonly string[] = []): JsonSchema {
  if (!isObj(schema)) return {}
  if (typeof schema.$ref === "string") {
    // A recursive type stops at its second appearance on the same branch.
    if (seen.includes(schema.$ref) || seen.length >= MAX_REF_DEPTH) return {}
    return toJsonSchema(doc, resolveRef(doc, schema.$ref), [...seen, schema.$ref])
  }
  const convert = (v: unknown) => toJsonSchema(doc, v, seen)
  const out: JsonSchema = {}
  for (const [key, value] of Object.entries(schema)) {
    if (DROPPED_KEYS.has(key) || key.startsWith("x-")) continue
    if (key === "properties" && isObj(value)) {
      out.properties = Object.fromEntries(Object.entries(value).map(([k, v]) => [k, convert(v)]))
    } else if ((key === "items" || key === "not" || key === "additionalProperties") && isObj(value)) {
      out[key] = convert(value)
    } else if ((key === "allOf" || key === "oneOf" || key === "anyOf") && Array.isArray(value)) {
      out[key] = value.map(convert)
    } else {
      out[key] = structuredClone(value)
    }
  }
  if (schema.nullable === true) {
    if (typeof out.type === "string") {
      out.type = [out.type, "null"]
      if (Array.isArray(out.enum) && !out.enum.includes(null)) out.enum = [...out.enum, null]
    } else if (out.type === undefined) {
      return { anyOf: [out, { type: "null" }] }
    }
  }
  return out
}

function readHints(value: unknown): Hints {
  if (!isObj(value)) return { ...SAFE_HINTS }
  const keys = Object.keys(SAFE_HINTS) as (keyof Hints)[]
  if (!keys.every((k) => typeof value[k] === "boolean")) return { ...SAFE_HINTS }
  return Object.fromEntries(keys.map((k) => [k, value[k]])) as unknown as Hints
}

function jsonContentSchema(content: unknown): unknown {
  return isObj(content) && isObj(content["application/json"])
    ? content["application/json"].schema
    : undefined
}

function outputSchema(doc: Obj, responses: unknown): JsonSchema | undefined {
  if (!isObj(responses)) return undefined
  const codes = Object.keys(responses).filter((c) => /^2\d\d$/.test(c)).sort()
  for (const code of codes) {
    const response = deref(doc, responses[code])
    const schema = isObj(response) ? jsonContentSchema(response.content) : undefined
    if (schema !== undefined) return toJsonSchema(doc, schema)
  }
  return undefined
}

function buildPlan(doc: Obj, path: string, method: string, item: Obj, op: Obj): Plan | undefined {
  const name = op["x-strata-name"]
  if (typeof name !== "string" || !name) return undefined

  // Operation-level parameters override path-level ones with the same name and location.
  const params = new Map<string, Obj>()
  for (const raw of [
    ...(Array.isArray(item.parameters) ? item.parameters : []),
    ...(Array.isArray(op.parameters) ? op.parameters : [])
  ]) {
    const param = deref(doc, raw)
    if (isObj(param) && typeof param.name === "string") params.set(`${param.in}:${param.name}`, param)
  }

  const properties: Record<string, JsonSchema> = {}
  const required: string[] = []
  const pathParams: string[] = []
  const queryParams: string[] = []
  for (const param of params.values()) {
    const paramName = param.name as string
    if (param.in !== "path" && param.in !== "query") {
      // call never sends headers or cookies from arguments, so it couldn't send this one.
      if (param.required === true) return undefined
      continue
    }
    if (paramName === "body") return undefined
    const schema = toJsonSchema(doc, param.schema)
    if (typeof param.description === "string" && schema.description === undefined) {
      schema.description = param.description
    }
    properties[paramName] = schema
    if (param.in === "path") {
      pathParams.push(paramName)
      required.push(paramName)
    } else {
      queryParams.push(paramName)
      if (param.required === true) required.push(paramName)
    }
  }

  const requestBody = deref(doc, op.requestBody)
  const bodySchema = isObj(requestBody) ? jsonContentSchema(requestBody.content) : undefined
  if (bodySchema !== undefined) {
    properties.body = toJsonSchema(doc, bodySchema)
    if (isObj(requestBody) && requestBody.required === true) required.push("body")
  }

  const input: JsonSchema = { type: "object", properties, additionalProperties: false }
  if (required.length) input.required = required
  const tags = Array.isArray(op.tags) ? op.tags.filter((t): t is string => typeof t === "string") : []

  const operation: Operation = {
    name,
    ...(typeof op.summary === "string" ? { summary: op.summary } : {}),
    ...(typeof op.description === "string" ? { description: op.description } : {}),
    hints: readHints(op["x-strata-hints"]),
    input
  }
  const output = outputSchema(doc, op.responses)
  if (output) operation.output = output

  return {
    // Views are shared by every caller in the process; no caller may change them.
    operation: deepFreeze(operation),
    method: method.toUpperCase(),
    path,
    pathParams,
    queryParams,
    inputKey: JSON.stringify(input),
    tags,
    keywords: keywords(path, properties, tags)
  }
}

/**
 * Parameter names, descriptions and enum values, the body's top-level field names
 * and enum values, the path's literal segments, and the tags.
 */
function keywords(path: string, properties: Record<string, JsonSchema>, tags: string[]): string {
  const words: string[] = [...path.split("/").filter((s) => s && !s.startsWith("{")), ...tags]
  for (const [name, schema] of Object.entries(properties)) {
    if (name === "body") {
      for (const [field, fieldSchema] of Object.entries(isObj(schema.properties) ? schema.properties : {})) {
        words.push(field, ...enumWords(fieldSchema))
      }
      continue
    }
    words.push(name, ...enumWords(schema))
    if (typeof schema.description === "string") words.push(schema.description)
  }
  return words.join(" ")
}

function enumWords(schema: unknown): string[] {
  if (!isObj(schema)) return []
  const values = Array.isArray(schema.enum)
    ? schema.enum
    : isObj(schema.items) && Array.isArray(schema.items.enum)
      ? schema.items.enum
      : []
  return values.filter((v): v is string => typeof v === "string")
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value)
    for (const v of Object.values(value)) deepFreeze(v)
  }
  return value
}

/** The operations exposed on `surface`, keyed by their Strata name. */
export function buildView(doc: Obj, surface: Surface): View {
  const plans = new Map<string, Plan>()
  for (const [path, item] of Object.entries(isObj(doc.paths) ? doc.paths : {})) {
    if (!isObj(item)) continue
    for (const method of METHODS) {
      const op = item[method]
      if (!isObj(op)) continue
      const surfaces = op["x-strata-surfaces"]
      if (!Array.isArray(surfaces) || !surfaces.includes(surface)) continue
      const plan = buildPlan(doc, path, method, item, op)
      if (plan && !plans.has(plan.operation.name)) plans.set(plan.operation.name, plan)
    }
  }
  const declared = Array.isArray(doc.tags)
    ? doc.tags.map((t) => (isObj(t) ? t.name : undefined)).filter((t): t is string => typeof t === "string")
    : []
  const used = new Set([...plans.values()].flatMap((p) => p.tags))
  const categories = [...declared.filter((t) => used.has(t)), ...[...used].filter((t) => !declared.includes(t))]
  return {
    plans,
    categories,
    index: new SearchIndex([...plans.values()].map(({ operation, keywords }) => ({ operation, keywords }))),
    loaded: true
  }
}
