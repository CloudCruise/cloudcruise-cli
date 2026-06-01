import { test, beforeEach, afterEach } from "node:test"
import assert from "node:assert/strict"
import { createServer } from "node:net"
import {
  resolveOAuthSettings,
  decodeAccessToken,
  fetchMfaFactors,
  challengeMfaFactor,
  verifyMfaChallenge,
  runBrowserAuthFlow,
  type OAuthSettings,
} from "../dist/src/core/oauth.js"

// ---- helpers ---------------------------------------------------------------

const PROD_ISSUER = "https://hrcczpkvvknatvtuwksw.supabase.co/auth/v1"
const STAGING_ISSUER = "https://pzxtgorsekxsydltstsb.supabase.co/auth/v1"
const PROD_KEY = "sb_publishable_KhdyLTPNx1GZjxjmh--VBg_kUaADMek"
const STAGING_KEY = "sb_publishable_YkTsnwUXuylAHRfk6hZuGw_rs8Kz1zB"

function b64url(input: string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "")
}

// Minimal unsigned JWT with the given payload — decodeAccessToken only reads
// the payload segment, it never verifies the signature.
function makeJwt(payload: Record<string, unknown>): string {
  return `${b64url(JSON.stringify({ alg: "none", typ: "JWT" }))}.${b64url(
    JSON.stringify(payload),
  )}.sig`
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer()
    s.once("error", reject)
    s.listen(0, "127.0.0.1", () => {
      const addr = s.address()
      const port = typeof addr === "object" && addr ? addr.port : 0
      s.close(() => resolve(port))
    })
  })
}

// Clear env that resolveOAuthSettings reads so tests are deterministic
// regardless of the shell that runs them.
const OAUTH_ENV_KEYS = [
  "CLOUDCRUISE_OAUTH_ISSUER",
  "CLOUDCRUISE_OAUTH_CLIENT_ID",
  "CLOUDCRUISE_BASE_URL",
  "CLOUDCRUISE_OAUTH_ANON_KEY",
  "CLOUDCRUISE_OAUTH_SCOPE",
  "CLOUDCRUISE_ENV",
  "CLOUDCRUISE_OAUTH_TOKEN_AUTH_METHOD",
]
let savedEnv: Record<string, string | undefined> = {}
beforeEach(() => {
  savedEnv = {}
  for (const k of OAUTH_ENV_KEYS) {
    savedEnv[k] = process.env[k]
    delete process.env[k]
  }
})
afterEach(() => {
  for (const k of OAUTH_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
})

const baseOpts = {
  clientId: "test-client",
  baseUrl: "https://api.example.com",
}

// ---- decodeAccessToken -----------------------------------------------------

test("decodeAccessToken returns the JWT payload claims", () => {
  const claims = decodeAccessToken(makeJwt({ aal: "aal2", sub: "u1" }))
  assert.equal(claims.aal, "aal2")
  assert.equal(claims.sub, "u1")
})

test("decodeAccessToken returns {} for a malformed token", () => {
  assert.deepEqual(decodeAccessToken("not-a-jwt"), {})
})

// ---- resolveOAuthSettings: anon-key resolution -----------------------------

test("resolveOAuthSettings uses the built-in anon key for the prod issuer", () => {
  const s = resolveOAuthSettings({ ...baseOpts, issuer: PROD_ISSUER })
  assert.equal(s.anonKey, PROD_KEY)
})

test("resolveOAuthSettings uses the built-in anon key for the staging issuer", () => {
  const s = resolveOAuthSettings({ ...baseOpts, issuer: STAGING_ISSUER })
  assert.equal(s.anonKey, STAGING_KEY)
})

test("resolveOAuthSettings leaves anonKey undefined for an unknown issuer", () => {
  const s = resolveOAuthSettings({
    ...baseOpts,
    issuer: "https://custom.example.com/auth/v1",
  })
  assert.equal(s.anonKey, undefined)
})

test("explicit --anon-key overrides the built-in key", () => {
  const s = resolveOAuthSettings({
    ...baseOpts,
    issuer: PROD_ISSUER,
    anonKey: "sb_publishable_override",
  })
  assert.equal(s.anonKey, "sb_publishable_override")
})

test("CLOUDCRUISE_OAUTH_ANON_KEY overrides the built-in key, opts overrides env", () => {
  process.env.CLOUDCRUISE_OAUTH_ANON_KEY = "sb_publishable_env"
  assert.equal(
    resolveOAuthSettings({ ...baseOpts, issuer: PROD_ISSUER }).anonKey,
    "sb_publishable_env",
  )
  assert.equal(
    resolveOAuthSettings({
      ...baseOpts,
      issuer: PROD_ISSUER,
      anonKey: "sb_publishable_opt",
    }).anonKey,
    "sb_publishable_opt",
  )
})

// ---- resolveOAuthSettings: built-in endpoint defaults ----------------------

test("resolveOAuthSettings defaults to the bundled prod endpoints with no opts/env", () => {
  const s = resolveOAuthSettings({})
  assert.equal(s.issuer, PROD_ISSUER)
  assert.equal(s.clientId, "9bc36be8-60c1-4138-94d7-e5d9a9659e2b")
  assert.equal(s.baseUrl, "https://api.cloudcruise.com")
  assert.equal(s.anonKey, PROD_KEY)
})

test("explicit --issuer/--client-id/--base-url override the bundled defaults", () => {
  const s = resolveOAuthSettings({
    issuer: STAGING_ISSUER,
    clientId: "custom-client",
    baseUrl: "https://staging-api.cloudcruise.app",
  })
  assert.equal(s.issuer, STAGING_ISSUER)
  assert.equal(s.clientId, "custom-client")
  assert.equal(s.baseUrl, "https://staging-api.cloudcruise.app")
})

test("CLOUDCRUISE_OAUTH_* env vars override the bundled defaults", () => {
  process.env.CLOUDCRUISE_OAUTH_ISSUER = STAGING_ISSUER
  process.env.CLOUDCRUISE_OAUTH_CLIENT_ID = "env-client"
  process.env.CLOUDCRUISE_BASE_URL = "https://env.example.com"
  const s = resolveOAuthSettings({})
  assert.equal(s.issuer, STAGING_ISSUER)
  assert.equal(s.clientId, "env-client")
  assert.equal(s.baseUrl, "https://env.example.com")
})

test("non-production --env is not bundled and requires explicit endpoints", () => {
  // Only production is baked into the open-source CLI; --env staging must not
  // silently fall back to production, it must demand explicit configuration.
  assert.throws(
    () => resolveOAuthSettings({ environment: "staging" }),
    /requires --issuer and --client-id/,
  )
})

test("CLOUDCRUISE_ENV is honored when no environment is passed", () => {
  // A non-production CLOUDCRUISE_ENV changes the outcome (prod default would
  // resolve cleanly), proving the env var reaches the resolver.
  process.env.CLOUDCRUISE_ENV = "staging"
  assert.throws(
    () => resolveOAuthSettings({}),
    /requires --issuer and --client-id/,
  )
})

test("an explicit environment overrides CLOUDCRUISE_ENV", () => {
  process.env.CLOUDCRUISE_ENV = "staging"
  const s = resolveOAuthSettings({ environment: "production" })
  assert.equal(s.issuer, PROD_ISSUER)
  assert.equal(s.baseUrl, "https://api.cloudcruise.com")
})

test("an unknown --env without an explicit issuer is rejected", () => {
  assert.throws(
    () => resolveOAuthSettings({ environment: "dev" }),
    /requires --issuer and --client-id/,
  )
})

test("an overridden issuer never inherits production's clientId/baseUrl", () => {
  // The staging issuer's anon key is bundled (pre-existing), but its clientId and
  // baseUrl are NOT — so it must error rather than graft production's onto it.
  assert.throws(
    () => resolveOAuthSettings({ issuer: STAGING_ISSUER }),
    /requires --issuer and --client-id|requires --base-url/,
  )
})

test("a custom issuer requires explicit client-id/base-url (no prod grafting)", () => {
  assert.throws(
    () => resolveOAuthSettings({ issuer: "https://custom.example.com/auth/v1" }),
    /requires --issuer and --client-id|requires --base-url/,
  )
})

// ---- GoTrue MFA helpers (mocked fetch) -------------------------------------

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
})

const helperSettings = { issuer: STAGING_ISSUER, anonKey: STAGING_KEY }

test("fetchMfaFactors sends the apikey + bearer and returns factors", async () => {
  let seen: { url: string; headers: Headers } | null = null
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    seen = { url: String(url), headers: new Headers(init.headers) }
    return new Response(
      JSON.stringify({
        factors: [{ id: "f1", factor_type: "totp", status: "verified" }],
      }),
      { status: 200 },
    )
  }) as typeof fetch

  const factors = await fetchMfaFactors(helperSettings, "tok-123")
  assert.equal(factors.length, 1)
  assert.equal(factors[0].id, "f1")
  assert.equal(seen!.url, `${STAGING_ISSUER}/user`)
  assert.equal(seen!.headers.get("apikey"), STAGING_KEY)
  assert.equal(seen!.headers.get("authorization"), "Bearer tok-123")
})

test("fetchMfaFactors throws on a non-ok response (drives fail-closed)", async () => {
  globalThis.fetch = (async () =>
    new Response("nope", { status: 500 })) as typeof fetch
  await assert.rejects(() => fetchMfaFactors(helperSettings, "tok"), /500/)
})

test("fetchMfaFactors throws when no anon key is configured", async () => {
  await assert.rejects(
    () => fetchMfaFactors({ issuer: STAGING_ISSUER }, "tok"),
    /anon key/i,
  )
})

test("challengeMfaFactor posts to the factor and returns the challenge id", async () => {
  let seenUrl = ""
  globalThis.fetch = (async (url: string) => {
    seenUrl = String(url)
    return new Response(JSON.stringify({ id: "chal-1" }), { status: 200 })
  }) as typeof fetch
  const id = await challengeMfaFactor(helperSettings, "tok", "f1")
  assert.equal(id, "chal-1")
  assert.equal(seenUrl, `${STAGING_ISSUER}/factors/f1/challenge`)
})

test("verifyMfaChallenge posts challenge_id + code and returns the token response", async () => {
  let body: unknown = null
  globalThis.fetch = (async (_url: string, init: RequestInit) => {
    body = JSON.parse(String(init.body))
    return new Response(
      JSON.stringify({
        access_token: makeJwt({ aal: "aal2" }),
        refresh_token: "r2",
        expires_in: 3600,
      }),
      { status: 200 },
    )
  }) as typeof fetch
  const res = await verifyMfaChallenge(helperSettings, "tok", "f1", "chal-1", "123456")
  assert.deepEqual(body, { challenge_id: "chal-1", code: "123456" })
  assert.equal(decodeAccessToken(res.access_token).aal, "aal2")
})

test("verifyMfaChallenge throws on a non-ok response", async () => {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify({ error: "bad" }), { status: 422 })) as typeof fetch
  await assert.rejects(
    () => verifyMfaChallenge(helperSettings, "tok", "f1", "chal-1", "000000"),
    /422/,
  )
})

// ---- runBrowserAuthFlow integration (server + mocked GoTrue) ---------------

interface GoTrueMock {
  factorsStatus?: number
  factors?: unknown
}

// Routes GoTrue calls to canned responses while letting localhost requests
// (the test driving the callback server) hit the real fetch.
function mockGoTrue(issuer: string, cfg: GoTrueMock): () => void {
  const real = globalThis.fetch
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    const u = String(url)
    if (!u.startsWith(issuer)) return real(url as never, init)
    if (u.endsWith("/oauth/token")) {
      return new Response(
        JSON.stringify({
          access_token: makeJwt({ aal: "aal1", sub: "u1" }),
          refresh_token: "r1",
          expires_in: 3600,
        }),
        { status: 200 },
      )
    }
    if (u.endsWith("/user")) {
      return new Response(JSON.stringify(cfg.factors ?? { factors: [] }), {
        status: cfg.factorsStatus ?? 200,
      })
    }
    if (u.endsWith("/challenge")) {
      return new Response(JSON.stringify({ id: "chal-1" }), { status: 200 })
    }
    if (u.endsWith("/verify")) {
      return new Response(
        JSON.stringify({
          access_token: makeJwt({ aal: "aal2", sub: "u1" }),
          refresh_token: "r2",
          expires_in: 3600,
        }),
        { status: 200 },
      )
    }
    return new Response("unexpected", { status: 404 })
  }) as typeof fetch
  return () => {
    globalThis.fetch = real
  }
}

async function makeSettings(): Promise<OAuthSettings> {
  const port = await freePort()
  return {
    environment: "test",
    issuer: STAGING_ISSUER,
    clientId: "test-client",
    tokenEndpointAuthMethod: "none",
    baseUrl: "https://api.example.com",
    redirectUri: `http://127.0.0.1:${port}/callback`,
    scope: "email",
    anonKey: STAGING_KEY,
  }
}

const NONCE_RE = /body:\s*JSON\.stringify\(\{\s*code:\s*code,\s*nonce:\s*"([^"]+)"/

test("runBrowserAuthFlow: non-MFA user resolves an aal1 token, no OTP page", async () => {
  const settings = await makeSettings()
  const restore = mockGoTrue(settings.issuer, { factors: { factors: [] } })
  try {
    const flow = runBrowserAuthFlow(settings, "verifier", "state-xyz")
    const res = await fetch(
      `${settings.redirectUri}?code=abc&state=state-xyz`,
    )
    const html = await res.text()
    assert.equal(res.status, 200)
    assert.ok(!html.includes('id="mfa-form"'), "should not serve the OTP form")
    const token = await flow
    assert.equal(decodeAccessToken(token.access_token).aal, "aal1")
  } finally {
    restore()
  }
})

test("runBrowserAuthFlow: MFA user gets OTP page, correct nonce yields aal2", async () => {
  const settings = await makeSettings()
  const restore = mockGoTrue(settings.issuer, {
    factors: { factors: [{ id: "f1", factor_type: "totp", status: "verified" }] },
  })
  try {
    const flow = runBrowserAuthFlow(settings, "verifier", "state-xyz")
    const page = await fetch(`${settings.redirectUri}?code=abc&state=state-xyz`)
    const html = await page.text()
    assert.ok(html.includes('id="mfa-form"'), "should serve the OTP form")
    const nonce = html.match(NONCE_RE)?.[1]
    assert.ok(nonce, "OTP page should embed a nonce")

    // Wrong nonce is rejected (flow-bound nonce check).
    const bad = await fetch(`${settings.redirectUri.replace("/callback", "/mfa-verify")}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "123456", nonce: "wrong" }),
    })
    assert.equal(bad.status, 403)

    // Correct nonce + code completes the step-up.
    const ok = await fetch(`${settings.redirectUri.replace("/callback", "/mfa-verify")}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: "123456", nonce }),
    })
    assert.equal(ok.status, 200)

    const token = await flow
    assert.equal(decodeAccessToken(token.access_token).aal, "aal2")
  } finally {
    restore()
  }
})

test("runBrowserAuthFlow: MFA lookup failure aborts login (fail closed)", async () => {
  const settings = await makeSettings()
  const restore = mockGoTrue(settings.issuer, { factorsStatus: 500, factors: "err" })
  try {
    const flow = runBrowserAuthFlow(settings, "verifier", "state-xyz")
    // Attach the rejection handler before triggering the callback so the
    // (expected) rejection is never momentarily unhandled.
    const rejection = assert.rejects(() => flow, /MFA status|aborted/i)
    const res = await fetch(`${settings.redirectUri}?code=abc&state=state-xyz`)
    assert.equal(res.status, 400)
    await rejection
  } finally {
    restore()
  }
})

test("runBrowserAuthFlow: mismatched state is rejected", async () => {
  const settings = await makeSettings()
  const restore = mockGoTrue(settings.issuer, { factors: { factors: [] } })
  try {
    const flow = runBrowserAuthFlow(settings, "verifier", "expected-state")
    const rejection = assert.rejects(() => flow, /state/i)
    const res = await fetch(`${settings.redirectUri}?code=abc&state=WRONG`)
    assert.equal(res.status, 400)
    await rejection
  } finally {
    restore()
  }
})
