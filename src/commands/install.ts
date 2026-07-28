import { Command } from "commander"
import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync
} from "fs"
import { join, dirname } from "path"
import { fileURLToPath } from "url"
import { outputJson, outputError } from "../core/output.js"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

function getSkillsRootDir(): string {
  return join(__dirname, "..", "..", "..", "skills")
}

function listSkillDirs(): { name: string; dir: string }[] {
  const root = getSkillsRootDir()
  if (!existsSync(root)) return []
  return readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ name: entry.name, dir: join(root, entry.name) }))
    .filter((skill) => existsSync(join(skill.dir, "SKILL.md")))
}

function stripFrontmatter(content: string): string {
  return content.replace(/^---\n[\s\S]*?\n---\n+/, "")
}

function installClaudeSkills(cwd: string): string[] {
  const installed: string[] = []
  for (const skill of listSkillDirs()) {
    const destDir = join(cwd, ".claude", "skills", skill.name)
    mkdirSync(destDir, { recursive: true })
    cpSync(skill.dir, destDir, { recursive: true })
    installed.push(destDir)
  }
  return installed
}

function installCursorSkills(cwd: string): string[] {
  const destDir = join(cwd, ".cursor", "rules")
  mkdirSync(destDir, { recursive: true })
  const installed: string[] = []

  for (const skill of listSkillDirs()) {
    const content = stripFrontmatter(
      readFileSync(join(skill.dir, "SKILL.md"), "utf-8")
    )
    const isMain = skill.name === "cloudcruise"
    const fileName = isMain ? "cloudcruise-cli.mdc" : `${skill.name}.mdc`
    const description = isMain
      ? "CloudCruise CLI usage reference for managing workflows and runs"
      : `CloudCruise ${skill.name} reference - read this when building, editing, or debugging CloudCruise workflows`

    const mdc = `---
description: ${description}
globs:
alwaysApply: ${isMain}
---

${content}`

    const dest = join(destDir, fileName)
    writeFileSync(dest, mdc)
    installed.push(dest)
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
