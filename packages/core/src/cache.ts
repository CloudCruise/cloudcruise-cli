import { readFileSync } from "node:fs"
import { buildView, isSpec, type Surface, type View } from "./spec.js"

export interface SpecCacheOptions {
  /** Sent as X-CloudCruise-Client on spec requests, e.g. `mcp/0.1.0`. */
  client: string
  /** How long a fetched spec is used before it is checked again. Default 5 minutes. */
  ttlMs?: number
  /** How long to wait after a failed fetch before trying again. Default 30 seconds. */
  retryMs?: number
  /** Spec to serve when none has been fetched yet and the fetch fails. Default: the one bundled with this package. */
  snapshot?: () => unknown
  now?: () => number
}

interface Entry {
  spec?: Record<string, unknown>
  etag?: string
  freshUntil: number
  inflight?: Promise<void>
  views: Map<Surface, View>
}

const EMPTY_SPEC = { openapi: "3.0.0", paths: {} }

function bundledSnapshot(): unknown {
  return JSON.parse(readFileSync(new URL("./openapi.snapshot.json", import.meta.url), "utf8"))
}

/**
 * The API spec per base URL. It holds nothing about any caller and fetches the spec
 * without a token, so one cache can serve every user in a process.
 */
export class SpecCache {
  private readonly options: Readonly<Required<SpecCacheOptions>>
  private readonly entries = new Map<string, Entry>()

  constructor(options: SpecCacheOptions) {
    this.options = Object.freeze({
      ttlMs: 5 * 60_000,
      retryMs: 30_000,
      snapshot: bundledSnapshot,
      now: Date.now,
      ...options
    })
  }

  /** The surface's operations, refreshing the spec first if it is older than the TTL. */
  async view(baseUrl: string, surface: Surface): Promise<View> {
    return this.load(baseUrl, surface, false)
  }

  /** The surface's operations after checking the spec now, whatever its age. */
  async revalidate(baseUrl: string, surface: Surface): Promise<View> {
    return this.load(baseUrl, surface, true)
  }

  private async load(baseUrl: string, surface: Surface, force: boolean): Promise<View> {
    let entry = this.entries.get(baseUrl)
    if (!entry) {
      entry = { freshUntil: 0, views: new Map() }
      this.entries.set(baseUrl, entry)
    }
    if (force || !entry.spec || this.options.now() >= entry.freshUntil) {
      const e = entry
      e.inflight ??= this.refresh(baseUrl, e).finally(() => {
        e.inflight = undefined
      })
      await e.inflight
    }
    let view = entry.views.get(surface)
    if (!view) {
      view = buildView(entry.spec ?? EMPTY_SPEC, surface)
      entry.views.set(surface, view)
    }
    return view
  }

  private async refresh(baseUrl: string, entry: Entry): Promise<void> {
    const headers: Record<string, string> = {
      Accept: "application/json",
      "X-CloudCruise-Client": this.options.client
    }
    if (entry.spec && entry.etag) headers["If-None-Match"] = entry.etag
    try {
      const res = await fetch(`${baseUrl}/openapi.json`, { headers })
      if (res.status === 304 && entry.spec) {
        entry.freshUntil = this.options.now() + this.options.ttlMs
        return
      }
      if (!res.ok) throw new Error(`spec fetch failed (${res.status})`)
      const spec: unknown = await res.json()
      if (!isSpec(spec)) throw new Error("spec is not an OpenAPI document")
      this.replace(entry, spec, res.headers.get("etag") ?? undefined)
      entry.freshUntil = this.options.now() + this.options.ttlMs
    } catch {
      // Keep serving what we have; with nothing yet, fall back to the snapshot.
      if (!entry.spec) {
        let snapshot: unknown
        try {
          snapshot = this.options.snapshot()
        } catch {
          snapshot = undefined
        }
        this.replace(entry, isSpec(snapshot) ? snapshot : EMPTY_SPEC, undefined)
      }
      entry.freshUntil = this.options.now() + this.options.retryMs
    }
  }

  private replace(entry: Entry, spec: Record<string, unknown>, etag: string | undefined): void {
    entry.spec = spec
    entry.etag = etag
    entry.views.clear()
  }
}
