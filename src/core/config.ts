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

export interface CliConfig {
  apiKey?: string
  baseUrl?: string
}

const CONFIG_DIR = join(homedir(), ".cloudcruise")
const CONFIG_FILE = join(CONFIG_DIR, "config.json")

export function loadConfig(): CliConfig {
  try {
    const raw = readFileSync(CONFIG_FILE, "utf-8")
    return JSON.parse(raw)
  } catch {
    return {}
  }
}

export function saveConfig(config: CliConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n")
  chmodSync(CONFIG_FILE, 0o600)
}

export function deleteConfig(): void {
  if (existsSync(CONFIG_FILE)) {
    unlinkSync(CONFIG_FILE)
  }
}

export function getConfigPath(): string {
  return CONFIG_FILE
}
