import { Command } from "commander";
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
} from "../core/config.js";
import { outputJson, outputError } from "../core/output.js";

function maskKey(key: string): string {
  return key.slice(0, 6) + "..." + key.slice(-4);
}

export function registerAuthCommands(program: Command): void {
  const auth = program.command("auth").description("Manage authentication");

  auth
    .command("login")
    .description("Save API key to a profile")
    .option("--api-key <key>", "CloudCruise API key")
    .option("--base-url <url>", "Base URL for CloudCruise API")
    .option("--encryption-key <key>", "Hex-encoded AES-256 encryption key for vault operations")
    .option("--profile <name>", "Profile name (default: active profile or \"default\")")
    .action(
      (opts: { apiKey?: string; baseUrl?: string; encryptionKey?: string; profile?: string }) => {
        try {
          const profileName = resolveProfileName(opts.profile);
          const existing = loadProfile(profileName);
          if (!opts.apiKey && !opts.encryptionKey && !opts.baseUrl) {
            throw new Error(
              "Provide at least one of --api-key, --encryption-key, or --base-url"
            );
          }
          if (!opts.apiKey && !existing.apiKey) {
            throw new Error(
              "No existing API key for this profile. Provide --api-key on first login."
            );
          }
          const profile: ProfileConfig = { ...existing };
          if (opts.apiKey) profile.apiKey = opts.apiKey;
          if (opts.baseUrl) profile.baseUrl = opts.baseUrl;
          if (opts.encryptionKey) profile.encryptionKey = opts.encryptionKey;
          saveProfile(profileName, profile);
          outputJson({
            status: "ok",
            profile: profileName,
            config_path: getConfigPath(),
          });
        } catch (err: unknown) {
          outputError(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
      }
    );

  auth
    .command("status")
    .description("Show current authentication status")
    .option("--api-key <key>", "CloudCruise API key")
    .option("--base-url <url>", "Base URL")
    .option("--profile <name>", "Profile to check")
    .option("--encryption-key <key>", "Encryption key override")
    .action((opts: { apiKey?: string; baseUrl?: string; profile?: string; encryptionKey?: string }) => {
      try {
        const profileName = resolveProfileName(opts.profile);
        const profile = loadProfile(profileName);
        const envKey = process.env.CLOUDCRUISE_API_KEY;
        const key = opts.apiKey || envKey || profile.apiKey;
        const source = opts.apiKey
          ? "flag"
          : envKey
            ? "environment"
            : profile.apiKey
              ? "config_file"
              : "none";
        const masked = key ? maskKey(key) : null;
        const encKey =
          opts.encryptionKey ||
          process.env.CLOUDCRUISE_ENCRYPTION_KEY ||
          profile.encryptionKey;
        const allProfiles = listProfiles();
        outputJson({
          authenticated: !!key,
          profile: profileName,
          source,
          api_key: masked,
          encryption_key: encKey ? maskKey(encKey) : null,
          base_url:
            opts.baseUrl ||
            process.env.CLOUDCRUISE_BASE_URL ||
            profile.baseUrl ||
            "https://api.cloudcruise.com",
          config_path: getConfigPath(),
          available_profiles: allProfiles.profiles,
          active_profile: allProfiles.active,
        });
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  auth
    .command("logout")
    .description("Remove saved credentials")
    .option("--profile <name>", "Profile to remove (default: active profile)")
    .option("--all", "Remove all profiles and config")
    .action((opts: { profile?: string; all?: boolean }) => {
      try {
        if (opts.all) {
          deleteConfig();
          outputJson({ status: "ok", message: "All profiles removed." });
          return;
        }
        const profileName = resolveProfileName(opts.profile);
        deleteProfile(profileName);
        outputJson({ status: "ok", profile: profileName });
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  auth
    .command("switch <name>")
    .description("Set the active auth profile")
    .action((name: string) => {
      try {
        setActiveProfile(name);
        outputJson({ status: "ok", active_profile: name });
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  auth
    .command("profiles")
    .description("List all auth profiles")
    .action(() => {
      try {
        const { active, profiles } = listProfiles();
        const details = profiles.map((name) => {
          const p = loadProfile(name);
          return {
            name,
            active: name === active,
            api_key: p.apiKey ? maskKey(p.apiKey) : null,
            encryption_key: p.encryptionKey ? maskKey(p.encryptionKey) : null,
            base_url: p.baseUrl ?? null,
          };
        });
        outputJson({ active_profile: active, profiles: details });
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
