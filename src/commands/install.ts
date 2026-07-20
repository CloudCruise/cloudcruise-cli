import { Command } from "commander"
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from "fs"
import { join, dirname, basename } from "path"
import { fileURLToPath } from "url"
import { outputJson } from "../core/output.js"
import { fail, UsageError } from "../core/exit.js"
import { CLI_VERSION } from "../core/version.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function getSkillSourceDir(): string {
  return join(__dirname, "..", "..", "..", "skills", "cloudcruise")
}

// Strip a leading YAML frontmatter block (--- ... ---) so it doesn't leak into
// the Cursor .mdc wrapper, which prepends its own frontmatter header.
function stripFrontmatter(md: string): string {
  return md.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
}

function getSkillsRootDir(): string {
  return join(__dirname, "..", "..", "..", "skills")
}

// A pack is any top-level dir under skills/ that contains a SKILL.md.
function listSourcePacks(): string[] {
  const root = getSkillsRootDir()
  return readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory() && existsSync(join(root, e.name, "SKILL.md")))
    .map((e) => e.name)
}

// Stamp the install-time manifest the staleness check reads. requiresCli is
// authored in each pack's skill.meta.json sidecar (not frontmatter).
function writeSkillManifest(destPackDir: string, pack: string): void {
  let requiresCli: string | undefined
  const metaPath = join(getSkillsRootDir(), pack, "skill.meta.json")
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
  const installed: string[] = []
  for (const pack of listSourcePacks()) {
    const destDir = join(cwd, ".claude", "skills", pack)
    mkdirSync(destDir, { recursive: true })
    cpSync(join(getSkillsRootDir(), pack), destDir, { recursive: true })
    writeSkillManifest(destDir, pack)
    installed.push(destDir)
  }
  return installed
}

function installCursorSkills(cwd: string): string[] {
  const destDir = join(cwd, ".cursor", "rules")
  mkdirSync(destDir, { recursive: true })
  const installed: string[] = []

  const sourceFile = join(getSkillSourceDir(), "SKILL.md")
  const content = stripFrontmatter(readFileSync(sourceFile, "utf-8"))

  const mainMdc = `---
description: CloudCruise CLI usage reference for managing workflows and runs
globs:
alwaysApply: true
---

${content}`

  const mainDest = join(destDir, "cloudcruise-cli.mdc")
  writeFileSync(mainDest, mainMdc)
  installed.push(mainDest)

  const refsDir = join(getSkillSourceDir(), "references")
  if (existsSync(refsDir)) {
    for (const file of readdirSync(refsDir)) {
      if (!file.endsWith(".md")) continue
      const refContent = stripFrontmatter(readFileSync(join(refsDir, file), "utf-8"))
      const name = basename(file, ".md")

      const refMdc = `---
description: CloudCruise ${name} reference - read this when editing or debugging CloudCruise workflows
globs:
alwaysApply: false
---

${refContent}`

      const refDest = join(destDir, `cloudcruise-${name}.mdc`)
      writeFileSync(refDest, refMdc)
      installed.push(refDest)
    }
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
        fail(
          new UsageError(
            "No install target specified. Use --skills to install skill files."
          )
        )
      }

      try {
        const cwd = process.cwd()
        const installed: string[] = []
        const target = opts.target.toLowerCase()

        if (target === "claude" || target === "all") {
          installed.push(...installClaudeSkills(cwd))
        }

        if (target === "cursor" || target === "all") {
          const dests = installCursorSkills(cwd)
          installed.push(...dests)
        }

        if (target !== "claude" && target !== "cursor" && target !== "all") {
          fail(
            new UsageError(
              `Unknown target "${opts.target}". Use: claude, cursor, all`
            )
          )
        }

        outputJson({
          status: "ok",
          installed
        })
      } catch (err: unknown) {
        fail(err)
      }
    })
}
