import { readFileSync } from "node:fs"
import { SpecCache, Strata, StrataClient, type Surface } from "../dist/index.js"

export const BASE = "https://api.example.test"

export function fixture(): any {
  return JSON.parse(readFileSync(new URL("./fixtures/openapi.json", import.meta.url), "utf8"))
}

export interface ApiCall {
  method: string
  url: string
  headers: Headers
  body?: unknown
}

/**
 * A fake backend behind globalThis.fetch. `spec` and `api` can be swapped between
 * requests to simulate a deploy or a failure.
 */
export interface FakeBackend {
  spec: any
  etag: string
  /** Status for spec requests; "throw" simulates a network failure. */
  specFailure?: number | "throw"
  /** Answers API requests; default 200 `{}`. Throw to simulate a network failure. */
  api: (call: ApiCall) => Response
  specRequests: Headers[]
  apiCalls: ApiCall[]
}

export function fakeBackend(): FakeBackend {
  const backend: FakeBackend = {
    spec: fixture(),
    etag: 'W/"v1"',
    api: () => Response.json({}),
    specRequests: [],
    apiCalls: []
  }
  globalThis.fetch = (async (input: string | URL, init: RequestInit = {}) => {
    const url = String(input)
    const headers = new Headers(init.headers)
    await new Promise((resolve) => setTimeout(resolve, 0))
    if (url === `${BASE}/openapi.json`) {
      backend.specRequests.push(headers)
      if (backend.specFailure === "throw") throw new TypeError("fetch failed")
      if (backend.specFailure) return new Response("down", { status: backend.specFailure })
      if (headers.get("if-none-match") === backend.etag) return new Response(null, { status: 304 })
      return Response.json(backend.spec, { headers: { ETag: backend.etag } })
    }
    const call: ApiCall = {
      method: init.method ?? "GET",
      url,
      headers,
      body: init.body ? JSON.parse(String(init.body)) : undefined
    }
    backend.apiCalls.push(call)
    return backend.api(call)
  }) as typeof fetch
  return backend
}

export interface Clock {
  now: number
}

export function setup(
  options: { surface?: Surface; token?: string; specs?: SpecCache; clock?: Clock } = {}
) {
  const clock = options.clock ?? { now: 0 }
  const specs =
    options.specs ??
    new SpecCache({ client: "test/1.0.0", now: () => clock.now, snapshot: () => ({ openapi: "3.0.0", paths: {} }) })
  const client = new StrataClient({
    baseUrl: BASE,
    token: options.token ?? "tok",
    authScheme: "bearer",
    client: "test/1.0.0"
  })
  const strata = new Strata({ client, surface: options.surface ?? "mcp", specs })
  return { strata, specs, clock }
}

/** The fixture with one operation edited, as after a backend deploy. */
export function editOperation(spec: any, path: string, method: string, edit: (op: any) => void): any {
  const copy = structuredClone(spec)
  edit(copy.paths[path][method])
  return copy
}
