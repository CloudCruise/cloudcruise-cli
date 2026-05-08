import { Command } from "commander";
import { readFileSync } from "fs";
import { resolveAuth } from "../core/auth.js";
import { ApiClient } from "../core/api-client.js";
import { outputJson, outputError } from "../core/output.js";
import { addAuthOptions, type AuthOptions } from "../core/auth-options.js";

export function registerWorkflowCommands(program: Command): void {
  const workflows = program
    .command("workflows")
    .description("Manage workflows");

  addAuthOptions(
    workflows
      .command("list")
      .description("List all workflows in your workspace")
      .option("--full", "Show all fields (default shows summary only)"),
  )
    .addHelpText(
      "after",
      `
Examples:
  $ cloudcruise workflows list
  $ cloudcruise workflows list --full
`,
    )
    .action(async (opts: { full?: boolean } & AuthOptions) => {
      try {
        const auth = resolveAuth(opts);
        const client = new ApiClient(auth);
        const data = await client.get<Record<string, unknown>[]>("/workflows");
        if (opts.full) {
          outputJson(data);
        } else {
          const summary = data.map((w) => ({
            id: w.id,
            name: w.name,
            description: w.description,
            created_at: w.created_at,
            updated_at: w.updated_at,
          }));
          outputJson(summary);
        }
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  const parseVersionNumber = (value: string): number => {
    if (!/^\d+$/.test(value)) {
      throw new Error(`--version must be a positive integer, got: ${value}`);
    }
    const n = Number(value);
    if (n < 1) {
      throw new Error(`--version must be >= 1, got: ${value}`);
    }
    return n;
  };

  addAuthOptions(
    workflows
      .command("get <id>")
      .description("Get workflow with nodes (latest version by default)")
      .option(
        "--version <n>",
        "Fetch a specific historical version by version_number (use `workflows versions <id>` to list)",
        parseVersionNumber,
      ),
  )
    .addHelpText(
      "after",
      `
Examples:
  $ cloudcruise workflows get wf_abc123
  $ cloudcruise workflows get wf_abc123 > workflow.json
  $ cloudcruise workflows get wf_abc123 --version 18
`,
    )
    .action(async (id: string, opts: { version?: number } & AuthOptions) => {
      try {
        const auth = resolveAuth(opts);
        const client = new ApiClient(auth);
        const path =
          opts.version !== undefined
            ? `/workflows/${id}/versions/${opts.version}`
            : `/workflows/${id}`;
        const data = await client.get(path);
        outputJson(data);
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  addAuthOptions(
    workflows
      .command("versions <id>")
      .description("List version history for a workflow (newest first)")
      .option(
        "--limit <n>",
        "Cap the number of versions returned (client-side slice)",
        parseVersionNumber,
      ),
  )
    .addHelpText(
      "after",
      `
Examples:
  $ cloudcruise workflows versions wf_abc123
  $ cloudcruise workflows versions wf_abc123 --limit 10
`,
    )
    .action(async (id: string, opts: { limit?: number } & AuthOptions) => {
      try {
        const auth = resolveAuth(opts);
        const client = new ApiClient(auth);
        const data = await client.get<Record<string, unknown>[]>(
          `/workflows/${id}/versions`,
        );
        const sliced =
          opts.limit !== undefined ? data.slice(0, opts.limit) : data;
        outputJson(sliced);
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });

  const READONLY_FIELDS = [
    "id",
    "version_id",
    "version_number",
    "created_at",
    "created_by",
    "updated_at",
    "workspace_id",
    "workflow_id",
    "loginStructure",
    "encrypted_keys",
  ];

  addAuthOptions(
    workflows
      .command("update <id>")
      .description("Update workflow (creates new version)")
      .option("--file <path>", "Path to workflow JSON file")
      .option("--stdin", "Read workflow JSON from stdin")
      .option(
        "--version-note <note>",
        "Description of changes for this version",
      ),
  )
    .addHelpText(
      "after",
      `
Examples:
  $ cloudcruise workflows update wf_abc123 --file workflow.json --version-note "Fixed login XPath"
  $ cat workflow.json | cloudcruise workflows update wf_abc123 --stdin --version-note "Updated selectors"
`,
    )
    .action(
      async (
        id: string,
        opts: {
          file?: string;
          stdin?: boolean;
          versionNote?: string;
        } & AuthOptions,
      ) => {
        try {
          let body: Record<string, unknown>;
          if (opts.stdin) {
            const chunks: Buffer[] = [];
            for await (const chunk of process.stdin) {
              chunks.push(chunk as Buffer);
            }
            body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
          } else if (opts.file) {
            body = JSON.parse(readFileSync(opts.file, "utf-8"));
          } else {
            throw new Error("Provide --file <path> or --stdin");
          }

          for (const field of READONLY_FIELDS) {
            delete body[field];
          }

          if (opts.versionNote) {
            body.version_note = opts.versionNote;
          }

          const auth = resolveAuth(opts);
          const client = new ApiClient(auth);
          const data = await client.put(`/workflows/${id}`, body);
          outputJson(data);
        } catch (err: unknown) {
          outputError(err instanceof Error ? err.message : String(err));
          process.exit(1);
        }
      },
    );
}
