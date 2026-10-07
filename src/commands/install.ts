import { Command } from "commander";
import { existsSync } from "fs";
import { join } from "path";
import { outputJson, outputError } from "../core/output.js";
import { installPacksToRoot } from "../core/skill-install.js";

// Each target agent reads skills from its own project-level dir. Several agents
// share the cross-agent `.agents/skills/` convention (Codex, Devin, and Cursor as
// a fallback), so multiple target names resolve to the same root; installs dedupe
// by resolved path so `--target all` never copies a root twice.
const TARGET_ROOTS: Record<string, string[]> = {
  claude: [join(".claude", "skills")],
  cursor: [join(".cursor", "skills")],
  codex: [join(".agents", "skills")],
  devin: [join(".agents", "skills")],
  agents: [join(".agents", "skills")],
  all: [
    join(".claude", "skills"),
    join(".cursor", "skills"),
    join(".agents", "skills"),
  ],
};

const VALID_TARGETS = Object.keys(TARGET_ROOTS).join(", ");

// Prior `--target cursor` installs wrote `.cursor/rules/cloudcruise-*.mdc`
// (always-on rules, only the two reference skills). Native `.cursor/skills/`
// replaces that path; the installer no longer manages the old files, so surface
// them for the user to delete by hand rather than silently leaving cruft.
function staleCursorRuleNotes(cwd: string): string[] {
  const rulesDir = join(cwd, ".cursor", "rules");
  const legacy = ["cloudcruise-cli.mdc", "cloudcruise-workflow-dsl.mdc"].filter(
    (f) => existsSync(join(rulesDir, f)),
  );
  if (legacy.length === 0) return [];
  return [
    `Cursor skills now install to .cursor/skills/ (native). Old rule files remain at ${join(".cursor", "rules")}/${legacy.join(", ")} — remove them by hand if unused.`,
  ];
}

export function registerInstallCommands(program: Command): void {
  program
    .command("install")
    .description("Install CloudCruise CLI skills for coding agents")
    .option("--skills", "Install skill files for coding agents")
    .option(
      "--target <agent>",
      `Target agent: ${VALID_TARGETS} (default: all)`,
      "all",
    )
    .addHelpText(
      "after",
      `
Targets:
  claude              → .claude/skills/
  cursor              → .cursor/skills/
  codex, devin, agents→ .agents/skills/   (shared cross-agent convention)
  all                 → all three roots

Examples:
  $ cloudcruise install --skills
  $ cloudcruise install --skills --target cursor
  $ cloudcruise install --skills --target codex
`,
    )
    .action((opts: { skills?: boolean; target: string }) => {
      if (!opts.skills) {
        outputError(
          "No install target specified. Use --skills to install skill files.",
        );
        process.exit(1);
      }

      const target = opts.target.toLowerCase();
      const relRoots = TARGET_ROOTS[target];
      if (!relRoots) {
        outputError(`Unknown target "${opts.target}". Use: ${VALID_TARGETS}`);
        process.exit(1);
      }

      try {
        const cwd = process.cwd();
        // Dedupe by resolved root so aliases sharing a root (codex/devin/agents,
        // or `all`) install it once.
        const roots = [...new Set(relRoots.map((r) => join(cwd, r)))];
        const installed: string[] = [];
        for (const root of roots) {
          installed.push(...installPacksToRoot(root));
        }

        const notes = relRoots.some((r) => r === join(".cursor", "skills"))
          ? staleCursorRuleNotes(cwd)
          : [];

        outputJson({
          status: "ok",
          installed,
          ...(notes.length ? { notes } : {}),
        });
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
    });
}
