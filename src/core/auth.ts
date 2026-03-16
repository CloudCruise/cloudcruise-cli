import { loadProfile, resolveProfileName } from "./config.js";

export interface ResolvedAuth {
  apiKey: string;
  baseUrl: string;
  encryptionKey?: string;
}

const DEFAULT_BASE_URL = "https://api.cloudcruise.com";

export function resolveAuth(options: {
  apiKey?: string;
  baseUrl?: string;
  profile?: string;
  encryptionKey?: string;
}): ResolvedAuth {
  const profileName = resolveProfileName(options.profile);
  const profile = loadProfile(profileName);

  const apiKey =
    options.apiKey || process.env.CLOUDCRUISE_API_KEY || profile.apiKey;
  if (!apiKey) {
    throw new Error(
      `No API key found for profile "${profileName}". Set CLOUDCRUISE_API_KEY, use --api-key, or run: cloudcruise auth login --api-key <key> --profile ${profileName}`,
    );
  }

  const baseUrl =
    options.baseUrl ||
    process.env.CLOUDCRUISE_BASE_URL ||
    profile.baseUrl ||
    DEFAULT_BASE_URL;

  const encryptionKey =
    options.encryptionKey ||
    process.env.CLOUDCRUISE_ENCRYPTION_KEY ||
    profile.encryptionKey ||
    undefined;

  return { apiKey, baseUrl, encryptionKey };
}

export function requireEncryptionKey(auth: ResolvedAuth): string {
  if (!auth.encryptionKey) {
    throw new Error(
      "No encryption key found. Set CLOUDCRUISE_ENCRYPTION_KEY, use --encryption-key, or run: cloudcruise auth login --api-key <key> --encryption-key <hex>",
    );
  }
  return auth.encryptionKey;
}
