import type { Config } from "./config.js"

/**
 * What the API says about an OAuth grant token of a user with MFA.
 * - none: serve the request.
 * - required: the user hasn't confirmed this connector with their authenticator; every tool answers with the link.
 * - refresh: they have; the token in hand is still aal1, so the client must refresh to get an aal2 one.
 */
export type StepUp = { status: "none" } | { status: "refresh" } | { status: "required"; url: string }

const NONE: StepUp = { status: "none" }
const CACHE_TTL_MS = 10 * 60 * 1000
const CACHE_MAX = 10_000
const TIMEOUT_MS = 3000

interface Claims {
  aal?: unknown
  client_id?: unknown
  session_id?: unknown
}

// Supabase issues every OAuth grant at aal1, even when the user passed MFA before
// consent, and RLS hides workspace data from an aal1 session of an MFA user. The API
// parks the token and runs the step-up when the user enters their code on the dashboard.
export class StepUpGate {
  // Sessions of users without MFA, so they pay one API call per session per replica.
  private readonly none = new Map<string, number>()

  constructor(private readonly config: Config) {}

  async check(token: string): Promise<StepUp> {
    const claims = decode(token)
    if (!claims || claims.aal !== "aal1" || typeof claims.client_id !== "string" || typeof claims.session_id !== "string") {
      return NONE
    }
    const sessionId = claims.session_id
    const cachedUntil = this.none.get(sessionId)
    if (cachedUntil !== undefined && cachedUntil > Date.now()) return NONE

    const answer = await this.ask(token)
    if (!answer) return NONE
    if (answer.status === "none") this.remember(sessionId)
    return answer
  }

  // Fails open: if the API is unreachable or predates the endpoint, the request is
  // served as before and the API still authorizes every call. A failure is never
  // cached, so the next request asks again.
  private async ask(token: string): Promise<StepUp | undefined> {
    try {
      const res = await fetch(`${this.config.apiBaseUrl}/mcp/step-up`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}` },
        signal: AbortSignal.timeout(TIMEOUT_MS)
      })
      if (!res.ok) return undefined
      const body = (await res.json()) as { status?: unknown; url?: unknown }
      if (body.status === "none") return NONE
      if (body.status === "refresh") return { status: "refresh" }
      if (body.status === "required" && typeof body.url === "string") return { status: "required", url: body.url }
      return undefined
    } catch {
      return undefined
    }
  }

  private remember(sessionId: string): void {
    if (this.none.size >= CACHE_MAX) {
      const oldest = this.none.keys().next().value
      if (oldest !== undefined) this.none.delete(oldest)
    }
    this.none.delete(sessionId)
    this.none.set(sessionId, Date.now() + CACHE_TTL_MS)
  }
}

// Unverified: used only to route the request. The API verifies the token on every call.
function decode(token: string): Claims | undefined {
  const payload = token.split(".")[1]
  if (!payload) return undefined
  try {
    const claims: unknown = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"))
    return claims && typeof claims === "object" ? (claims as Claims) : undefined
  } catch {
    return undefined
  }
}

export function stepUpMessage(url: string): string {
  return [
    "Your CloudCruise account uses two-factor authentication, and this connector isn't confirmed yet.",
    `Open ${url} and enter the code from your authenticator app, then run the request again.`,
    "The link expires in 10 minutes; any tool call after that gives a new one."
  ].join(" ")
}
