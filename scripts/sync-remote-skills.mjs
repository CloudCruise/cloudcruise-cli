#!/usr/bin/env node
// Syncs the bundled copies of remote skill packs from the docs site.
// --check: write nothing; exit 1 when a copy differs from the served version.
import { join } from "node:path"
import { skillsBaseUrl, syncRemoteSkills } from "../dist/src/core/remote-skills.js"

const check = process.argv.includes("--check")
const skillsDir = join(import.meta.dirname, "..", "skills")
let baseUrl

try {
  baseUrl = skillsBaseUrl(process.env)
  const { updated, stale } = await syncRemoteSkills({ skillsDir, baseUrl, check })
  if (stale.length) {
    console.error(
      `Out of date with ${baseUrl}: ${stale.join(", ")}. Run: npm run build && node scripts/sync-remote-skills.mjs`
    )
    process.exit(1)
  }
  console.log(updated.length ? `Synced from ${baseUrl}: ${updated.join(", ")}` : `Up to date with ${baseUrl}`)
} catch (err) {
  console.error(`Skills sync from ${baseUrl ?? "the docs site"} failed: ${err instanceof Error ? err.message : err}`)
  process.exit(1)
}
