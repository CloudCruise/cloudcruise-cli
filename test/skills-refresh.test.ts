import { test } from "node:test"
import assert from "node:assert/strict"
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  symlinkSync,
  writeFileSync
} from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { autoRefreshSkills, computeSkillsStatus } from "../dist/src/core/skills.js"
import { CLI_VERSION } from "../dist/src/core/version.js"

const SOURCE_SKILLS = join(import.meta.dirname, "..", "skills")
const OLD_VERSION = "0.0.1"

function fakeStderr(isTTY = false) {
  const lines: string[] = []
  return {
    isTTY,
    lines,
    write(chunk: string) {
      lines.push(chunk)
      return true
    }
  }
}

function project(): string {
  return mkdtempSync(join(tmpdir(), "skills-refresh-"))
}

function installedPack(
  cwd: string,
  root: string,
  pack: string,
  cliVersion?: string
): string {
  const dir = join(cwd, root, "skills", pack)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, "SKILL.md"), "outdated content\n")
  if (cliVersion) {
    writeFileSync(
      join(dir, ".cloudcruise-skill.json"),
      JSON.stringify({ pack, cliVersion })
    )
  }
  return dir
}

function stampOf(dir: string): string {
  return JSON.parse(readFileSync(join(dir, ".cloudcruise-skill.json"), "utf-8"))
    .cliVersion
}

function sourceSkill(pack: string): string {
  return readFileSync(join(SOURCE_SKILLS, pack, "SKILL.md"), "utf-8")
}

test("a pack stamped by an older CLI is reinstalled from this CLI and restamped", () => {
  const cwd = project()
  const dir = installedPack(cwd, ".claude", "cloudcruise", OLD_VERSION)

  autoRefreshSkills({ cwd, env: {}, settings: {}, stderr: fakeStderr() })

  assert.equal(readFileSync(join(dir, "SKILL.md"), "utf-8"), sourceSkill("cloudcruise"))
  assert.equal(stampOf(dir), CLI_VERSION)
})

// Only packs stamped by an older CLI are CLI-managed and stale. Hand-written
// packs (no stamp) and packs from a newer CLI must survive as they are.
test("unstamped packs and packs stamped by the same or a newer CLI are left untouched", () => {
  const cwd = project()
  const unstamped = installedPack(cwd, ".claude", "cloudcruise")
  const current = installedPack(cwd, ".claude", "cc-workflow", CLI_VERSION)
  const newer = installedPack(cwd, ".claude", "cc-workflow-build", "999.0.0")
  const stderr = fakeStderr()

  autoRefreshSkills({ cwd, env: {}, settings: {}, stderr })

  for (const dir of [unstamped, current, newer]) {
    assert.equal(readFileSync(join(dir, "SKILL.md"), "utf-8"), "outdated content\n")
  }
  assert.deepEqual(stderr.lines, [])
})

// A stamped pack the running CLI no longer ships cannot be reinstalled from it;
// it stays, and the staleness warning keeps pointing at it.
test("a stale pack that this CLI no longer ships is left untouched", () => {
  const cwd = project()
  const retired = installedPack(cwd, ".claude", "retired-pack", OLD_VERSION)

  autoRefreshSkills({ cwd, env: {}, settings: {}, stderr: fakeStderr() })

  assert.equal(readFileSync(join(retired, "SKILL.md"), "utf-8"), "outdated content\n")
  assert.equal(stampOf(retired), OLD_VERSION)
})

// Projects may link one root's pack into another (e.g. .claude/skills/x ->
// ../../.agents/skills/x). Reinstalling through the link would replace it with
// a copy; the real directory is refreshed in its own root instead.
test("a symlinked pack keeps its link while its target is refreshed", () => {
  const cwd = project()
  const real = installedPack(cwd, ".agents", "cloudcruise", OLD_VERSION)
  mkdirSync(join(cwd, ".claude", "skills"), { recursive: true })
  const link = join(cwd, ".claude", "skills", "cloudcruise")
  symlinkSync(join("..", "..", ".agents", "skills", "cloudcruise"), link)

  autoRefreshSkills({ cwd, env: {}, settings: {}, stderr: fakeStderr() })

  assert.ok(lstatSync(link).isSymbolicLink())
  assert.equal(stampOf(real), CLI_VERSION)
})

test("off a TTY, the refresh is reported as one JSON line naming the packs, paths and versions", () => {
  const cwd = project()
  const claude = installedPack(cwd, ".claude", "cloudcruise", OLD_VERSION)
  const agents = installedPack(cwd, ".agents", "cloudcruise", "0.0.2")
  const stderr = fakeStderr(false)

  autoRefreshSkills({ cwd, env: {}, settings: {}, stderr })

  assert.equal(stderr.lines.length, 1)
  assert.deepEqual(JSON.parse(stderr.lines[0]), {
    skillsRefreshed: {
      cliVersion: CLI_VERSION,
      fromVersion: OLD_VERSION,
      packs: ["cloudcruise"],
      paths: [claude, agents]
    }
  })
})

test("on a TTY, the refresh is reported as one human-readable line", () => {
  const cwd = project()
  installedPack(cwd, ".claude", "cloudcruise", OLD_VERSION)
  installedPack(cwd, ".claude", "cc-workflow", OLD_VERSION)
  const stderr = fakeStderr(true)

  autoRefreshSkills({ cwd, env: {}, settings: {}, stderr })

  assert.deepEqual(stderr.lines, [
    `✓ cloudcruise skills refreshed (v${OLD_VERSION} → v${CLI_VERSION}): cc-workflow, cloudcruise\n`
  ])
})

test("settings.skillsAutoUpdate: false disables the refresh", () => {
  const cwd = project()
  const dir = installedPack(cwd, ".claude", "cloudcruise", OLD_VERSION)
  const stderr = fakeStderr()

  autoRefreshSkills({ cwd, env: {}, settings: { skillsAutoUpdate: false }, stderr })

  assert.equal(stampOf(dir), OLD_VERSION)
  assert.deepEqual(stderr.lines, [])
})

test("CLOUDCRUISE_SKILLS_AUTO_UPDATE=0 disables the refresh when the config leaves it on", () => {
  const cwd = project()
  const dir = installedPack(cwd, ".claude", "cloudcruise", OLD_VERSION)

  autoRefreshSkills({
    cwd,
    env: { CLOUDCRUISE_SKILLS_AUTO_UPDATE: "0" },
    settings: {},
    stderr: fakeStderr()
  })

  assert.equal(stampOf(dir), OLD_VERSION)
})

// The env var is the per-invocation override, so it wins over config.json.
test("CLOUDCRUISE_SKILLS_AUTO_UPDATE=1 re-enables the refresh over settings.skillsAutoUpdate: false", () => {
  const cwd = project()
  const dir = installedPack(cwd, ".claude", "cloudcruise", OLD_VERSION)

  autoRefreshSkills({
    cwd,
    env: { CLOUDCRUISE_SKILLS_AUTO_UPDATE: "1" },
    settings: { skillsAutoUpdate: false },
    stderr: fakeStderr()
  })

  assert.equal(stampOf(dir), CLI_VERSION)
})

// A root the user can't write (e.g. read-only checkout) must not keep the
// other roots stale; the unwritable pack stays as it was and is not reported.
test("a pack that cannot be reinstalled does not stop the other roots from refreshing", () => {
  const cwd = project()
  const locked = installedPack(cwd, ".claude", "cloudcruise", OLD_VERSION)
  const writable = installedPack(cwd, ".agents", "cloudcruise", OLD_VERSION)
  chmodSync(join(cwd, ".claude", "skills"), 0o555)
  chmodSync(locked, 0o555)
  const stderr = fakeStderr()

  try {
    autoRefreshSkills({ cwd, env: {}, settings: {}, stderr })
  } finally {
    chmodSync(join(cwd, ".claude", "skills"), 0o755)
    chmodSync(locked, 0o755)
  }

  assert.equal(stampOf(locked), OLD_VERSION)
  assert.equal(stampOf(writable), CLI_VERSION)
  assert.deepEqual(JSON.parse(stderr.lines[0]).skillsRefreshed.paths, [writable])
})

// The old pack is swapped out whole rather than deleted file by file. Deleting
// in place would remove the stamp before failing on a subfolder it can't empty,
// leaving a partial pack the CLI no longer tracks or warns about.
test("a stale pack with a subfolder that cannot be emptied is still replaced whole and restamped", () => {
  const cwd = project()
  const dir = installedPack(cwd, ".claude", "cloudcruise", OLD_VERSION)
  const locked = join(dir, "locked")
  mkdirSync(locked)
  writeFileSync(join(locked, "notes.md"), "local\n")
  chmodSync(locked, 0o555)

  try {
    autoRefreshSkills({ cwd, env: {}, settings: {}, stderr: fakeStderr() })
  } finally {
    if (existsSync(locked)) chmodSync(locked, 0o755)
  }

  assert.equal(readFileSync(join(dir, "SKILL.md"), "utf-8"), sourceSkill("cloudcruise"))
  assert.equal(stampOf(dir), CLI_VERSION)
  assert.equal(existsSync(locked), false)
  assert.deepEqual(computeSkillsStatus(cwd).stale, [])
})

// Each root is scanned on its own, so one unreadable root cannot keep the
// roots after it stale.
test("an unreadable skills root does not stop the roots after it from refreshing", () => {
  const cwd = project()
  installedPack(cwd, ".claude", "cloudcruise", OLD_VERSION)
  const writable = installedPack(cwd, ".agents", "cloudcruise", OLD_VERSION)
  chmodSync(join(cwd, ".claude", "skills"), 0o000)

  try {
    autoRefreshSkills({ cwd, env: {}, settings: {}, stderr: fakeStderr() })
  } finally {
    chmodSync(join(cwd, ".claude", "skills"), 0o755)
  }

  assert.equal(stampOf(writable), CLI_VERSION)
})
