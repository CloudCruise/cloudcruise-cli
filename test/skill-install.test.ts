import { test } from "node:test"
import assert from "node:assert/strict"
import { existsSync, mkdtempSync, readdirSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { installPack, installPacksToRoot, listSourcePacks } from "../dist/src/core/skill-install.js"

test("installing into a project without a skills root creates the root and every shipped pack", () => {
  const cwd = mkdtempSync(join(tmpdir(), "skill-install-"))
  const root = join(cwd, ".claude", "skills")

  installPacksToRoot(root)

  assert.deepEqual(readdirSync(root).sort(), listSourcePacks().sort())
  for (const pack of listSourcePacks()) {
    assert.ok(existsSync(join(root, pack, ".cloudcruise-skill.json")))
  }
})

// Packs are built in a staging dir beside the root and renamed into place; a
// successful install leaves nothing behind there.
test("a successful install leaves no staging dirs next to the skills root", () => {
  const cwd = mkdtempSync(join(tmpdir(), "skill-install-"))
  const root = join(cwd, ".claude", "skills")

  installPacksToRoot(root)
  installPacksToRoot(root)

  assert.deepEqual(readdirSync(join(cwd, ".claude")), ["skills"])
})

// Pack names become path segments under the skills root; only the packs this
// CLI ships are valid, so no name can point outside the root.
test("installing a pack this CLI does not ship is refused before anything is written", () => {
  const cwd = mkdtempSync(join(tmpdir(), "skill-install-"))
  const root = join(cwd, ".claude", "skills")

  assert.throws(() => installPack(root, "../../escaped"), /Unknown skill pack/)
  assert.deepEqual(readdirSync(cwd), [])
})
