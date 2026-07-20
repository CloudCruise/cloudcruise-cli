import { existsSync, readdirSync, readFileSync } from "fs"
import { join } from "path"
import { CLI_VERSION } from "./version.js"
import { SkillsIncompatibleError, fail } from "./exit.js"

/**
 * Skills-staleness / compatibility check.
 *
 * Two copies of every skill exist: the SOURCE bundled in the CLI package
 * (`<pkg>/skills/`) and the INSTALLED copy in a project's `.claude/skills/`
 * written by `cloudcruise install --skills`. Only the installed copy drifts, so
 * this check runs against the current project's `.claude/skills/` and compares
 * each pack's install-time manifest to the running CLI version.
 *
 * Scoped to the command groups the skill family actually drives
 * (builder/run/workflows); every other command is untouched. A pack with no
 * manifest (e.g. a hand-edited dev symlink pointing at source) is invisible.
 */

// Installed skills stamped from a CLI older than this are treated as INCOMPATIBLE
// (not merely stale). Bump ONLY on a breaking skills/CLI change and pair with
// GATE_MODE = "refuse" to hard-block gated commands until the user reinstalls.
export const MIN_COMPATIBLE_SKILLS_CLI = "0.0.0"

// "warn": incompatible skills only warn. "refuse": incompatible skills abort a
// gated command with exit SKILLS_INCOMPATIBLE. Default warn; flip per release.
export const GATE_MODE: "warn" | "refuse" = "warn"

// Command groups whose staleness/incompat should surface. Everything else
// (install, auth, login, vault, workspaces, …) is intentionally exempt.
const GATED_GROUPS = new Set(["builder", "run", "workflows"])

const MANIFEST_FILE = ".cloudcruise-skill.json"

export interface SkillManifest {
  pack: string
  cliVersion: string
  requiresCli?: string
  installedAt?: string
}

export interface SkillsStatus {
  stale: string[] // installed older than the running CLI
  cliBehind: string[] // installed newer than the running CLI (upgrade the CLI)
  incompatible: string[] // fails the compatibility gate
  installedVersion?: string // representative (oldest) installed cliVersion
}

/**
 * Compare two `major.minor.patch` strings. Returns -1 / 0 / 1. Missing or
 * non-numeric parts are treated as 0 — dependency-free (`semver` is not a direct
 * dependency of this package).
 */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".")
  const pb = b.split(".")
  for (let i = 0; i < 3; i++) {
    const x = parseInt(pa[i] ?? "0", 10) || 0
    const y = parseInt(pb[i] ?? "0", 10) || 0
    if (x !== y) return x < y ? -1 : 1
  }
  return 0
}

function skillsRoot(cwd: string): string {
  return join(cwd, ".claude", "skills")
}

/** Read every installed pack manifest under `<cwd>/.claude/skills/`. */
export function readInstalledManifests(cwd: string): SkillManifest[] {
  const root = skillsRoot(cwd)
  if (!existsSync(root)) return []
  const manifests: SkillManifest[] = []
  for (const entry of readdirSync(root)) {
    const path = join(root, entry, MANIFEST_FILE)
    if (!existsSync(path)) continue
    try {
      const m = JSON.parse(readFileSync(path, "utf-8")) as SkillManifest
      if (m && typeof m.cliVersion === "string") {
        manifests.push({ ...m, pack: m.pack ?? entry })
      }
    } catch {
      // Malformed manifest — skip this pack rather than break the command.
    }
  }
  return manifests
}

export function computeSkillsStatus(cwd: string): SkillsStatus {
  const status: SkillsStatus = { stale: [], cliBehind: [], incompatible: [] }
  let oldest: string | undefined
  for (const m of readInstalledManifests(cwd)) {
    const c = compareVersions(m.cliVersion, CLI_VERSION)
    if (c < 0) status.stale.push(m.pack)
    else if (c > 0) status.cliBehind.push(m.pack)

    const incompatByRequires =
      !!m.requiresCli && compareVersions(CLI_VERSION, m.requiresCli) < 0
    const incompatByMin =
      compareVersions(m.cliVersion, MIN_COMPATIBLE_SKILLS_CLI) < 0
    if (incompatByRequires || incompatByMin) status.incompatible.push(m.pack)

    if (!oldest || compareVersions(m.cliVersion, oldest) < 0) oldest = m.cliVersion
  }
  status.installedVersion = oldest
  return status
}

function emitWarning(status: SkillsStatus): void {
  const from = status.installedVersion ?? "?"
  if (process.stderr.isTTY) {
    if (status.stale.length) {
      process.stderr.write(
        `⚠ cloudcruise skills out of date (v${from} → v${CLI_VERSION}) — run: cloudcruise install --skills\n`
      )
    } else if (status.cliBehind.length) {
      process.stderr.write(
        `⚠ cloudcruise skills are newer (v${from}) than this CLI (v${CLI_VERSION}) — upgrade the CLI\n`
      )
    }
    return
  }
  // Non-TTY (a coding agent): structured signal on stderr; stdout stays clean.
  const payload: Record<string, unknown> = { cliVersion: CLI_VERSION }
  if (status.installedVersion) payload.installedVersion = status.installedVersion
  if (status.stale.length) payload.stale = status.stale
  if (status.cliBehind.length) payload.cliBehind = status.cliBehind
  if (status.incompatible.length) payload.incompatible = status.incompatible
  payload.remedy = status.stale.length
    ? "cloudcruise install --skills"
    : "upgrade the CLI"
  process.stderr.write(`${JSON.stringify({ skillsWarning: payload })}\n`)
}

/**
 * Entry point for the `preAction` hook. `topLevelGroup` is the resolved
 * top-level command group (child of `program`). No-ops for any non-gated group,
 * and never throws — a broken check must not break a command.
 */
export function checkInstalledSkills(topLevelGroup: string | undefined): void {
  if (topLevelGroup === undefined || !GATED_GROUPS.has(topLevelGroup)) return

  let status: SkillsStatus
  try {
    const cwd = process.cwd()
    if (!existsSync(skillsRoot(cwd))) return
    status = computeSkillsStatus(cwd)
  } catch {
    return
  }

  if (status.incompatible.length && GATE_MODE === "refuse") {
    // fail() writes the machine envelope to stderr and exits; emit no separate
    // skillsWarning so only one JSON object lands on stderr.
    fail(
      new SkillsIncompatibleError(
        `CloudCruise skills are incompatible with CLI v${CLI_VERSION} (packs: ${status.incompatible.join(", ")}). Run: cloudcruise install --skills`,
        status.incompatible
      )
    )
  }

  if (
    !status.stale.length &&
    !status.cliBehind.length &&
    !status.incompatible.length
  ) {
    return
  }
  emitWarning(status)
}
