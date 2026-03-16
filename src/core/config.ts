import {
  readFileSync,
  writeFileSync,
  mkdirSync,
  unlinkSync,
  existsSync,
  chmodSync
} from "fs"
import { join } from "path"
import { homedir } from "os"

export interface ProfileConfig {
  apiKey?: string
  baseUrl?: string
}

export interface CliConfig {
  activeProfile?: string
  profiles?: Record<string, ProfileConfig>
  // Legacy flat fields — kept only for migration detection
  apiKey?: string
  baseUrl?: string
}

const PROFILE_NAME_RE = /^[a-zA-Z0-9_-]+$/

const CONFIG_DIR = join(homedir(), ".cloudcruise")
const CONFIG_FILE = join(CONFIG_DIR, "config.json")

function readRawConfig(): CliConfig {
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8")
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

function writeRawConfig(config: CliConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n")
  chmodSync(CONFIG_FILE, 0o600)
}

function migrateIfNeeded(config: CliConfig): CliConfig {
  if (config.profiles) return config

  if (!config.apiKey && !config.baseUrl) return config

  const profile: ProfileConfig = {}
  if (config.apiKey) profile.apiKey = config.apiKey
  if (config.baseUrl) profile.baseUrl = config.baseUrl

  const migrated: CliConfig = {
    activeProfile: "default",
    profiles: { default: profile }
  }
  writeRawConfig(migrated)
  return migrated
}

export function validateProfileName(name: string): void {
  if (!PROFILE_NAME_RE.test(name)) {
    throw new Error(
      `Invalid profile name "${name}". Use only letters, numbers, hyphens, and underscores.`
    )
  }
}

export function loadConfig(): CliConfig {
  return migrateIfNeeded(readRawConfig())
}

export function saveConfig(config: CliConfig): void {
  writeRawConfig(config)
}

export function getActiveProfileName(): string {
  const config = loadConfig()
  return config.activeProfile ?? "default"
}

export function resolveProfileName(explicit?: string): string {
  if (explicit) {
    validateProfileName(explicit)
    return explicit
  }
  const envProfile = process.env.CLOUDCRUISE_PROFILE
  if (envProfile) {
    validateProfileName(envProfile)
    return envProfile
  }
  return getActiveProfileName()
}

export function loadProfile(name?: string): ProfileConfig {
  const config = loadConfig()
  const profileName = name ?? getActiveProfileName()
  return config.profiles?.[profileName] ?? {}
}

export function saveProfile(name: string, profile: ProfileConfig): void {
  validateProfileName(name)
  const config = loadConfig()

  if (!config.profiles) config.profiles = {}
  config.profiles[name] = profile

  if (!config.activeProfile || Object.keys(config.profiles).length === 1) {
    config.activeProfile = name
  }

  delete config.apiKey
  delete config.baseUrl
  writeRawConfig(config)
}

export function deleteProfile(name: string): void {
  validateProfileName(name)
  const config = loadConfig()

  if (!config.profiles?.[name]) {
    throw new Error(`Profile "${name}" does not exist.`)
  }

  delete config.profiles[name]

  if (config.activeProfile === name) {
    const remaining = Object.keys(config.profiles)
    config.activeProfile = remaining.length > 0 ? remaining.sort()[0] : undefined
  }

  if (Object.keys(config.profiles).length === 0) {
    delete config.profiles
    delete config.activeProfile
  }

  writeRawConfig(config)
}

export function setActiveProfile(name: string): void {
  validateProfileName(name)
  const config = loadConfig()

  if (!config.profiles?.[name]) {
    throw new Error(
      `Profile "${name}" does not exist. Available profiles: ${
        Object.keys(config.profiles ?? {}).join(", ") || "(none)"
      }`
    )
  }

  config.activeProfile = name
  writeRawConfig(config)
}

export function listProfiles(): { active: string | undefined; profiles: string[] } {
  const config = loadConfig()
  return {
    active: config.activeProfile,
    profiles: Object.keys(config.profiles ?? {}).sort()
  }
}

export function deleteConfig(): void {
  if (existsSync(CONFIG_FILE)) {
    unlinkSync(CONFIG_FILE)
  }
}

export function getConfigPath(): string {
  return CONFIG_FILE
}
