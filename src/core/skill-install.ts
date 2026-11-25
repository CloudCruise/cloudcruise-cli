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
import { createHash, randomUUID } from "crypto";
import { join, dirname, relative } from "path";
import { fileURLToPath } from "url";
import { CLI_VERSION } from "./version.js";
import {
  fetchServedSkill,
  fetchSkillIndex,
  isRemotePackDir,
  sha256Digest,
  skillsBaseUrl,
  type ServedSkill,
} from "./remote-skills.js";
import type { StderrLike } from "./update-notice.js";

const MANIFEST_FILE = ".cloudcruise-skill.json";

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

// A pack's skill.meta.json sidecar:
// - sharedReferences: a directory under skills/_shared/ to install as the
//   pack's references/ when the repo symlink didn't survive packaging (npm
//   strips symlinks from tarballs);
// - requiresCli: the oldest CLI the pack works with;
// - remote: the pack is published on the docs site and installed from there;
//   the bundled copy is the fallback.
interface PackMeta {
  sharedReferences?: string;
  requiresCli?: string;
  remote?: boolean;
}

function readPackMeta(sourcePackDir: string): PackMeta {
  const metaPath = join(sourcePackDir, "skill.meta.json");
  if (!existsSync(metaPath)) return {};
  try {
    return JSON.parse(readFileSync(metaPath, "utf-8")) as PackMeta;
  } catch {
    return {};
  }
}

export function isRemotePack(pack: string): boolean {
  return isRemotePackDir(join(getSkillsRootDir(), pack));
}

export function listRemotePacks(): string[] {
  return listSourcePacks().filter(isRemotePack);
}

// Stamp the install-time manifest the staleness check reads. A remote pack's
// stamp records where its SKILL.md came from and that file's digest, which
// the refresh compares with the docs site's index.
function writeSkillManifest(
  meta: PackMeta,
  destPackDir: string,
  pack: string,
  served: ServedSkill | undefined,
): void {
  const manifest = {
    pack,
    cliVersion: CLI_VERSION,
    ...(meta.requiresCli ? { requiresCli: meta.requiresCli } : {}),
    ...(meta.remote
      ? {
          source: served ? "remote" : "bundled",
          digest: sha256Digest(readFileSync(join(destPackDir, "SKILL.md"))),
        }
      : {}),
    installedAt: new Date().toISOString(),
    contentHash: hashPack(destPackDir),
  };
  writeFileSync(
    join(destPackDir, MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
}

// Fingerprint of an installed pack's files (paths and contents, manifest
// excluded), recorded at install so later edits can be detected.
export function hashPack(packDir: string): string {
  const hash = createHash("sha256");
  for (const file of listFiles(packDir)) {
    const rel = relative(packDir, file).split("\\").join("/");
    if (rel === MANIFEST_FILE) continue;
    hash.update(`${rel}\0`);
    hash.update(readFileSync(file));
    hash.update("\0");
  }
  return hash.digest("hex");
}

function listFiles(dir: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...listFiles(path));
    else files.push(path);
  }
  return files.sort();
}

// Copy a source pack into one target's skills root. Every agent that reads
// the SKILL.md format (Claude Code, Cursor native, Codex, Devin) takes the same
// unmodified pack tree — the only difference between targets is this root.
//
// The pack is built in a staging dir next to the root and swapped in by rename,
// so the root only ever holds a complete pack — also when a write fails midway
// or several CLI processes refresh the same pack at once. Staging dirs live
// outside the root so agents never load them as skills.
export function installPack(
  skillsRoot: string,
  pack: string,
  served?: ServedSkill,
): string {
  if (!listSourcePacks().includes(pack)) {
    throw new Error(`Unknown skill pack: ${pack}`);
  }
  const dest = join(skillsRoot, pack);
  const staging = join(
    dirname(skillsRoot),
    `.cloudcruise-skill-${pack}-${randomUUID()}`,
  );
  const retired = `${staging}-old`;
  mkdirSync(skillsRoot, { recursive: true });
  try {
    buildPack(pack, staging, served);
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
function buildPack(pack: string, dest: string, served?: ServedSkill): void {
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
  const meta = readPackMeta(source);
  const sharedRefs = meta.sharedReferences;
  const destRefs = join(dest, "references");
  if (sharedRefs && !existsSync(destRefs)) {
    const sharedSource = join(getSkillsRootDir(), "_shared", sharedRefs);
    if (existsSync(sharedSource)) {
      cpSync(sharedSource, destRefs, { recursive: true });
    }
  }
  if (served) writeFileSync(join(dest, "SKILL.md"), served.content);
  writeSkillManifest(meta, dest, pack, served);
}

export function installPacksToRoot(
  skillsRoot: string,
  served: Map<string, ServedSkill> = new Map(),
): string[] {
  return listSourcePacks().map((pack) =>
    installPack(skillsRoot, pack, served.get(pack)),
  );
}

export interface InstallSkillsOptions {
  env: Record<string, string | undefined>;
  stderr: StderrLike;
  timeoutMs?: number;
}

export interface InstallSkillsResult {
  installed: string[];
  skipped: string[];
}

// Install every shipped pack into each root. Remote packs come from the docs
// site when it serves them with a matching digest, else from the bundle with
// a warning. A destination that is a symlink is someone's link to a source
// they maintain, so it is reported and left alone.
export async function installSkills(
  roots: string[],
  options: InstallSkillsOptions,
): Promise<InstallSkillsResult> {
  const served = await fetchRemotePacks(options);
  const result: InstallSkillsResult = { installed: [], skipped: [] };
  for (const root of roots) {
    for (const pack of listSourcePacks()) {
      const dest = join(root, pack);
      if (isSymlink(dest)) {
        result.skipped.push(dest);
        continue;
      }
      result.installed.push(installPack(root, pack, served.get(pack)));
    }
  }
  return result;
}

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

async function fetchRemotePacks(
  options: InstallSkillsOptions,
): Promise<Map<string, ServedSkill>> {
  const packs = listRemotePacks();
  const served = new Map<string, ServedSkill>();
  if (!packs.length) return served;
  const baseUrl = skillsBaseUrl(options.env);
  const timeoutMs = options.timeoutMs ?? 5000;
  let error: string | undefined;
  try {
    const index = await fetchSkillIndex(baseUrl, timeoutMs);
    for (const pack of packs) {
      served.set(pack, await fetchServedSkill(pack, index, timeoutMs));
    }
  } catch (err) {
    error = err instanceof Error ? err.message : String(err);
  }
  const fallback = packs.filter((p) => !served.has(p));
  if (fallback.length) {
    reportBundledFallback(options.stderr, { packs: fallback, baseUrl, error });
  }
  return served;
}

function reportBundledFallback(
  stderr: StderrLike,
  fallback: { packs: string[]; baseUrl: string; error?: string },
): void {
  if (stderr.isTTY) {
    stderr.write(
      `⚠ could not get ${fallback.packs.join(", ")} from ${fallback.baseUrl}${fallback.error ? ` (${fallback.error})` : ""}; installed the copy bundled with v${CLI_VERSION}\n`,
    );
    return;
  }
  stderr.write(
    `${JSON.stringify({ skillsBundledFallback: { cliVersion: CLI_VERSION, ...fallback } })}\n`,
  );
}
