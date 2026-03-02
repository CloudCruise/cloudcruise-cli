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
import { outputJson, outputError } from "../core/output.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function getSkillSourceDir(): string {
  return join(__dirname, "..", "..", "..", "skills", "cloudcruise")
}

function installClaudeSkills(cwd: string): string {
  const destDir = join(cwd, ".claude", "skills", "cloudcruise")
  const sourceDir = getSkillSourceDir()
  mkdirSync(destDir, { recursive: true })
  cpSync(sourceDir, destDir, { recursive: true })
  return destDir
}

function installCursorSkills(cwd: string): string[] {
  const destDir = join(cwd, ".cursor", "rules")
  mkdirSync(destDir, { recursive: true })
  const installed: string[] = []

  const sourceFile = join(getSkillSourceDir(), "cloudcruise.md")
  const content = readFileSync(sourceFile, "utf-8")

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
      const refContent = readFileSync(join(refsDir, file), "utf-8")
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
          const dest = installClaudeSkills(cwd)
          installed.push(dest)
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
