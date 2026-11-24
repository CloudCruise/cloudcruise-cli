import { createHash } from "crypto";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "fs";
import { get as httpGet } from "http";
import { get as httpsGet } from "https";
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

// node:http rather than fetch: an aborted fetch leaves its connection attempt,
// and with it the process, alive until the operating system gives up on it.
function get(
  url: URL,
  timeoutMs: number,
  signal: AbortSignal = AbortSignal.timeout(timeoutMs),
  redirects = 5,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const fail = (err: Error & { code?: string }) =>
      reject(
        new Error(
          `${url.href}: ${signal.aborted ? `no answer within ${timeoutMs} ms` : (err.code ?? err.message)}`,
        ),
      );
    const request = url.protocol === "https:" ? httpsGet : httpGet;
    const req = request(url, { signal }, (res) => {
      const status = res.statusCode ?? 0;
      const location = res.headers.location;
      if (status >= 300 && status < 400 && location) {
        res.resume();
        if (redirects === 0) {
          reject(new Error(`${url.href}: too many redirects`));
          return;
        }
        get(new URL(location, url), timeoutMs, signal, redirects - 1).then(resolve, reject);
        return;
      }
      if (status < 200 || status >= 300) {
        res.resume();
        reject(new Error(`${url.href} returned HTTP ${status}`));
        return;
      }
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => resolve(Buffer.concat(chunks)));
      res.on("error", fail);
    });
    req.on("error", fail);
  });
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
