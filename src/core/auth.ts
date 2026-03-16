import { loadProfile, resolveProfileName } from "./config.js";

export interface ResolvedAuth {
  apiKey: string;
  baseUrl: string;
}

const DEFAULT_BASE_URL = "https://api.cloudcruise.com";

export function resolveAuth(options: {
  apiKey?: string;
  baseUrl?: string;
  profile?: string;
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

  return { apiKey, baseUrl };
}
