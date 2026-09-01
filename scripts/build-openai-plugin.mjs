#!/usr/bin/env node
// Build the skills-only zip for the OpenAI plugin directory.
//
// Archive layout (per https://developers.openai.com/plugins/guides/submit-claude-plugin):
//   .claude-plugin/plugin.json   — manifest at archive root (no marketplace.json)
//   skills/<name>/SKILL.md       — the six skills, with _shared symlinks dereferenced
//
// Output: out/cloudcruise-openai-plugin-v<version>.zip

import { cpSync, mkdirSync, rmSync, readFileSync, lstatSync, readdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const outDir = join(root, "out");
const staging = join(outDir, "openai-plugin");

const manifest = JSON.parse(readFileSync(join(root, ".claude-plugin", "plugin.json"), "utf8"));
if (!manifest.description) throw new Error("plugin.json needs a nonempty description");

rmSync(staging, { recursive: true, force: true });
mkdirSync(join(staging, ".claude-plugin"), { recursive: true });

// Manifest only — marketplace.json must not ship in a skills-only archive.
cpSync(join(root, ".claude-plugin", "plugin.json"), join(staging, ".claude-plugin", "plugin.json"));

// Skills, dereferencing the references -> ../_shared symlinks into real copies.
// _shared itself and README.md are not skills and stay out.
// cp -RL, not fs.cpSync({dereference}): cpSync leaves directory symlinks
// inside the tree as symlinks (nodejs/node#57827-adjacent behavior).
const skillsSrc = join(root, "skills");
mkdirSync(join(staging, "skills"));
for (const entry of readdirSync(skillsSrc)) {
  if (entry === "_shared" || entry === "README.md") continue;
  execFileSync("cp", ["-RL", join(skillsSrc, entry), join(staging, "skills", entry)]);
}

// Verify: every skill has a SKILL.md and no symlinks survived.
const walk = (dir) =>
  readdirSync(dir, { withFileTypes: true }).flatMap((d) => {
    const p = join(dir, d.name);
    if (lstatSync(p).isSymbolicLink()) throw new Error(`symlink survived dereference: ${p}`);
    return d.isDirectory() ? walk(p) : [p];
  });
walk(staging);
for (const skill of readdirSync(join(staging, "skills"))) {
  if (!existsSync(join(staging, "skills", skill, "SKILL.md")))
    throw new Error(`skills/${skill} has no SKILL.md`);
}

const zipPath = join(outDir, `cloudcruise-openai-plugin-v${manifest.version}.zip`);
rmSync(zipPath, { force: true });
execFileSync("zip", ["-r", "-X", zipPath, ".claude-plugin", "skills"], {
  cwd: staging,
  stdio: "inherit",
});

const skillCount = readdirSync(join(staging, "skills")).length;
console.log(`\nbuilt ${zipPath} (${skillCount} skills, v${manifest.version})`);
