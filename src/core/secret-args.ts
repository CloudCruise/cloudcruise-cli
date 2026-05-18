export function enforceNoArgSecrets(
  secrets: Record<string, unknown>,
  command: string
): void {
  if (process.env.CLOUDCRUISE_ALLOW_ARG_SECRETS === "true") return

  const provided = Object.entries(secrets)
    .filter(([, value]) => value !== undefined && value !== null)
    .map(([name]) => name)

  if (provided.length === 0) return

  throw new Error(
    `Refusing secret command-line argument(s) for ${command}: ${provided.join(", ")}. Use stdin, environment variables, OAuth login, or keychain-backed profiles instead. Set CLOUDCRUISE_ALLOW_ARG_SECRETS=true only for local testing.`
  )
}
