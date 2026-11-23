import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

// Skills that don't depend on the CLI are published on the docs site through
// the Agent Skills discovery index (v0.2.0): one entry per skill with its URL
// and the sha256 digest of the served file.
export const DEFAULT_SKILLS_BASE_URL = "https://docs.cloudcruise.com";
const INDEX_PATH = "/.well-known/agent-skills/index.json";

export interface IndexEntry {
  url: string;
  digest: string;
}

export interface ServedSkill {
  name: string;
  digest: string;
  content: Buffer;
}

export function skillsBaseUrl(env: Record<string, string | undefined>): string {
  const value = env.CLOUDCRUISE_SKILLS_BASE_URL;
  if (!value) return DEFAULT_SKILLS_BASE_URL;
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    url = undefined;
  }
  if (url?.protocol !== "https:" && url?.protocol !== "http:") {
    throw new Error(
      `CLOUDCRUISE_SKILLS_BASE_URL must be an http(s) URL, got "${value}"`,
    );
  }
  return value;
}

export function sha256Digest(content: Buffer | string): string {
  return `sha256:${createHash("sha256").update(content).digest("hex")}`;
}

async function get(url: URL, timeoutMs: number): Promise<Buffer> {
  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (err) {
    const cause = (err as { cause?: { code?: string; message?: string } }).cause;
    throw new Error(
      `${url.href}: ${cause?.code ?? cause?.message ?? (err as Error).message}`,
    );
  }
  if (!res.ok) throw new Error(`${url.href} returned HTTP ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

// Entries pointing at another origin are dropped: the digest comes from the
// same index, so it only vouches for files on the site that serves it.
export async function fetchSkillIndex(
  baseUrl: string,
  timeoutMs: number,
): Promise<Map<string, IndexEntry>> {
  const indexUrl = new URL(INDEX_PATH, baseUrl);
  const body = JSON.parse((await get(indexUrl, timeoutMs)).toString("utf-8")) as {
    skills?: { name?: unknown; url?: unknown; digest?: unknown }[];
  };
  const entries = new Map<string, IndexEntry>();
  for (const skill of body.skills ?? []) {
    if (
      typeof skill?.name !== "string" ||
      typeof skill.url !== "string" ||
      typeof skill.digest !== "string"
    ) {
      continue;
    }
    const url = new URL(skill.url, indexUrl);
    if (url.origin !== indexUrl.origin) continue;
    entries.set(skill.name, { url: url.href, digest: skill.digest });
  }
  return entries;
}

export async function fetchServedSkill(
  name: string,
  index: Map<string, IndexEntry>,
  timeoutMs: number,
): Promise<ServedSkill> {
  const entry = index.get(name);
  if (!entry) throw new Error(`${name} is not listed in the skills index`);
  const content = await get(new URL(entry.url), timeoutMs);
  if (sha256Digest(content) !== entry.digest) {
    throw new Error(`${name} does not match its digest in the skills index`);
  }
  return { name, digest: entry.digest, content };
}

export interface SyncRemoteSkillsOptions {
  skillsDir: string;
  baseUrl: string;
  check?: boolean;
  timeoutMs?: number;
}

export interface SyncRemoteSkillsResult {
  updated: string[];
  stale: string[];
}

// Bring the bundled copies of remote packs (skill.meta.json `remote: true`) in
// line with the docs site, byte for byte. In check mode nothing is written;
// packs whose copy differs from the served digest are reported as stale.
export async function syncRemoteSkills(
  options: SyncRemoteSkillsOptions,
): Promise<SyncRemoteSkillsResult> {
  const timeoutMs = options.timeoutMs ?? 10000;
  const result: SyncRemoteSkillsResult = { updated: [], stale: [] };
  const packs = readdirSync(options.skillsDir).filter((pack) =>
    isRemotePackDir(join(options.skillsDir, pack)),
  );
  if (!packs.length) return result;
  const index = await fetchSkillIndex(options.baseUrl, timeoutMs);
  for (const pack of packs) {
    const skillPath = join(options.skillsDir, pack, "SKILL.md");
    const entry = index.get(pack);
    if (!entry) throw new Error(`${pack} is not listed in the skills index`);
    if (existsSync(skillPath) && sha256Digest(readFileSync(skillPath)) === entry.digest) {
      continue;
    }
    if (options.check) {
      result.stale.push(pack);
      continue;
    }
    const served = await fetchServedSkill(pack, index, timeoutMs);
    writeFileSync(skillPath, served.content);
    result.updated.push(pack);
  }
  return result;
}

export function isRemotePackDir(packDir: string): boolean {
  try {
    const meta = JSON.parse(readFileSync(join(packDir, "skill.meta.json"), "utf-8"));
    return meta?.remote === true;
  } catch {
    return false;
  }
}
