import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "fs";
import { randomUUID } from "crypto";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { CLI_VERSION } from "./version.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getSkillsRootDir(): string {
  return join(__dirname, "..", "..", "..", "skills");
}

// A pack is any top-level dir under skills/ that contains a SKILL.md.
export function listSourcePacks(): string[] {
  const root = getSkillsRootDir();
  return readdirSync(root, { withFileTypes: true })
    .filter(
      (e) => e.isDirectory() && existsSync(join(root, e.name, "SKILL.md")),
    )
    .map((e) => e.name);
}

// Read the pack's `sharedReferences` sidecar field: the name of a directory
// under skills/_shared/ to install as the pack's references/ when the repo
// symlink didn't survive packaging (npm strips symlinks from tarballs).
function readSharedReferences(sourcePackDir: string): string | undefined {
  const metaPath = join(sourcePackDir, "skill.meta.json");
  if (!existsSync(metaPath)) return undefined;
  try {
    return (
      JSON.parse(readFileSync(metaPath, "utf-8")) as {
        sharedReferences?: string;
      }
    ).sharedReferences;
  } catch {
    return undefined;
  }
}

// Stamp the install-time manifest the staleness check reads. requiresCli is
// authored in each pack's skill.meta.json sidecar (not frontmatter).
function writeSkillManifest(
  sourcePackDir: string,
  destPackDir: string,
  pack: string,
): void {
  let requiresCli: string | undefined;
  const metaPath = join(sourcePackDir, "skill.meta.json");
  if (existsSync(metaPath)) {
    try {
      requiresCli = (
        JSON.parse(readFileSync(metaPath, "utf-8")) as { requiresCli?: string }
      ).requiresCli;
    } catch {
      // Missing/malformed sidecar — omit requiresCli.
    }
  }
  const manifest = {
    pack,
    cliVersion: CLI_VERSION,
    ...(requiresCli ? { requiresCli } : {}),
    installedAt: new Date().toISOString(),
  };
  writeFileSync(
    join(destPackDir, ".cloudcruise-skill.json"),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

// Copy a source pack into one target's skills root. Every agent that reads
// the SKILL.md format (Claude Code, Cursor native, Codex, Devin) takes the same
// unmodified pack tree — the only difference between targets is this root.
//
// The pack is built in a staging dir next to the root and swapped in by rename,
// so the root only ever holds a complete pack — also when a write fails midway
// or several CLI processes refresh the same pack at once. Staging dirs live
// outside the root so agents never load them as skills.
export function installPack(skillsRoot: string, pack: string): string {
  const dest = join(skillsRoot, pack);
  const staging = join(
    dirname(skillsRoot),
    `.cloudcruise-skill-${pack}-${randomUUID()}`,
  );
  const retired = `${staging}-old`;
  mkdirSync(skillsRoot, { recursive: true });
  try {
    buildPack(pack, staging);
    swapIn(staging, dest, retired);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  try {
    rmSync(retired, { recursive: true, force: true });
  } catch {
    // Unremovable leftovers stay outside the root, invisible to agents.
  }
  return dest;
}

function swapIn(staging: string, dest: string, retired: string): void {
  let moved = false;
  try {
    renameSync(dest, retired);
    moved = true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  try {
    renameSync(staging, dest);
  } catch (err) {
    if (moved && !existsSync(dest)) renameSync(retired, dest);
    throw err;
  }
}

// Shared reference dirs (skills/_shared/*) are symlinked into their consumer
// packs in the repo; the installed copy materializes them as real files so each
// installed pack is self-contained. Two paths get them there:
// - repo/dev: the symlink is present — replace it with a real copy (cpSync's
//   `dereference` does not reliably dereference directory symlinks);
// - npm tarball: npm strips symlinks entirely, so the pack declares its shared
//   dir in skill.meta.json (`sharedReferences`) and it's copied from _shared/.
function buildPack(pack: string, dest: string): void {
  const source = join(getSkillsRootDir(), pack);
  mkdirSync(dest, { recursive: true });
  cpSync(source, dest, { recursive: true });
  for (const entry of readdirSync(dest, { withFileTypes: true })) {
    const entryPath = join(dest, entry.name);
    if (lstatSync(entryPath).isSymbolicLink()) {
      const target = realpathSync(join(source, entry.name));
      rmSync(entryPath);
      cpSync(target, entryPath, { recursive: true });
    }
  }
  const sharedRefs = readSharedReferences(source);
  const destRefs = join(dest, "references");
  if (sharedRefs && !existsSync(destRefs)) {
    const sharedSource = join(getSkillsRootDir(), "_shared", sharedRefs);
    if (existsSync(sharedSource)) {
      cpSync(sharedSource, destRefs, { recursive: true });
    }
  }
  writeSkillManifest(source, dest, pack);
}

export function installPacksToRoot(skillsRoot: string): string[] {
  return listSourcePacks().map((pack) => installPack(skillsRoot, pack));
}
