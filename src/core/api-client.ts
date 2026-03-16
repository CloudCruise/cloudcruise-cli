import { ResolvedAuth } from "./auth.js"

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
      "cc-key": this.auth.apiKey,
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
      const body = await res.text()
      throw new Error(`GET ${path} failed (${res.status}): ${body}`)
    }
    return res.json() as Promise<T>
  }

  async getStream(path: string): Promise<Response> {
    const res = await fetch(this.url(path), {
      method: "GET",
      headers: this.headers()
    })
    if (!res.ok) {
      const body = await res.text()
      throw new Error(`GET ${path} failed (${res.status}): ${body}`)
    }
    return res
  }

  async post<T = unknown>(path: string, body?: unknown): Promise<T> {
    const hasBody = body !== undefined
    const headers: Record<string, string> = { "cc-key": this.auth.apiKey }
    if (hasBody) {
      headers["Content-Type"] = "application/json"
    }
    const res = await fetch(this.url(path), {
      method: "POST",
      headers,
      body: hasBody ? JSON.stringify(body) : undefined
    })
    if (!res.ok) {
      const text = await res.text()
      throw new Error(`POST ${path} failed (${res.status}): ${text}`)
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
      const text = await res.text()
      throw new Error(`PUT ${path} failed (${res.status}): ${text}`)
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
      const text = await res.text()
      throw new Error(`PATCH ${path} failed (${res.status}): ${text}`)
    }
    return res.json() as Promise<T>
  }

  sseUrl(path: string): string {
    return this.url(path)
  }

  get apiKey(): string {
    return this.auth.apiKey
  }
}
