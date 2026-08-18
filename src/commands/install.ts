import { Command } from "commander";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { outputJson, outputError } from "../core/output.js";
import { CLI_VERSION } from "../core/version.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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

function getSkillsRootDir(): string {
  return join(__dirname, "..", "..", "..", "skills");
}

// A pack is any top-level dir under skills/ that contains a SKILL.md.
function listSourcePacks(): string[] {
  const root = getSkillsRootDir();
  return readdirSync(root, { withFileTypes: true })
    .filter(
      (e) => e.isDirectory() && existsSync(join(root, e.name, "SKILL.md")),
    )
    .map((e) => e.name);
}

// Read the pack's `sharedReferences` sidecar field: the name of a directory
// under skills/_shared/ to install as the pack's references/ when the repo
// symlink didn't survive packaging (npm strips symlinks from tarballs).
function readSharedReferences(sourcePackDir: string): string | undefined {
  const metaPath = join(sourcePackDir, "skill.meta.json");
  if (!existsSync(metaPath)) return undefined;
  try {
    return (
      JSON.parse(readFileSync(metaPath, "utf-8")) as {
        sharedReferences?: string;
      }
    ).sharedReferences;
  } catch {
    return undefined;
  }
}

// Stamp the install-time manifest the staleness check reads. requiresCli is
// authored in each pack's skill.meta.json sidecar (not frontmatter).
function writeSkillManifest(
  sourcePackDir: string,
  destPackDir: string,
  pack: string,
): void {
  let requiresCli: string | undefined;
  const metaPath = join(sourcePackDir, "skill.meta.json");
  if (existsSync(metaPath)) {
    try {
      requiresCli = (
        JSON.parse(readFileSync(metaPath, "utf-8")) as { requiresCli?: string }
      ).requiresCli;
    } catch {
      // Missing/malformed sidecar — omit requiresCli.
    }
  }
  const manifest = {
    pack,
    cliVersion: CLI_VERSION,
    ...(requiresCli ? { requiresCli } : {}),
    installedAt: new Date().toISOString(),
  };
  writeFileSync(
    join(destPackDir, ".cloudcruise-skill.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

// Copy every source pack into one target's skills root. Every agent that reads
// the SKILL.md format (Claude Code, Cursor native, Codex, Devin) takes the same
// unmodified pack tree — the only difference between targets is this root.
//
// Shared reference dirs (skills/_shared/*) are symlinked into their consumer
// packs in the repo; the installed copy materializes them as real files so each
// installed pack is self-contained. Two paths get them there:
// - repo/dev: the symlink is present — replace it with a real copy (cpSync's
//   `dereference` does not reliably dereference directory symlinks);
// - npm tarball: npm strips symlinks entirely, so the pack declares its shared
//   dir in skill.meta.json (`sharedReferences`) and it's copied from _shared/.
function installPacksToRoot(skillsRoot: string): string[] {
  const installed: string[] = [];

  for (const pack of listSourcePacks()) {
    const source = join(getSkillsRootDir(), pack);
    const dest = join(skillsRoot, pack);
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    cpSync(source, dest, { recursive: true });
    for (const entry of readdirSync(dest, { withFileTypes: true })) {
      const entryPath = join(dest, entry.name);
      if (lstatSync(entryPath).isSymbolicLink()) {
        const target = realpathSync(join(source, entry.name));
        rmSync(entryPath);
        cpSync(target, entryPath, { recursive: true });
      }
    }
    const sharedRefs = readSharedReferences(source);
    const destRefs = join(dest, "references");
    if (sharedRefs && !existsSync(destRefs)) {
      const sharedSource = join(getSkillsRootDir(), "_shared", sharedRefs);
      if (existsSync(sharedSource)) {
        cpSync(sharedSource, destRefs, { recursive: true });
      }
    }
    writeSkillManifest(source, dest, pack);
    installed.push(dest);
  }

  return installed;
}

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
