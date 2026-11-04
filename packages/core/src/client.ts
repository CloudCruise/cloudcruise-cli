/**
 * Error thrown for non-2xx API responses. Carries the HTTP status and, when the
 * body is a JSON error envelope, the machine-readable `code` (e.g. SESSION_BUSY,
 * ALREADY_ANSWERED) so callers can map it to a distinct exit code.
 */
export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly body: string
  /** What to do next, set by a caller that knows the context of the failure. */
  hint?: string

  constructor(message: string, status: number, body: string, code?: string) {
    super(message)
    this.name = "ApiError"
    this.status = status
    this.body = body
    this.code = code
  }

  static async from(
    method: string,
    path: string,
    res: Response
  ): Promise<ApiError> {
    const body = await res.text()
    let code: string | undefined
    try {
      const parsed = JSON.parse(body) as { code?: unknown }
      if (parsed && typeof parsed === "object" && typeof parsed.code === "string") {
        code = parsed.code
      }
    } catch {
      // Non-JSON body — no code to extract.
    }
    return new ApiError(
      `${method} ${path} failed (${res.status}): ${body}`,
      res.status,
      body,
      code
    )
  }
}

export interface StrataClientOptions {
  /** API origin, e.g. https://api.cloudcruise.com. Required: core never defaults to prod. */
  baseUrl: string
  /** The caller's credential. Fixed for the life of the client. */
  token: string
  authScheme: "bearer" | "api-key"
  /** Sent as x-workspace-id when set. */
  workspaceId?: string
  /** Sent as X-CloudCruise-Client, e.g. `cli/1.16.1`. */
  client: string
  /** Sent as X-CloudCruise-Agent when set, e.g. `claude`. */
  agent?: string
}

/**
 * HTTP client for the CloudCruise API. Everything it sends comes from the options
 * passed to its constructor, which are frozen: one process can serve many users by
 * building one client per caller.
 */
export class StrataClient {
  private readonly options: Readonly<StrataClientOptions>

  constructor(options: StrataClientOptions) {
    this.options = Object.freeze({ ...options })
  }

  private url(path: string): string {
    return `${this.options.baseUrl}${path}`
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return {
      ...this.authHeaders(),
      "Content-Type": "application/json",
      ...extra
    }
  }

  async get<T = unknown>(path: string): Promise<T> {
    const res = await fetch(this.url(path), {
      method: "GET",
      headers: this.headers()
    })
    if (!res.ok) {
      throw await ApiError.from("GET", path, res)
    }
    return res.json() as Promise<T>
  }

  async getStream(path: string): Promise<Response> {
    const res = await fetch(this.url(path), {
      method: "GET",
      headers: this.headers()
    })
    if (!res.ok) {
      throw await ApiError.from("GET", path, res)
    }
    return res
  }

  async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    const hasBody = body !== undefined
    const headers: Record<string, string> = this.authHeaders()
    if (hasBody) {
      headers["Content-Type"] = "application/json"
    }
    const res = await fetch(this.url(path), {
      method: "POST",
      headers,
      body: hasBody ? JSON.stringify(body) : undefined
    })
    if (!res.ok) {
      throw await ApiError.from("POST", path, res)
    }
    return res.json() as Promise<T>
  }

  async put<T = unknown>(path: string, body: unknown): Promise<T> {
    const res = await fetch(this.url(path), {
      method: "PUT",
      headers: this.headers(),
      body: JSON.stringify(body)
    })
    if (!res.ok) {
      throw await ApiError.from("PUT", path, res)
    }
    return res.json() as Promise<T>
  }

  async patch<T = unknown>(path: string, body: unknown): Promise<T> {
    const res = await fetch(this.url(path), {
      method: "PATCH",
      headers: this.headers(),
      body: JSON.stringify(body)
    })
    if (!res.ok) {
      throw await ApiError.from("PATCH", path, res)
    }
    return res.json() as Promise<T>
  }

  async delete<T = unknown>(path: string): Promise<T> {
    const res = await fetch(this.url(path), {
      method: "DELETE",
      headers: this.headers()
    })
    if (!res.ok) {
      throw await ApiError.from("DELETE", path, res)
    }
    const body = await res.text()
    return (body ? JSON.parse(body) : undefined) as T
  }

  authHeaders(extra?: Record<string, string>): Record<string, string> {
    const { token, authScheme, workspaceId, client, agent } = this.options
    return {
      "X-CloudCruise-Client": client,
      ...(agent ? { "X-CloudCruise-Agent": agent } : {}),
      ...(authScheme === "bearer"
        ? { Authorization: `Bearer ${token}` }
        : { "cc-key": token }),
      ...(workspaceId ? { "x-workspace-id": workspaceId } : {}),
      ...extra
    }
  }
}
