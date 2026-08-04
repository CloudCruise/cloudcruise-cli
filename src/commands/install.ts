import { Command } from "commander"
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync
} from "fs"
import { join, dirname, basename } from "path"
import { fileURLToPath } from "url"
import { outputJson, outputError } from "../core/output.js"
import { CLI_VERSION } from "../core/version.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function getSkillsRootDir(): string {
  return join(__dirname, "..", "..", "..", "skills")
}

// A pack is any top-level dir under skills/ that contains a SKILL.md.
function listSourcePacks(): string[] {
  const root = getSkillsRootDir()
  return readdirSync(root, { withFileTypes: true })
    .filter(
      (e) => e.isDirectory() && existsSync(join(root, e.name, "SKILL.md"))
    )
    .map((e) => e.name)
}

// Strip a leading YAML frontmatter block (--- ... ---) so it doesn't leak into
// the Cursor .mdc wrapper, which prepends its own frontmatter header.
function stripFrontmatter(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
}

// Read the pack's `sharedReferences` sidecar field: the name of a directory
// under skills/_shared/ to install as the pack's references/ when the repo
// symlink didn't survive packaging (npm strips symlinks from tarballs).
function readSharedReferences(sourcePackDir: string): string | undefined {
  const metaPath = join(sourcePackDir, "skill.meta.json")
  if (!existsSync(metaPath)) return undefined
  try {
    return (
      JSON.parse(readFileSync(metaPath, "utf-8")) as {
        sharedReferences?: string
      }
    ).sharedReferences
  } catch {
    return undefined
  }
}

// Stamp the install-time manifest the staleness check reads. requiresCli is
// authored in each pack's skill.meta.json sidecar (not frontmatter).
function writeSkillManifest(
  sourcePackDir: string,
  destPackDir: string,
  pack: string
): void {
  let requiresCli: string | undefined
  const metaPath = join(sourcePackDir, "skill.meta.json")
  if (existsSync(metaPath)) {
    try {
      requiresCli = (
        JSON.parse(readFileSync(metaPath, "utf-8")) as { requiresCli?: string }
      ).requiresCli
    } catch {
      // Missing/malformed sidecar — omit requiresCli.
    }
  }
  const manifest = {
    pack,
    cliVersion: CLI_VERSION,
    ...(requiresCli ? { requiresCli } : {}),
    installedAt: new Date().toISOString()
  }
  writeFileSync(
    join(destPackDir, ".cloudcruise-skill.json"),
    `${JSON.stringify(manifest, null, 2)}\n`
  )
}

function installClaudeSkills(cwd: string): string[] {
  const skillsRoot = join(cwd, ".claude", "skills")
  const installed: string[] = []

  // Shared reference dirs (skills/_shared/*) are symlinked into their consumer
  // packs in the repo; the installed copy materializes them as real files so
  // each installed pack is self-contained. Two paths get them there:
  // - repo/dev: the symlink is present — replace it with a real copy (cpSync's
  //   `dereference` does not reliably dereference directory symlinks);
  // - npm tarball: npm strips symlinks entirely, so the pack declares its shared
  //   dir in skill.meta.json (`sharedReferences`) and it's copied from _shared/.
  for (const pack of listSourcePacks()) {
    const source = join(getSkillsRootDir(), pack)
    const dest = join(skillsRoot, pack)
    mkdirSync(dest, { recursive: true })
    cpSync(source, dest, { recursive: true })
    for (const entry of readdirSync(dest, { withFileTypes: true })) {
      const entryPath = join(dest, entry.name)
      if (lstatSync(entryPath).isSymbolicLink()) {
        const target = realpathSync(join(source, entry.name))
        rmSync(entryPath)
        cpSync(target, entryPath, { recursive: true })
      }
    }
    const sharedRefs = readSharedReferences(source)
    const destRefs = join(dest, "references")
    if (sharedRefs && !existsSync(destRefs)) {
      const sharedSource = join(getSkillsRootDir(), "_shared", sharedRefs)
      if (existsSync(sharedSource)) {
        cpSync(sharedSource, destRefs, { recursive: true })
      }
    }
    writeSkillManifest(source, dest, pack)
    installed.push(dest)
  }

  return installed
}

function installCursorSkills(cwd: string): string[] {
  const destDir = join(cwd, ".cursor", "rules")
  mkdirSync(destDir, { recursive: true })
  const installed: string[] = []

  const cliContent = stripFrontmatter(
    readFileSync(join(getSkillsRootDir(), "cloudcruise", "SKILL.md"), "utf-8")
  )

  const mainMdc = `---
description: CloudCruise CLI usage reference for managing workflows and runs
globs:
alwaysApply: true
---

${cliContent}`

  const mainDest = join(destDir, "cloudcruise-cli.mdc")
  writeFileSync(mainDest, mainMdc)
  installed.push(mainDest)

  const dslSource = join(
    getSkillsRootDir(),
    "cloudcruise-workflow-dsl",
    "SKILL.md"
  )
  if (existsSync(dslSource)) {
    const dslContent = stripFrontmatter(readFileSync(dslSource, "utf-8"))

    const dslMdc = `---
description: CloudCruise workflow-dsl reference - read this when editing or debugging CloudCruise workflows
globs:
alwaysApply: false
---

${dslContent}`

    const dslDest = join(destDir, "cloudcruise-workflow-dsl.mdc")
    writeFileSync(dslDest, dslMdc)
    installed.push(dslDest)
  }

  return installed
}

export function registerInstallCommands(program: Command): void {
  program
    .command("install")
    .description("Install CloudCruise CLI skills for coding agents")
    .option("--skills", "Install skill files for coding agents")
    .option(
      "--target <agent>",
      "Target agent: claude, cursor, all (default: all)",
      "all"
    )
    .addHelpText("after", `
Examples:
  $ cloudcruise install --skills
  $ cloudcruise install --skills --target cursor
  $ cloudcruise install --skills --target claude
`)
    .action((opts: { skills?: boolean; target: string }) => {
      if (!opts.skills) {
        outputError(
          "No install target specified. Use --skills to install skill files."
        )
        process.exit(1)
      }

      try {
        const cwd = process.cwd()
        const installed: string[] = []
        const target = opts.target.toLowerCase()

        if (target === "claude" || target === "all") {
          const dests = installClaudeSkills(cwd)
          installed.push(...dests)
        }

        if (target === "cursor" || target === "all") {
          const dests = installCursorSkills(cwd)
          installed.push(...dests)
        }

        if (target !== "claude" && target !== "cursor" && target !== "all") {
          outputError(
            `Unknown target "${opts.target}". Use: claude, cursor, all`
          )
          process.exit(1)
        }

        outputJson({
          status: "ok",
          installed
        })
      } catch (err: unknown) {
        outputError(err instanceof Error ? err.message : String(err))
        process.exit(1)
      }
    })
}
