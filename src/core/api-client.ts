import { ResolvedAuth } from "./auth.js"

/**
 * Error thrown for non-2xx API responses. Carries the HTTP status and, when the
 * body is a JSON error envelope, the machine-readable `code` (e.g. SESSION_BUSY,
 * ALREADY_ANSWERED) so callers can map it to a distinct exit code.
 */
export class ApiError extends Error {
  readonly status: number
  readonly code?: string
  readonly body: string

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

export class ApiClient {
  private auth: ResolvedAuth

  constructor(auth: ResolvedAuth) {
    this.auth = auth
  }

  private url(path: string): string {
    return `${this.auth.baseUrl}${path}`
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
    return res.json() as Promise<T>
  }

  authHeaders(extra?: Record<string, string>): Record<string, string> {
    return {
      ...(this.auth.authScheme === "bearer"
        ? { Authorization: `Bearer ${this.auth.token}` }
        : { "cc-key": this.auth.token }),
      ...(this.auth.workspaceId ? { "x-workspace-id": this.auth.workspaceId } : {}),
      ...extra
    }
  }
}
