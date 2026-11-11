import type { SpecCache } from "./cache.js"
import { ApiError, type StrataClient } from "./client.js"
import type { Operation, Plan, Surface } from "./spec.js"

export type CallErrorKind =
  | "unknown_operation"
  | "not_read_only"
  | "invalid_arguments"
  | "api_changed"
  | "api_error"
  | "unavailable"

/**
 * Why `call` failed, with a message written for the agent that made the call. It
 * never mentions spec versions, caching or the API host.
 */
export class CallError extends Error {
  readonly kind: CallErrorKind
  /** HTTP status, when the API answered. */
  readonly status?: number
  /** The operation as it is now, when the message includes its schema. */
  readonly operation?: Operation

  constructor(kind: CallErrorKind, message: string, extra: { status?: number; operation?: Operation } = {}) {
    super(message)
    this.name = "CallError"
    this.kind = kind
    this.status = extra.status
    this.operation = extra.operation
  }
}

export interface StrataOptions {
  /** The caller's client: its token and workspace are used for every call. */
  client: StrataClient
  surface: Surface
  /** Shared by every Strata in the process. */
  specs: SpecCache
}

export interface SearchOptions {
  /** Default 5, at most 10. */
  limit?: number
}

export interface CallOptions {
  /** Refuse, without sending, any operation that is not read-only. */
  readOnly?: boolean
}

export interface CallResult {
  status: number
  data: unknown
}

const DEFAULT_LIMIT = 5
const MAX_LIMIT = 10
const MAX_API_MESSAGE = 1000

/** Finds and calls the API operations exposed on one surface, as one caller. */
export class Strata {
  private readonly options: Readonly<StrataOptions>

  constructor(options: StrataOptions) {
    this.options = Object.freeze({ ...options })
  }

  async search(query: string, options: SearchOptions = {}): Promise<Operation[]> {
    const limit = Math.min(Math.max(1, options.limit ?? DEFAULT_LIMIT), MAX_LIMIT)
    const view = await this.view(false)
    return view.index.search(query, limit)
  }

  /**
   * Sends one request for the named operation. Never retries: when the API rejects
   * a request, the error says why and the caller decides whether to call again.
   */
  async call(name: string, args: unknown, options: CallOptions = {}): Promise<CallResult> {
    let plan = (await this.view(false)).plans.get(name)
    if (!plan) {
      const view = await this.view(true)
      plan = view.plans.get(name)
      if (!plan && !view.loaded) {
        throw new CallError("unavailable", `Could not reach the CloudCruise API for ${name}.`)
      }
      if (!plan) {
        throw new CallError("unknown_operation", `No operation named ${name}. Search for it.`)
      }
    }
    checkReadOnly(plan, options)

    const problems = checkShape(plan, args)
    if (problems.length) {
      // The agent may hold a schema from before a change: if the arguments fit the
      // operation as it is now, send them.
      const current = await this.current(plan)
      if (current.inputKey === plan.inputKey) {
        throw new CallError(
          "invalid_arguments",
          `Your arguments for ${name} don't fit: ${problems.join("; ")}. Schema: ${schemaText(plan.operation)}`,
          { operation: plan.operation }
        )
      }
      if (checkShape(current, args).length) throw changed(current)
      plan = current
      checkReadOnly(plan, options)
    }

    const operation = plan.operation
    const { path, body } = buildRequest(plan, args as Record<string, unknown>)
    try {
      return await this.options.client.request(plan.method, path, body)
    } catch (err) {
      if (!(err instanceof ApiError)) {
        const warning = operation.hints.readOnlyHint
          ? ""
          : " It may have run; check before calling it again."
        throw new CallError("unavailable", `Could not reach the CloudCruise API for ${name}.${warning}`)
      }
      if (err.status >= 400 && err.status < 500) {
        const current = await this.current(plan)
        if (current.inputKey !== plan.inputKey) throw changed(current)
      }
      const detail = apiMessage(err)
      if (err.status === 400 || err.status === 422) {
        throw new CallError(
          "api_error",
          `The API rejected the arguments for ${name} (${err.status}): ${detail}. Schema: ${schemaText(operation)}`,
          { status: err.status, operation }
        )
      }
      throw new CallError("api_error", `${name} failed (${err.status}): ${detail}`, { status: err.status })
    }
  }

  private view(force: boolean) {
    const { client, surface, specs } = this.options
    return force ? specs.revalidate(client.baseUrl, surface) : specs.view(client.baseUrl, surface)
  }

  /** The operation after checking the spec now; throws `api_changed` if it is gone. */
  private async current(plan: Plan): Promise<Plan> {
    const name = plan.operation.name
    const current = (await this.view(true)).plans.get(name)
    if (!current) {
      throw new CallError("api_changed", `${name} no longer exists. Search again.`)
    }
    return current
  }
}

function changed(current: Plan): CallError {
  const { operation } = current
  return new CallError(
    "api_changed",
    `${operation.name} changed since you looked it up. Current schema: ${schemaText(operation)} Fix your arguments and call again.`,
    { operation }
  )
}

function checkReadOnly(plan: Plan, options: CallOptions): void {
  const { operation } = plan
  if (options.readOnly && !operation.hints.readOnlyHint) {
    throw new CallError("not_read_only", `${operation.name} changes data, so it can't be called here.`, {
      operation
    })
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isScalar(value: unknown): value is string | number | boolean {
  return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
}

/** The checks needed to build the request. The API validates the values. */
function checkShape(plan: Plan, args: unknown): string[] {
  if (!isRecord(args)) return ["arguments must be an object"]
  const input = plan.operation.input
  const properties = (input.properties ?? {}) as Record<string, unknown>
  const required = (input.required ?? []) as string[]
  const problems: string[] = []
  for (const key of Object.keys(args)) {
    if (!Object.hasOwn(properties, key)) problems.push(`unknown argument \`${key}\``)
  }
  for (const key of required) {
    if (args[key] === undefined) problems.push(`missing \`${key}\``)
  }
  for (const key of plan.pathParams) {
    const value = args[key]
    if (value === undefined) continue
    if (!isScalar(value)) {
      problems.push(`\`${key}\` must be a string or number`)
    } else if (["", ".", ".."].includes(String(value))) {
      // fetch would collapse these and send the request to a different path.
      problems.push(`\`${key}\` can't be "${String(value)}"`)
    } else if (!isEncodable(String(value))) {
      problems.push(`\`${key}\` contains characters that can't go in a URL`)
    }
  }
  for (const key of plan.queryParams) {
    const value = args[key]
    if (value === undefined || isScalar(value)) continue
    if (!Array.isArray(value) || !value.every(isScalar)) {
      problems.push(`\`${key}\` must be a string, number, boolean or a list of them`)
    }
  }
  return problems
}

/** False for strings encodeURIComponent rejects, such as an unpaired surrogate. */
function isEncodable(value: string): boolean {
  try {
    encodeURIComponent(value)
    return true
  } catch {
    return false
  }
}

function buildRequest(plan: Plan, args: Record<string, unknown>): { path: string; body?: unknown } {
  let path = plan.path
  for (const key of plan.pathParams) {
    path = path.replaceAll(`{${key}}`, encodeURIComponent(String(args[key])))
  }
  const query = new URLSearchParams()
  for (const key of plan.queryParams) {
    const value = args[key]
    if (value === undefined) continue
    for (const v of Array.isArray(value) ? value : [value]) query.append(key, String(v))
  }
  const qs = query.toString()
  return { path: qs ? `${path}?${qs}` : path, body: args.body }
}

function schemaText(operation: Operation): string {
  return JSON.stringify(operation.input)
}

/** The API's own error message: `message` from a JSON error body, else the body text. */
function apiMessage(err: ApiError): string {
  let text = err.body
  try {
    const parsed = JSON.parse(err.body) as unknown
    if (isRecord(parsed)) {
      const message = parsed.message
      if (typeof message === "string") text = message
      else if (Array.isArray(message)) text = message.map(String).join("; ")
    }
  } catch {
    // Not JSON: use the body as it is.
  }
  text = text.trim() || "no details"
  return text.length > MAX_API_MESSAGE ? `${text.slice(0, MAX_API_MESSAGE)}…` : text
}
