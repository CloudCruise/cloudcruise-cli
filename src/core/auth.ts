import { loadConfig } from "./config.js";

export interface ResolvedAuth {
  apiKey: string;
  baseUrl: string;
}

const DEFAULT_BASE_URL = "https://api.cloudcruise.com";

export function resolveAuth(options: {
  apiKey?: string;
  baseUrl?: string;
}): ResolvedAuth {
  const config = loadConfig();

  const apiKey =
    options.apiKey || process.env.CLOUDCRUISE_API_KEY || config.apiKey;
  if (!apiKey) {
    throw new Error(
      "No API key found. Set CLOUDCRUISE_API_KEY, use --api-key, or run: cloudcruise auth login --api-key <key>",
    );
  }

  const baseUrl =
    options.baseUrl ||
    process.env.CLOUDCRUISE_BASE_URL ||
    config.baseUrl ||
    DEFAULT_BASE_URL;

  return { apiKey, baseUrl };
}
