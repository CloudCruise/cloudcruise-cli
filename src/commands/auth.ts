import { Command } from "commander";
import {
  saveConfig,
  deleteConfig,
  loadConfig,
  getConfigPath,
} from "../core/config.js";
import { outputJson, outputError } from "../core/output.js";

export function registerAuthCommands(program: Command): void {
  const auth = program.command("auth").description("Manage authentication");

  auth
    .command("login")
    .description("Save API key to config file")
    .requiredOption("--api-key <key>", "CloudCruise API key")
    .option("--base-url <url>", "Base URL for CloudCruise API")
    .action((opts: { apiKey: string; baseUrl?: string }) => {
      try {
        const config: { apiKey: string; baseUrl?: string } = {
          apiKey: opts.apiKey,
        };
        if (opts.baseUrl) config.baseUrl = opts.baseUrl;
        saveConfig(config);
        outputJson({ status: "ok", config_path: getConfigPath() });
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  auth
    .command("status")
    .description("Show current authentication status")
    .option("--api-key <key>", "CloudCruise API key")
    .option("--base-url <url>", "Base URL")
    .action((opts: { apiKey?: string; baseUrl?: string }) => {
      try {
        const config = loadConfig();
        const envKey = process.env.CLOUDCRUISE_API_KEY;
        const key = opts.apiKey || envKey || config.apiKey;
        const source = opts.apiKey
          ? "flag"
          : envKey
            ? "environment"
            : config.apiKey
              ? "config_file"
              : "none";
        const masked = key ? key.slice(0, 6) + "..." + key.slice(-4) : null;
        outputJson({
          authenticated: !!key,
          source,
          api_key: masked,
          base_url:
            opts.baseUrl ||
            process.env.CLOUDCRUISE_BASE_URL ||
            config.baseUrl ||
            "https://api.cloudcruise.com",
          config_path: getConfigPath(),
        });
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  auth
    .command("logout")
    .description("Remove saved credentials")
    .action(() => {
      try {
        deleteConfig();
        outputJson({ status: "ok" });
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
