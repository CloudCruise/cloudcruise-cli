import { Command } from "commander"
import {
  saveProfile,
  deleteProfile,
  deleteConfig,
  loadProfile,
  listProfiles,
  setActiveProfile,
  resolveProfileName,
  getConfigPath,
  type ProfileConfig,
} from "../core/config.js"
import {
  apiKeyAccountForProfile,
  deleteEncryptionKey,
  deleteApiKey,
  deleteOAuthTokens,
  encryptionKeyAccountForProfile,
  loadApiKey,
  loadEncryptionKey,
  loadOAuthTokens,
  saveEncryptionKey,
  saveApiKey,
  tokenAccountForProfile,
  type OAuthTokens,
} from "../core/credential-store.js"
import {
  buildAuthorizeUrl,
  decodeAccessToken,
  generatePkce,
  openBrowser,
  randomState,
  resolveOAuthSettings,
  runBrowserAuthFlow,
  saveTokenResponse,
} from "../core/oauth.js"
import { ApiClient } from "../core/api-client.js"
import {
  decideWorkspaceSelection,
  fetchWorkspaceChoices,
  formatWorkspaceLabel,
  needsWorkspaceDiscovery,
  promptForWorkspace,
  resolveLoginWorkspaceId,
  summarizeWorkspace,
  type WorkspaceSummary,
} from "../core/workspaces.js"
import { enforceNoArgSecrets } from "../core/secret-args.js"
import { outputJson, outputError } from "../core/output.js"
import {
  clearWorkspaceProfile,
  showWorkspaceProfile,
  useWorkspaceProfile,
} from "./workspace-profile.js"

interface LoginOptions {
  apiKey?: string
  apiKeyStdin?: boolean
  baseUrl?: string
  encryptionKey?: string
  encryptionKeyStdin?: boolean
  profile?: string
  workspaceId?: string
  env?: string
  environment?: string
  issuer?: string
  clientId?: string
  anonKey?: string
  mfaCode?: string
  redirectUri?: string
  redirectPort?: string
  scope?: string
  browser?: boolean
  open?: boolean
}

interface WorkspaceSelectionOutput {
  workspace_selection_required: boolean
  available_workspaces?: WorkspaceSummary[]
  workspace_selection_error?: string
}

function maskKey(key: string): string {
  return key.slice(0, 6) + "..." + key.slice(-4)
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString("utf-8")
}

function loadStoredApiKey(profileName: string, profile: ProfileConfig): string | null {
  const account = profile.apiKeyAccount ?? apiKeyAccountForProfile(profileName)
  return loadApiKey(account)
}

function saveProfileApiKey(profileName: string, profile: ProfileConfig, apiKey: string): ProfileConfig {
  const apiKeyAccount = profile.apiKeyAccount ?? apiKeyAccountForProfile(profileName)
  saveApiKey(apiKeyAccount, apiKey)
  const nextProfile: ProfileConfig = {
    ...profile,
    authType: "api_key",
    apiKeyAccount,
  }
  delete nextProfile.apiKey
  return nextProfile
}

function loadStoredEncryptionKey(profileName: string, profile: ProfileConfig): string | null {
  if (!profile.encryptionKeyAccount) return null
  return loadEncryptionKey(profile.encryptionKeyAccount)
}

function loadOAuthTokensForProfileList(
  account: string
): { tokens: OAuthTokens | null; unavailable: boolean } {
  try {
    return { tokens: loadOAuthTokens(account), unavailable: false }
  } catch {
    return { tokens: null, unavailable: true }
  }
}

function saveProfileEncryptionKey(
  profileName: string,
  profile: ProfileConfig,
  encryptionKey: string
): ProfileConfig {
  const encryptionKeyAccount =
    profile.encryptionKeyAccount ?? encryptionKeyAccountForProfile(profileName)
  saveEncryptionKey(encryptionKeyAccount, encryptionKey)
  const nextProfile: ProfileConfig = {
    ...profile,
    encryptionKeyAccount,
  }
  delete nextProfile.encryptionKey
  return nextProfile
}

function migrateProfileSecrets(profileName: string, profile: ProfileConfig): ProfileConfig {
  let migrated = profile
  if (migrated.apiKey) {
    migrated = saveProfileApiKey(profileName, migrated, migrated.apiKey)
  }
  if (migrated.encryptionKey) {
    migrated = saveProfileEncryptionKey(profileName, migrated, migrated.encryptionKey)
  }
  if (migrated !== profile) {
    saveProfile(profileName, migrated)
  }
  return migrated
}

function deleteProfileSecrets(profileName: string, profile: ProfileConfig): void {
  if (profile.authType === "oauth") {
    deleteOAuthTokens(profile.tokenAccount ?? tokenAccountForProfile(profileName))
  }
  if (profile.authType === "api_key" || profile.apiKey || profile.apiKeyAccount) {
    deleteApiKey(profile.apiKeyAccount ?? apiKeyAccountForProfile(profileName))
  }
  if (profile.encryptionKey || profile.encryptionKeyAccount) {
    deleteEncryptionKey(
      profile.encryptionKeyAccount ?? encryptionKeyAccountForProfile(profileName)
    )
  }
}

function addOAuthLoginOptions(cmd: Command): Command {
  return cmd
    .option("--profile <name>", "Profile name (default: active profile or \"default\")")
    .option("--workspace-id <id>", "Workspace ID to save on the profile")
    .option(
      "--env <name>",
      "OAuth environment (default: CLOUDCRUISE_ENV, else production)",
    )
    .option("--issuer <url>", "Supabase Auth issuer URL")
    .option("--client-id <id>", "OAuth client ID")
    .option("--anon-key <key>", "Supabase anon key (public) for MFA step-up")
    .option("--mfa-code <code>", "TOTP code for non-interactive MFA step-up (skips the prompt)")
    .option("--base-url <url>", "Base URL for CloudCruise API")
    .option("--redirect-uri <uri>", "OAuth redirect URI")
    .option("--redirect-port <port>", "Local callback port", "9999")
    .option("--scope <scope>", "OAuth scope", "email")
    .option("--no-open", "Print the login URL without auto-opening a browser")
    .option("--no-browser", "Use headless login relay (not implemented yet)")
}

function isProfileUpdateOnly(opts: LoginOptions): boolean {
  return Boolean(
    (opts.encryptionKey ||
      opts.encryptionKeyStdin ||
      opts.workspaceId ||
      opts.anonKey) &&
      !opts.apiKey &&
      !opts.apiKeyStdin &&
      !opts.baseUrl &&
      !opts.issuer &&
      !opts.clientId &&
      !opts.redirectUri &&
      // --mfa-code only makes sense mid-login, so its presence forces a full
      // OAuth login rather than a profile-only update.
      !opts.mfaCode &&
      opts.browser !== false
  )
}

async function performOAuthLogin(opts: LoginOptions): Promise<void> {
  if (opts.browser === false) {
    throw new Error(
      "Headless OAuth requires the CloudCruise CLI login relay endpoint. Use browser login for now."
    )
  }

  const argEncryptionKey = opts.encryptionKey
  if (opts.encryptionKeyStdin) {
    opts.encryptionKey = (await readStdin()).trimEnd()
  }
  enforceNoArgSecrets(
    { "--encryption-key": argEncryptionKey },
    "auth login"
  )

  const profileName = resolveProfileName(opts.profile)
  const existing = loadProfile(profileName)
  let settings = resolveOAuthSettings({
    environment: opts.env ?? opts.environment,
    issuer: opts.issuer,
    clientId: opts.clientId,
    baseUrl: opts.baseUrl,
    redirectUri: opts.redirectUri,
    redirectPort: opts.redirectPort,
    scope: opts.scope,
    anonKey: opts.anonKey,
  })
  // Fall back to the profile's stored anon key only when logging into the SAME
  // issuer it was saved for — a key is project-specific, so reusing it against a
  // different issuer would fail. (Built-in/env keys resolved above are already
  // issuer-correct, so this only matters for a custom/self-hosted issuer.)
  if (!settings.anonKey && existing.anonKey && existing.issuer === settings.issuer) {
    settings = { ...settings, anonKey: existing.anonKey }
  }
  const { codeVerifier, codeChallenge } = generatePkce()
  const state = randomState()
  const authorizeUrl = buildAuthorizeUrl(settings, codeChallenge, state)

  const willOpen = opts.open !== false
  process.stderr.write(
    `${willOpen ? "Opening browser for" : "Open this URL to complete"} CloudCruise login: ${authorizeUrl}\n`
  )
  process.stderr.write(`Waiting for OAuth callback on ${settings.redirectUri}\n`)

  // The local callback server handles the whole browser flow: it receives the
  // OAuth code, exchanges it, and — because the OAuth grant always mints an
  // aal1 session — if the user has a verified TOTP factor it serves an OTP page
  // on the same localhost port and steps the session up to aal2 (the same
  // GoTrue /factors endpoints the web login uses). No-op for non-MFA users.
  const flowPromise = runBrowserAuthFlow(settings, codeVerifier, state, {
    explicitMfaCode: opts.mfaCode,
  })
  if (willOpen) openBrowser(authorizeUrl)
  const tokenResponse = await flowPromise
  const tokenAccount = tokenAccountForProfile(profileName)
  const tokens = saveTokenResponse(tokenAccount, tokenResponse)
  const claims = decodeAccessToken(tokens.accessToken)
  const expiresAt =
    tokens.expiresAt !== undefined
      ? new Date(tokens.expiresAt).toISOString()
      : undefined

  // Only inherit the saved workspace when we can positively confirm the new
  // token is the SAME account in the SAME environment the workspace was saved
  // for. Missing prior identity metadata (legacy api-key/older profiles) counts
  // as "not confirmed" -> drop the workspace (unless an explicit --workspace-id
  // was passed) so discovery re-runs instead of silently targeting a workspace
  // the new identity may not own.
  const sameAccount =
    Boolean(existing.accountId) &&
    typeof claims.sub === "string" &&
    existing.accountId === claims.sub &&
    existing.environment === settings.environment

  let profile: ProfileConfig = {
    ...existing,
    authType: "oauth",
    environment: settings.environment,
    issuer: settings.issuer,
    clientId: settings.clientId,
    // Persist exactly the key resolved for THIS issuer. settings.anonKey
    // already carries the same-issuer fallback (see resolution above), so we
    // must not `?? existing.anonKey` here — that would copy a previous
    // issuer's key onto a new-issuer profile and break its later MFA logins.
    anonKey: settings.anonKey,
    tokenEndpointAuthMethod: settings.tokenEndpointAuthMethod,
    baseUrl: settings.baseUrl,
    scope: tokenResponse.scope ?? settings.scope,
    tokenAccount,
    tokenExpiresAt: expiresAt,
    accountId: typeof claims.sub === "string" ? claims.sub : undefined,
    accountEmail: typeof claims.email === "string" ? claims.email : undefined,
    currentWorkspaceId: resolveLoginWorkspaceId({
      explicitWorkspaceId: opts.workspaceId,
      existingWorkspaceId: existing.currentWorkspaceId,
      sameAccount,
    }),
  }
  if (!sameAccount && !opts.workspaceId && existing.currentWorkspaceId) {
    process.stderr.write(
      "Saved workspace could not be confirmed for this account; re-selecting workspace.\n"
    )
  }
  const envEncryptionKey = process.env.CLOUDCRUISE_ENCRYPTION_KEY
  if (opts.encryptionKey || envEncryptionKey) {
    profile = saveProfileEncryptionKey(
      profileName,
      profile,
      opts.encryptionKey ?? envEncryptionKey as string
    )
  }

  const workspaceSelection: WorkspaceSelectionOutput = {
    workspace_selection_required: false,
  }
  if (needsWorkspaceDiscovery(profile.currentWorkspaceId)) {
    try {
      const client = new ApiClient({
        token: tokens.accessToken,
        authScheme: "bearer",
        baseUrl: settings.baseUrl,
      })
      const workspaces = await fetchWorkspaceChoices(client)
      const decision = decideWorkspaceSelection(
        workspaces,
        Boolean(process.stdin.isTTY && process.stderr.isTTY)
      )
      if (decision.kind === "selected") {
        profile.currentWorkspaceId = decision.workspace.workspace_id
        process.stderr.write(
          `Selected workspace: ${formatWorkspaceLabel(decision.workspace)}\n`
        )
      } else if (decision.kind === "prompt") {
        const selected = await promptForWorkspace(decision.workspaces)
        if (selected) {
          profile.currentWorkspaceId = selected.workspace_id
          process.stderr.write(
            `Selected workspace: ${formatWorkspaceLabel(selected)}\n`
          )
        }
      } else if (decision.kind === "required") {
        workspaceSelection.workspace_selection_required = true
        workspaceSelection.available_workspaces =
          decision.workspaces.map(summarizeWorkspace)
        process.stderr.write(
          "Workspace selection required: run `cloudcruise workspaces use <id>` or pass `--workspace-id <id>`.\n"
        )
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      workspaceSelection.workspace_selection_error = message
      process.stderr.write(
        `Workspace selection skipped: ${message}\n`
      )
    }
  }

  delete profile.apiKey
  saveProfile(profileName, profile)

  outputJson({
    status: "ok",
    profile: profileName,
    auth_type: "oauth",
    environment: settings.environment,
    account: profile.accountEmail ?? profile.accountId ?? null,
    workspace_id: profile.currentWorkspaceId ?? null,
    ...workspaceSelection,
    expires_at: expiresAt ?? null,
    config_path: getConfigPath(),
  })
}

async function saveProfileUpdates(opts: LoginOptions): Promise<void> {
  const argEncryptionKey = opts.encryptionKey
  if (opts.encryptionKeyStdin) {
    opts.encryptionKey = (await readStdin()).trimEnd()
  }
  enforceNoArgSecrets(
    { "--encryption-key": argEncryptionKey },
    "auth login"
  )

  const profileName = resolveProfileName(opts.profile)
  let profile = migrateProfileSecrets(profileName, loadProfile(profileName))
  const envEncryptionKey = process.env.CLOUDCRUISE_ENCRYPTION_KEY

  if (opts.workspaceId) profile.currentWorkspaceId = opts.workspaceId
  if (opts.anonKey) profile.anonKey = opts.anonKey
  if (opts.encryptionKey || envEncryptionKey) {
    profile = saveProfileEncryptionKey(
      profileName,
      profile,
      opts.encryptionKey ?? envEncryptionKey as string
    )
  }

  delete profile.encryptionKey
  delete profile.apiKey
  saveProfile(profileName, profile)
  outputJson({
    status: "ok",
    profile: profileName,
    config_path: getConfigPath(),
  })
}

async function saveLegacyProfile(opts: LoginOptions): Promise<void> {
  const argApiKey = opts.apiKey
  const argEncryptionKey = opts.encryptionKey

  if (opts.apiKeyStdin && opts.encryptionKeyStdin) {
    throw new Error("Use only one of --api-key-stdin or --encryption-key-stdin")
  }
  if (opts.apiKeyStdin) {
    opts.apiKey = (await readStdin()).trimEnd()
  }
  if (opts.encryptionKeyStdin) {
    opts.encryptionKey = (await readStdin()).trimEnd()
  }

  enforceNoArgSecrets(
    { "--api-key": argApiKey, "--encryption-key": argEncryptionKey },
    "auth login"
  )
  const profileName = resolveProfileName(opts.profile)
  const existing = migrateProfileSecrets(profileName, loadProfile(profileName))
  const existingApiKey = loadStoredApiKey(profileName, existing)
  const envApiKey = process.env.CLOUDCRUISE_API_KEY
  const envEncryptionKey = process.env.CLOUDCRUISE_ENCRYPTION_KEY
  if (
    !opts.apiKey &&
    !envApiKey &&
    !opts.encryptionKey &&
    !envEncryptionKey &&
    !opts.baseUrl &&
    !opts.workspaceId
  ) {
    throw new Error("Provide OAuth login options, CLOUDCRUISE_API_KEY, or one of --encryption-key, --base-url, or --workspace-id")
  }
  if (!opts.apiKey && !envApiKey && !existingApiKey) {
    throw new Error(
      "No existing API key for this profile. Prefer `cloudcruise login`; legacy API-key setup requires CLOUDCRUISE_API_KEY."
    )
  }
  let profile: ProfileConfig = { ...existing, authType: "api_key" }
  if (opts.apiKey || envApiKey) {
    profile = saveProfileApiKey(profileName, profile, opts.apiKey ?? envApiKey as string)
  }
  if (opts.baseUrl) profile.baseUrl = opts.baseUrl
  if (opts.workspaceId) profile.currentWorkspaceId = opts.workspaceId
  if (opts.encryptionKey || envEncryptionKey) {
    profile = saveProfileEncryptionKey(
      profileName,
      profile,
      opts.encryptionKey ?? envEncryptionKey as string
    )
  }
  delete profile.encryptionKey
  delete profile.apiKey
  saveProfile(profileName, profile)
  outputJson({
    status: "ok",
    profile: profileName,
    warning: "Legacy API-key login stores reusable credentials in the OS keychain. Prefer `cloudcruise login`.",
    config_path: getConfigPath(),
  })
}

function registerLoginCommand(command: Command): void {
  addOAuthLoginOptions(command)
    .option("--api-key <key>", "Legacy CloudCruise API key (rejected by default; use --api-key-stdin)")
    .option("--api-key-stdin", "Read legacy CloudCruise API key from stdin")
    .option("--encryption-key <key>", "Hex-encoded AES-256 encryption key for vault operations (rejected by default; use --encryption-key-stdin)")
    .option("--encryption-key-stdin", "Read encryption key from stdin")
    .action(async (opts: LoginOptions) => {
      try {
        if (opts.apiKey || opts.apiKeyStdin) {
          await saveLegacyProfile(opts)
        } else if (isProfileUpdateOnly(opts)) {
          await saveProfileUpdates(opts)
        } else {
          await performOAuthLogin(opts)
        }
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    })
}

function profileStatus(profileName: string, opts: LoginOptions) {
  const profile = migrateProfileSecrets(profileName, loadProfile(profileName))
  const tokenAccount = profile.tokenAccount ?? tokenAccountForProfile(profileName)
  const envToken = process.env.CLOUDCRUISE_TOKEN
  const oauthTokens =
    !envToken && profile.authType === "oauth" ? loadOAuthTokens(tokenAccount) : null
  const envKey = process.env.CLOUDCRUISE_API_KEY
  const storedApiKey =
    !envToken && profile.authType === "api_key" ? loadStoredApiKey(profileName, profile) : null
  const apiKey = opts.apiKey || envKey || storedApiKey
  const encKey =
    opts.encryptionKey ||
    process.env.CLOUDCRUISE_ENCRYPTION_KEY ||
    (!envToken ? loadStoredEncryptionKey(profileName, profile) : null)

  return {
    authenticated: Boolean(envToken || oauthTokens || apiKey),
    profile: profileName,
    auth_type: envToken
      ? "machine_token"
      : oauthTokens
        ? "oauth"
        : apiKey
          ? "api_key"
          : "none",
    source: envToken
      ? "environment"
      : oauthTokens
        ? "keychain"
        : opts.apiKey
          ? "flag"
          : envKey
            ? "environment"
            : storedApiKey
              ? "keychain"
              : "none",
    account: profile.accountEmail ?? profile.accountId ?? null,
    environment: profile.environment ?? null,
    workspace_id:
      opts.workspaceId ||
      process.env.CLOUDCRUISE_WORKSPACE_ID ||
      profile.currentWorkspaceId ||
      null,
    token_expires_at:
      oauthTokens?.expiresAt !== undefined
        ? new Date(oauthTokens.expiresAt).toISOString()
        : oauthTokens
          ? profile.tokenExpiresAt ?? null
          : null,
    credential_status:
      profile.authType === "oauth" && !envToken
        ? oauthTokens
          ? "present"
          : "missing"
        : null,
    scope: oauthTokens?.scope ?? profile.scope ?? null,
    api_key: apiKey ? maskKey(apiKey) : null,
    encryption_key: encKey ? maskKey(encKey) : null,
    base_url:
      opts.baseUrl ||
      profile.baseUrl ||
      process.env.CLOUDCRUISE_BASE_URL ||
      "https://api.cloudcruise.com",
    config_path: getConfigPath(),
  }
}

export function registerAuthCommands(program: Command): void {
  registerLoginCommand(
    program
      .command("login")
      .description("Log in with browser OAuth + PKCE")
  )

  program
    .command("logout")
    .description("Remove saved credentials for the active profile")
    .option("--profile <name>", "Profile to remove (default: active profile)")
    .action((opts: { profile?: string }) => {
      try {
        const profileName = resolveProfileName(opts.profile)
        const profile = loadProfile(profileName)
        deleteProfileSecrets(profileName, profile)
        deleteProfile(profileName)
        outputJson({ status: "ok", profile: profileName })
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    })

  program
    .command("whoami")
    .description("Show the authenticated account")
    .option("--profile <name>", "Profile to check")
    .action((opts: { profile?: string }) => {
      try {
        const profileName = resolveProfileName(opts.profile)
        const status = profileStatus(profileName, opts)
        outputJson({
          authenticated: status.authenticated,
          profile: profileName,
          account: status.account,
          auth_type: status.auth_type,
          environment: status.environment,
          workspace_id: status.workspace_id,
        })
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    })

  const auth = program.command("auth").description("Manage authentication")

  registerLoginCommand(
    auth
      .command("login")
      .description("Log in with browser OAuth + PKCE")
  )

  auth
    .command("status")
    .description("Show current authentication status")
    .option("--api-key <key>", "Legacy CloudCruise API key (rejected by default)")
    .option("--base-url <url>", "Base URL")
    .option("--profile <name>", "Profile to check")
    .option("--encryption-key <key>", "Encryption key override (rejected by default)")
    .action((opts: LoginOptions) => {
      try {
        enforceNoArgSecrets(
          { "--api-key": opts.apiKey, "--encryption-key": opts.encryptionKey },
          "auth status"
        )
        const profileName = resolveProfileName(opts.profile)
        const allProfiles = listProfiles()
        outputJson({
          ...profileStatus(profileName, opts),
          available_profiles: allProfiles.profiles,
          active_profile: allProfiles.active,
        })
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    })

  const workspace = auth
    .command("workspace")
    .description("Show or set the active workspace for an auth profile")
    .option("--profile <name>", "Profile to inspect")
    .action((opts: { profile?: string }) => {
      try {
        showWorkspaceProfile(opts)
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    })

  workspace
    .command("show")
    .description("Show the active workspace for an auth profile")
    .option("--profile <name>", "Profile to inspect")
    .action((opts: { profile?: string }, cmd?: Command) => {
      try {
        showWorkspaceProfile(opts, cmd)
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    })

  workspace
    .command("use <id>")
    .description("Set the active workspace for an auth profile")
    .option("--profile <name>", "Profile to update")
    .action((id: string, opts: { profile?: string }, cmd?: Command) => {
      try {
        useWorkspaceProfile(id, opts, cmd)
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    })

  workspace
    .command("clear")
    .description("Clear the active workspace for an auth profile")
    .option("--profile <name>", "Profile to update")
    .action((opts: { profile?: string }, cmd?: Command) => {
      try {
        clearWorkspaceProfile(opts, cmd)
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    })

  auth
    .command("logout")
    .description("Remove saved credentials")
    .option("--profile <name>", "Profile to remove (default: active profile)")
    .option("--all", "Remove all profiles and config")
    .action((opts: { profile?: string; all?: boolean }) => {
      try {
        if (opts.all) {
          for (const name of listProfiles().profiles) {
            const profile = loadProfile(name)
            deleteProfileSecrets(name, profile)
          }
          deleteConfig()
          outputJson({ status: "ok", message: "All profiles removed." })
          return
        }
        const profileName = resolveProfileName(opts.profile)
        const profile = loadProfile(profileName)
        deleteProfileSecrets(profileName, profile)
        deleteProfile(profileName)
        outputJson({ status: "ok", profile: profileName })
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    })

  auth
    .command("switch <name>")
    .description("Set the active auth profile")
    .action((name: string) => {
      try {
        setActiveProfile(name)
        outputJson({ status: "ok", active_profile: name })
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    })

  auth
    .command("profiles")
    .description("List all auth profiles")
    .action(() => {
      try {
        const { active, profiles } = listProfiles()
        const details = profiles.map((name) => {
          const p = migrateProfileSecrets(name, loadProfile(name))
          const apiKey =
            p.authType === "api_key" ? loadStoredApiKey(name, p) : null
          const oauthLookup =
            p.authType === "oauth"
              ? loadOAuthTokensForProfileList(
                  p.tokenAccount ?? tokenAccountForProfile(name)
                )
              : { tokens: null, unavailable: false }
          const oauthTokens = oauthLookup.tokens
          const encryptionKey = loadStoredEncryptionKey(name, p)
          return {
            name,
            active: name === active,
            auth_type:
              p.authType === "oauth"
                ? "oauth"
                : apiKey
                  ? "api_key"
                  : "none",
            credential_status:
              p.authType === "oauth"
                ? oauthLookup.unavailable
                  ? "unavailable"
                  : oauthTokens
                    ? "present"
                    : "missing"
                : null,
            account: p.accountEmail ?? p.accountId ?? null,
            environment: p.environment ?? null,
            workspace_id: p.currentWorkspaceId ?? null,
            token_expires_at:
              oauthTokens?.expiresAt !== undefined
                ? new Date(oauthTokens.expiresAt).toISOString()
                : oauthTokens
                  ? p.tokenExpiresAt ?? null
                  : oauthLookup.unavailable
                    ? p.tokenExpiresAt ?? null
                  : null,
            api_key: apiKey ? maskKey(apiKey) : null,
            encryption_key: encryptionKey ? maskKey(encryptionKey) : null,
            base_url: p.baseUrl ?? null,
          }
        })
        outputJson({ active_profile: active, profiles: details })
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    })
}
