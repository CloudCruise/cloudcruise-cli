import { existsSync, lstatSync, readdirSync, readFileSync } from "fs"
import { basename, join, relative } from "path"
import { CLI_VERSION } from "./version.js"
import { hashPack, installPack, listSourcePacks } from "./skill-install.js"
import type { CliSettings } from "./config.js"
import { LEGACY_SKILL_HASHES } from "./legacy-skill-hashes.js"
import type { StderrLike } from "./update-notice.js"
import { SkillsIncompatibleError, fail } from "./exit.js"

/**
 * Skills-staleness / compatibility check.
 *
 * Two copies of every skill exist: the SOURCE bundled in the CLI package
 * (`<pkg>/skills/`) and the INSTALLED copy under a project's skills root written
 * by `cloudcruise install --skills`. Only the installed copy drifts, so this check
 * runs against the current project's skills roots and compares each pack's
 * install-time manifest to the running CLI version.
 *
 * A project may install to more than one root — `.claude/skills/` (Claude Code),
 * `.cursor/skills/` (Cursor), `.agents/skills/` (Codex/Devin) — so all three are
 * scanned. A pack installed to several roots is deduped to its OLDEST copy, so
 * drift surfaces if any copy is stale. (User-level/global roots are not scanned;
 * install is project-scoped today.)
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
  contentHash?: string
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

// The project-level skills roots an install may have written to. Kept in sync
// with install.ts's TARGET_ROOTS (project scope only — no user-level roots).
function skillsRoots(cwd: string): string[] {
  return [
    join(cwd, ".claude", "skills"),
    join(cwd, ".cursor", "skills"),
    join(cwd, ".agents", "skills")
  ]
}

/** True if any project skills root exists. */
function anySkillsRoot(cwd: string): boolean {
  return skillsRoots(cwd).some((r) => existsSync(r))
}

/**
 * Read every installed pack manifest across the project's skills roots. A pack
 * installed to several roots is deduped to its OLDEST-versioned copy, so a stale
 * copy in any root still surfaces.
 */
export function readInstalledManifests(cwd: string): SkillManifest[] {
  const byPack = new Map<string, SkillManifest>()
  for (const root of skillsRoots(cwd)) {
    if (!existsSync(root)) continue
    for (const entry of readdirSync(root)) {
      const manifest = readManifest(join(root, entry))
      if (!manifest) continue
      const existing = byPack.get(manifest.pack)
      // Keep the oldest copy: worst-case drift for this pack.
      if (
        !existing ||
        compareVersions(manifest.cliVersion, existing.cliVersion) < 0
      ) {
        byPack.set(manifest.pack, manifest)
      }
    }
  }
  return [...byPack.values()]
}

// A malformed or missing manifest reads as unmanaged rather than breaking the
// command.
function readManifest(packDir: string): SkillManifest | undefined {
  const path = join(packDir, MANIFEST_FILE)
  if (!existsSync(path)) return undefined
  try {
    const m = JSON.parse(readFileSync(path, "utf-8")) as SkillManifest
    if (!m || typeof m.cliVersion !== "string") return undefined
    return { ...m, pack: m.pack ?? basename(packDir) }
  } catch {
    return undefined
  }
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
    if (!anySkillsRoot(cwd)) return
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

export interface AutoRefreshOptions {
  cwd: string
  env: Record<string, string | undefined>
  settings: CliSettings
  stderr: StderrLike
}

/**
 * Reinstall every CLI-managed pack (one carrying a manifest) that an older CLI
 * stamped, so skills follow a CLI upgrade without a manual
 * `cloudcruise install --skills`. Packs edited since install are left to an
 * explicit `install --skills`. Never throws; a pack that is skipped or fails
 * stays as it was, and the staleness warning still fires for it.
 */
export function autoRefreshSkills(options: AutoRefreshOptions): string[] {
  const { cwd, stderr } = options
  if (!skillsAutoUpdateEnabled(options) || !anySkillsRoot(cwd)) return []
  const refreshed: { path: string; pack: string; from: string }[] = []
  const keptEdited: string[] = []
  let shipped: Set<string>
  try {
    shipped = new Set(listSourcePacks())
  } catch {
    return []
  }
  for (const root of skillsRoots(cwd)) {
    let entries: string[]
    try {
      entries = existsSync(root) ? readdirSync(root) : []
    } catch {
      continue
    }
    for (const entry of entries) {
      try {
        const packDir = join(root, entry)
        if (!shipped.has(entry) || lstatSync(packDir).isSymbolicLink()) continue
        const manifest = readManifest(packDir)
        if (!manifest || compareVersions(manifest.cliVersion, CLI_VERSION) >= 0) {
          continue
        }
        if (!isUnedited(packDir, manifest)) {
          keptEdited.push(relative(cwd, packDir))
          continue
        }
        const path = installPack(root, entry)
        refreshed.push({ path, pack: entry, from: manifest.cliVersion })
      } catch {
        continue
      }
    }
  }
  if (refreshed.length) {
    const fromVersion = refreshed
      .map((r) => r.from)
      .sort(compareVersions)[0]
    reportRefresh(stderr, {
      fromVersion,
      packs: [...new Set(refreshed.map((r) => r.pack))].sort(),
      paths: refreshed.map((r) => r.path),
      keptEdited
    })
  }
  return refreshed.map((r) => r.path)
}

// True when the pack's files are exactly what the stamping CLI installed. A
// stamp without a contentHash comes from an older CLI; its released install is
// looked up instead. Unknown means possibly edited.
function isUnedited(packDir: string, manifest: SkillManifest): boolean {
  const expected =
    manifest.contentHash ??
    LEGACY_SKILL_HASHES[manifest.cliVersion]?.[manifest.pack]
  return !!expected && hashPack(packDir) === expected
}

function skillsAutoUpdateEnabled(
  options: Pick<AutoRefreshOptions, "env" | "settings">
): boolean {
  const fromEnv = options.env.CLOUDCRUISE_SKILLS_AUTO_UPDATE
  if (fromEnv === "0") return false
  if (fromEnv === "1") return true
  return options.settings.skillsAutoUpdate !== false
}

function reportRefresh(
  stderr: StderrLike,
  refresh: {
    fromVersion: string
    packs: string[]
    paths: string[]
    keptEdited: string[]
  }
): void {
  const { keptEdited, ...refreshed } = refresh
  if (stderr.isTTY) {
    stderr.write(
      `✓ cloudcruise skills refreshed (v${refresh.fromVersion} → v${CLI_VERSION}): ${refresh.packs.join(", ")}\n`
    )
    if (keptEdited.length) {
      stderr.write(`  kept, edited since install: ${keptEdited.join(", ")}\n`)
    }
    return
  }
  const payload = {
    cliVersion: CLI_VERSION,
    ...refreshed,
    ...(keptEdited.length ? { keptEdited } : {})
  }
  stderr.write(`${JSON.stringify({ skillsRefreshed: payload })}\n`)
}
