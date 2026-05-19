import { loadProfile, resolveProfileName, saveProfile } from "./config.js";
import {
  apiKeyAccountForProfile,
  encryptionKeyAccountForProfile,
  loadApiKey,
  loadEncryptionKey,
  loadOAuthTokens,
  saveApiKey,
  saveEncryptionKey,
  saveOAuthTokens,
  tokenAccountForProfile
} from "./credential-store.js";
import {
  refreshOAuthToken,
  tokenResponseToStoredTokens
} from "./oauth.js";
import { enforceNoArgSecrets } from "./secret-args.js";

export interface ResolvedAuth {
  token: string;
  authScheme: "bearer" | "api-key";
  baseUrl: string;
  workspaceId?: string;
  encryptionKey?: string;
}

const DEFAULT_BASE_URL = "https://api.cloudcruise.com";

function resolveBaseUrl(options: { baseUrl?: string }, profile: { baseUrl?: string }): string {
  return (
    options.baseUrl ||
    profile.baseUrl ||
    process.env.CLOUDCRUISE_BASE_URL ||
    DEFAULT_BASE_URL
  );
}

export async function resolveAuth(options: {
  apiKey?: string;
  baseUrl?: string;
  profile?: string;
  workspaceId?: string;
  encryptionKey?: string;
}): Promise<ResolvedAuth> {
  enforceNoArgSecrets(
    { "--api-key": options.apiKey, "--encryption-key": options.encryptionKey },
    "authentication",
  );

  const profileName = resolveProfileName(options.profile);
  const profile = loadProfile(profileName);
  const workspaceId =
    options.workspaceId ||
    process.env.CLOUDCRUISE_WORKSPACE_ID ||
    profile.currentWorkspaceId ||
    undefined;

  const machineToken = process.env.CLOUDCRUISE_TOKEN;
  if (machineToken) {
    return {
      token: machineToken,
      authScheme: "bearer",
      baseUrl: resolveBaseUrl(options, profile),
      workspaceId,
      encryptionKey:
        options.encryptionKey ||
        process.env.CLOUDCRUISE_ENCRYPTION_KEY ||
        undefined,
    };
  }

  let storedEncryptionKey = profile.encryptionKeyAccount
    ? loadEncryptionKey(profile.encryptionKeyAccount)
    : null;
  if (!storedEncryptionKey && profile.encryptionKey) {
    const encryptionKeyAccount =
      profile.encryptionKeyAccount ?? encryptionKeyAccountForProfile(profileName);
    saveEncryptionKey(encryptionKeyAccount, profile.encryptionKey);
    delete profile.encryptionKey;
    profile.encryptionKeyAccount = encryptionKeyAccount;
    saveProfile(profileName, profile);
    storedEncryptionKey = loadEncryptionKey(encryptionKeyAccount);
  }

  if (profile.authType === "oauth") {
    const account = profile.tokenAccount ?? tokenAccountForProfile(profileName);
    const tokens = loadOAuthTokens(account);
    if (!tokens) {
      throw new Error(
        `No OAuth tokens found for profile "${profileName}". Run: cloudcruise login --profile ${profileName}`,
      );
    }

    let accessToken = tokens.accessToken;
    const refreshSkewMs = 60_000;
    if (
      tokens.refreshToken &&
      tokens.expiresAt !== undefined &&
      tokens.expiresAt <= Date.now() + refreshSkewMs
    ) {
      if (!profile.issuer || !profile.clientId) {
        throw new Error(
          `OAuth profile "${profileName}" is missing issuer or client ID. Run cloudcruise login again.`,
        );
      }
      const refreshed = tokenResponseToStoredTokens(
        await refreshOAuthToken(
          {
            issuer: profile.issuer,
            clientId: profile.clientId,
            clientSecret: process.env.CLOUDCRUISE_OAUTH_CLIENT_SECRET,
          },
          tokens.refreshToken,
        ),
      );
      const merged = {
        ...tokens,
        ...refreshed,
        refreshToken: refreshed.refreshToken ?? tokens.refreshToken,
      };
      saveOAuthTokens(account, merged);
      accessToken = merged.accessToken;
    } else if (
      !tokens.refreshToken &&
      tokens.expiresAt !== undefined &&
      tokens.expiresAt <= Date.now()
    ) {
      throw new Error(
        `OAuth access token for profile "${profileName}" has expired. Run: cloudcruise login --profile ${profileName}`,
      );
    }

    return {
      token: accessToken,
      authScheme: "bearer",
      baseUrl: resolveBaseUrl(options, profile),
      workspaceId,
      encryptionKey:
        options.encryptionKey ||
        process.env.CLOUDCRUISE_ENCRYPTION_KEY ||
        storedEncryptionKey ||
        undefined,
    };
  }

  let storedApiKey =
    profile.authType === "api_key"
      ? loadApiKey(profile.apiKeyAccount ?? apiKeyAccountForProfile(profileName))
      : null;

  if (!storedApiKey && profile.apiKey) {
    const apiKeyAccount = profile.apiKeyAccount ?? apiKeyAccountForProfile(profileName);
    saveApiKey(apiKeyAccount, profile.apiKey);
    delete profile.apiKey;
    profile.apiKeyAccount = apiKeyAccount;
    profile.authType = "api_key";
    saveProfile(profileName, profile);
    storedApiKey = loadApiKey(apiKeyAccount);
  }

  const apiKey =
    options.apiKey || process.env.CLOUDCRUISE_API_KEY || storedApiKey;
  if (!apiKey) {
    throw new Error(
      `No authentication found for profile "${profileName}". Run: cloudcruise login --profile ${profileName}. For CI, set CLOUDCRUISE_TOKEN.`,
    );
  }

  const baseUrl = resolveBaseUrl(options, profile);

  const encryptionKey =
    options.encryptionKey ||
    process.env.CLOUDCRUISE_ENCRYPTION_KEY ||
    storedEncryptionKey ||
    undefined;

  return { token: apiKey, authScheme: "api-key", baseUrl, workspaceId, encryptionKey };
}

export function requireEncryptionKey(auth: ResolvedAuth): string {
  if (!auth.encryptionKey) {
    throw new Error(
      "No encryption key found. Set CLOUDCRUISE_ENCRYPTION_KEY or configure an encryption key for this profile.",
    );
  }
  return auth.encryptionKey;
}
