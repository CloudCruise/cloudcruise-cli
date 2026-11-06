export interface Config {
  port: number
  /** CloudCruise API origin the forwarded token is sent to. */
  apiBaseUrl: string
  /** Supabase Auth issuer, named as the only authorization server. */
  oauthIssuer: string
  /** Public origin of this server; the protected resource is `${publicUrl}/mcp`. */
  publicUrl: string
}

/** Reads config from env and throws naming the first missing or malformed variable. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const port = Number(env.PORT ?? "8080")
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error(`PORT must be an integer port, got "${env.PORT}"`)
  }
  return {
    port,
    apiBaseUrl: url(env, "CLOUDCRUISE_API_BASE_URL"),
    oauthIssuer: url(env, "CLOUDCRUISE_OAUTH_ISSUER"),
    publicUrl: url(env, "MCP_PUBLIC_URL")
  }
}

function url(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]
  if (!value) {
    throw new Error(`${name} is required`)
  }
  let parsed: URL
  try {
    parsed = new URL(value)
  } catch {
    throw new Error(`${name} must be an absolute URL, got "${value}"`)
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new Error(`${name} must be an http or https URL, got "${value}"`)
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${name} must not contain credentials`)
  }
  if (value.endsWith("/") || parsed.search || parsed.hash) {
    throw new Error(`${name} must have no trailing slash, query or fragment, got "${value}"`)
  }
  return value
}
