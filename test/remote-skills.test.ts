import { test } from "node:test"
import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { createServer, type Server } from "node:http"
import { lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installSkills } from "../dist/src/core/skill-install.js"
import { autoRefreshSkills, computeSkillsStatus } from "../dist/src/core/skills.js"
import { syncRemoteSkills } from "../dist/src/core/remote-skills.js"

const DSL = "cloudcruise-workflow-dsl"
const SOURCE_SKILLS = join(import.meta.dirname, "..", "skills")

interface DocsSite {
  url: string
  requests: string[]
  serve(content: string, digest?: string): void
  beforeSkillResponse(hook: () => void): void
  close(): Promise<void>
}

function sha256(content: string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`
}

// A stand-in for docs.cloudcruise.com: the v0.2.0 discovery index listing the
// DSL skill, and the skill file itself.
async function docsSite(): Promise<DocsSite> {
  let skill = "served skill\n"
  let digest = sha256(skill)
  const requests: string[] = []
  let hook = () => {}
  const server: Server = createServer((req, res) => {
    requests.push(req.url ?? "")
    if (req.url === "/.well-known/agent-skills/index.json") {
      res.setHeader("content-type", "application/json")
      res.end(
        JSON.stringify({
          $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json",
          skills: [
            {
              name: DSL,
              type: "skill-md",
              description: "DSL",
              url: `/.well-known/agent-skills/${DSL}/skill.md`,
              digest
            }
          ]
        })
      )
    } else if (req.url === `/.well-known/agent-skills/${DSL}/skill.md`) {
      hook()
      res.end(skill)
    } else {
      res.statusCode = 404
      res.end()
    }
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const address = server.address()
  if (!address || typeof address === "string") throw new Error("no port")
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    serve(content, servedDigest) {
      skill = content
      digest = servedDigest ?? sha256(content)
    },
    beforeSkillResponse(next) {
      hook = next
    },
    close: () => new Promise((resolve) => server.close(() => resolve()))
  }
}

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
  return mkdtempSync(join(tmpdir(), "remote-skills-"))
}

function manifestOf(dir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, ".cloudcruise-skill.json"), "utf-8"))
}

test("install --skills installs the DSL skill as served by the docs site and records its digest", async (t) => {
  const site = await docsSite()
  t.after(() => site.close())
  site.serve("served skill v2\n")
  const root = join(project(), ".claude", "skills")

  await installSkills([root], {
    env: { CLOUDCRUISE_SKILLS_BASE_URL: site.url },
    stderr: fakeStderr()
  })

  assert.equal(readFileSync(join(root, DSL, "SKILL.md"), "utf-8"), "served skill v2\n")
  assert.equal(manifestOf(join(root, DSL)).source, "remote")
  assert.equal(manifestOf(join(root, DSL)).digest, sha256("served skill v2\n"))
  assert.equal(
    readFileSync(join(root, "cloudcruise", "SKILL.md"), "utf-8"),
    readFileSync(join(SOURCE_SKILLS, "cloudcruise", "SKILL.md"), "utf-8")
  )
})

function bundled(pack: string): string {
  return readFileSync(join(SOURCE_SKILLS, pack, "SKILL.md"), "utf-8")
}

// The digest is what ties the served file to the index; a file that does not
// match it (tampered, or caught mid-deploy) must never reach the agent.
test("a served DSL skill that does not match its digest is rejected and the bundled copy installed instead", async (t) => {
  const site = await docsSite()
  t.after(() => site.close())
  site.serve("tampered\n", sha256("what the index promised\n"))
  const root = join(project(), ".claude", "skills")
  const stderr = fakeStderr(false)

  await installSkills([root], { env: { CLOUDCRUISE_SKILLS_BASE_URL: site.url }, stderr })

  assert.equal(readFileSync(join(root, DSL, "SKILL.md"), "utf-8"), bundled(DSL))
  assert.equal(manifestOf(join(root, DSL)).source, "bundled")
  assert.deepEqual(JSON.parse(stderr.lines[0]).skillsBundledFallback.packs, [DSL])
})

// Offline installs must still work: the CLI ships a copy of every remote pack.
test("when the docs site is unreachable, install --skills installs the bundled DSL skill and warns once", async () => {
  const root = join(project(), ".claude", "skills")
  const stderr = fakeStderr(true)

  await installSkills([root], {
    env: { CLOUDCRUISE_SKILLS_BASE_URL: "http://127.0.0.1:9" },
    stderr
  })

  assert.equal(readFileSync(join(root, DSL, "SKILL.md"), "utf-8"), bundled(DSL))
  assert.equal(manifestOf(join(root, DSL)).digest, sha256(bundled(DSL)))
  assert.equal(stderr.lines.length, 1)
  assert.match(stderr.lines[0], /could not get cloudcruise-workflow-dsl from http:\/\/127\.0\.0\.1:9/)
})

// A project may link a skill folder to a source it maintains itself (the
// CloudCruise monorepo links the DSL skill to its docs). Installing over the
// link would replace that source with a copy.
test("install --skills leaves a skill folder that is a symlink in place and reports it as skipped", async (t) => {
  const site = await docsSite()
  t.after(() => site.close())
  const cwd = project()
  const root = join(cwd, ".claude", "skills")
  mkdirSync(join(cwd, "docs", DSL), { recursive: true })
  writeFileSync(join(cwd, "docs", DSL, "SKILL.md"), "maintained here\n")
  mkdirSync(root, { recursive: true })
  symlinkSync(join("..", "..", "docs", DSL), join(root, DSL))

  const result = await installSkills([root], {
    env: { CLOUDCRUISE_SKILLS_BASE_URL: site.url },
    stderr: fakeStderr()
  })

  assert.ok(lstatSync(join(root, DSL)).isSymbolicLink())
  assert.equal(readFileSync(join(cwd, "docs", DSL, "SKILL.md"), "utf-8"), "maintained here\n")
  assert.deepEqual(result.skipped, [join(root, DSL)])
  assert.ok(!result.installed.includes(join(root, DSL)))
})

// A project with the DSL skill installed from the docs site, and a refresh
// that keeps its index cache in a fresh state dir.
async function installedFrom(site: DocsSite) {
  const cwd = project()
  const stateDir = mkdtempSync(join(tmpdir(), "remote-skills-state-"))
  const env = { CLOUDCRUISE_SKILLS_BASE_URL: site.url }
  await installSkills([join(cwd, ".claude", "skills")], { env, stderr: fakeStderr() })
  const dir = join(cwd, ".claude", "skills", DSL)
  const refresh = (stderr = fakeStderr(), now?: () => number) =>
    autoRefreshSkills({ cwd, env, settings: {}, stderr, stateDir, now })
  return { cwd, dir, refresh }
}

test("auto-refresh reinstalls the DSL skill when the docs site serves a new version", async (t) => {
  const site = await docsSite()
  t.after(() => site.close())
  const { dir, refresh } = await installedFrom(site)
  site.serve("served skill v3\n")

  await refresh()

  assert.equal(readFileSync(join(dir, "SKILL.md"), "utf-8"), "served skill v3\n")
  assert.equal(manifestOf(dir).digest, sha256("served skill v3\n"))
})

const HOUR = 60 * 60 * 1000

function indexChecks(site: DocsSite): number {
  return site.requests.filter((r) => r.endsWith("/index.json")).length
}

// Every CLI command runs the refresh, so the index is fetched at most once per
// six-hour window; a new DSL version reaches the project after the window.
test("auto-refresh checks the docs site's index at most once per six hours", async (t) => {
  const site = await docsSite()
  t.after(() => site.close())
  const { dir, refresh } = await installedFrom(site)
  const start = Date.now()
  const checksAfterInstall = indexChecks(site)

  await refresh(fakeStderr(), () => start)
  site.serve("served skill v3\n")
  await refresh(fakeStderr(), () => start + 5 * HOUR)

  assert.equal(indexChecks(site), checksAfterInstall + 1)
  assert.equal(readFileSync(join(dir, "SKILL.md"), "utf-8"), "served skill\n")

  await refresh(fakeStderr(), () => start + 7 * HOUR)

  assert.equal(indexChecks(site), checksAfterInstall + 2)
  assert.equal(readFileSync(join(dir, "SKILL.md"), "utf-8"), "served skill v3\n")
})

// Local edits are the user's work; only an explicit install may replace them.
test("auto-refresh keeps a DSL skill edited since install, even when the docs site serves a new version", async (t) => {
  const site = await docsSite()
  t.after(() => site.close())
  const { dir, refresh } = await installedFrom(site)
  writeFileSync(join(dir, "SKILL.md"), "my edits\n")
  site.serve("served skill v3\n")

  await refresh()

  assert.equal(readFileSync(join(dir, "SKILL.md"), "utf-8"), "my edits\n")
})

// The DSL skill follows production, not the CLI: a CLI upgrade with the same
// skill served must neither reinstall it nor flag it as out of date.
test("a DSL skill stamped by an older CLI is neither refreshed nor reported stale while the docs site serves the same version", async (t) => {
  const site = await docsSite()
  t.after(() => site.close())
  const { cwd, dir, refresh } = await installedFrom(site)
  const stampPath = join(dir, ".cloudcruise-skill.json")
  const aged = { ...manifestOf(dir), cliVersion: "0.0.1" }
  writeFileSync(stampPath, JSON.stringify(aged))
  const stderr = fakeStderr()

  await refresh(stderr)

  assert.deepEqual(manifestOf(dir), aged)
  assert.deepEqual(stderr.lines, [])
  assert.ok(!computeSkillsStatus(cwd).stale.includes(DSL))
})

// The download takes up to the refresh timeout; an edit made meanwhile is the
// user's work just like one made before the refresh started.
test("auto-refresh keeps a DSL skill edited while the new version downloads", async (t) => {
  const site = await docsSite()
  t.after(() => site.close())
  const { dir, refresh } = await installedFrom(site)
  site.serve("served skill v3\n")
  site.beforeSkillResponse(() => writeFileSync(join(dir, "SKILL.md"), "my edits\n"))

  await refresh()

  assert.equal(readFileSync(join(dir, "SKILL.md"), "utf-8"), "my edits\n")
})

function skillDownloads(site: DocsSite): number {
  return site.requests.filter((r) => r.endsWith("/skill.md")).length
}

// Every CLI command runs the refresh. A skill file that fails to download must
// not cost each command another request per skills root until the index is
// checked again.
test("a failed DSL download is tried once for all skills roots and not again until the index is checked again", async (t) => {
  const site = await docsSite()
  t.after(() => site.close())
  const cwd = project()
  const stateDir = mkdtempSync(join(tmpdir(), "remote-skills-state-"))
  const env = { CLOUDCRUISE_SKILLS_BASE_URL: site.url }
  const roots = [join(cwd, ".claude", "skills"), join(cwd, ".agents", "skills")]
  await installSkills(roots, { env, stderr: fakeStderr() })
  const downloadsAfterInstall = skillDownloads(site)
  site.serve("tampered\n", sha256("promised\n"))
  const start = Date.now()
  const refresh = (now: number) =>
    autoRefreshSkills({ cwd, env, settings: {}, stderr: fakeStderr(), stateDir, now: () => now })

  await refresh(start)
  await refresh(start + HOUR)

  assert.equal(skillDownloads(site), downloadsAfterInstall + 1)

  site.serve("served skill v3\n")
  await refresh(start + 7 * HOUR)

  for (const root of roots) {
    assert.equal(readFileSync(join(root, DSL, "SKILL.md"), "utf-8"), "served skill v3\n")
  }
})

// The base URL decides where agent instructions come from; a value that is not
// an http(s) URL is a misconfiguration to report, not a reason to fall back.
test("install --skills fails and names the variable when CLOUDCRUISE_SKILLS_BASE_URL is not an http(s) URL", async () => {
  for (const value of ["docs.cloudcruise.com", "file:///etc"]) {
    const root = join(project(), ".claude", "skills")
    await assert.rejects(
      installSkills([root], { env: { CLOUDCRUISE_SKILLS_BASE_URL: value }, stderr: fakeStderr() }),
      /CLOUDCRUISE_SKILLS_BASE_URL/
    )
  }
})

test("auto-refresh with an invalid CLOUDCRUISE_SKILLS_BASE_URL leaves installed skills alone and does not throw", async (t) => {
  const site = await docsSite()
  t.after(() => site.close())
  const { cwd, dir } = await installedFrom(site)
  const before = readFileSync(join(dir, "SKILL.md"), "utf-8")

  const refreshed = await autoRefreshSkills({
    cwd,
    env: { CLOUDCRUISE_SKILLS_BASE_URL: "not a url" },
    settings: {},
    stderr: fakeStderr(),
    stateDir: mkdtempSync(join(tmpdir(), "remote-skills-state-"))
  })

  assert.deepEqual(refreshed, [])
  assert.equal(readFileSync(join(dir, "SKILL.md"), "utf-8"), before)
})

// Stamps written before the DSL skill came from the docs site carry no digest.
test("an unedited DSL skill stamped without a digest is refreshed from the docs site", async (t) => {
  const site = await docsSite()
  t.after(() => site.close())
  const { dir, refresh } = await installedFrom(site)
  const { digest: _digest, source: _source, ...legacy } = manifestOf(dir)
  writeFileSync(join(dir, ".cloudcruise-skill.json"), JSON.stringify(legacy))

  await refresh()

  assert.equal(manifestOf(dir).digest, sha256("served skill\n"))
  assert.equal(manifestOf(dir).source, "remote")
})

// A copy of the repo's skills/ dir: one remote pack and one CLI pack.
function skillsDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "remote-skills-repo-"))
  mkdirSync(join(dir, DSL))
  writeFileSync(join(dir, DSL, "SKILL.md"), "committed\n")
  writeFileSync(join(dir, DSL, "skill.meta.json"), JSON.stringify({ remote: true }))
  mkdirSync(join(dir, "cloudcruise"))
  writeFileSync(join(dir, "cloudcruise", "SKILL.md"), "cli skill\n")
  return dir
}

// The scheduled sync keeps the repo's copy, which the plugins read, byte for
// byte equal to the served file, so its hash matches the index digest.
test("the repo sync writes the served DSL skill unchanged and leaves CLI skills alone", async (t) => {
  const site = await docsSite()
  t.after(() => site.close())
  site.serve("served skill v3\n")
  const dir = skillsDir()

  const result = await syncRemoteSkills({ skillsDir: dir, baseUrl: site.url })

  assert.deepEqual(result, { updated: [DSL], stale: [] })
  assert.equal(readFileSync(join(dir, DSL, "SKILL.md"), "utf-8"), "served skill v3\n")
  assert.equal(readFileSync(join(dir, "cloudcruise", "SKILL.md"), "utf-8"), "cli skill\n")
})

// The publish guard: a release must not bundle a DSL copy older than the one
// production serves. Check mode only reports; it never writes.
test("the repo sync in check mode reports a stale DSL copy without writing it, and nothing once synced", async (t) => {
  const site = await docsSite()
  t.after(() => site.close())
  const dir = skillsDir()

  const before = await syncRemoteSkills({ skillsDir: dir, baseUrl: site.url, check: true })
  assert.deepEqual(before, { updated: [], stale: [DSL] })
  assert.equal(readFileSync(join(dir, DSL, "SKILL.md"), "utf-8"), "committed\n")

  await syncRemoteSkills({ skillsDir: dir, baseUrl: site.url })
  const after = await syncRemoteSkills({ skillsDir: dir, baseUrl: site.url, check: true })
  assert.deepEqual(after, { updated: [], stale: [] })
})

// A sync must never replace the copy with something the index does not vouch for.
test("the repo sync fails and keeps the committed copy when the served file does not match its digest", async (t) => {
  const site = await docsSite()
  t.after(() => site.close())
  site.serve("tampered\n", sha256("promised\n"))
  const dir = skillsDir()

  await assert.rejects(
    syncRemoteSkills({ skillsDir: dir, baseUrl: site.url }),
    /does not match its digest/
  )
  assert.equal(readFileSync(join(dir, DSL, "SKILL.md"), "utf-8"), "committed\n")
})
