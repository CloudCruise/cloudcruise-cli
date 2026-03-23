import { readFileSync, writeFileSync, unlinkSync, existsSync, chmodSync, mkdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"

export interface BuilderSession {
  conversationId: string
  name: string
  startedAt: string
  lastMessageCount?: number
}

const CONFIG_DIR = join(homedir(), ".cloudcruise")
const SESSION_FILE = join(CONFIG_DIR, "session.json")

export function loadSession(): BuilderSession | null {
  try {
    const raw = readFileSync(SESSION_FILE, "utf-8")
    return JSON.parse(raw) as BuilderSession
  } catch {
    return null
  }
}

export function saveSession(session: BuilderSession): void {
  mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 })
  writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2) + "\n")
  chmodSync(SESSION_FILE, 0o600)
}

export function updateSession(updates: Partial<BuilderSession>): void {
  const session = loadSession()
  if (!session) return
  saveSession({ ...session, ...updates })
}

export function deleteSession(): void {
  if (existsSync(SESSION_FILE)) {
    unlinkSync(SESSION_FILE)
  }
}

export function requireSession(): BuilderSession {
  const session = loadSession()
  if (!session) {
    throw new Error(
      "No active builder session. Run 'cloudcruise builder start' or 'cloudcruise builder edit' first."
    )
  }
  return session
}
