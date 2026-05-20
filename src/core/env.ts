import { existsSync, readFileSync } from "fs"
import { resolve } from "path"

function stripInlineComment(value: string): string {
  let quote: "'" | "\"" | undefined
  let escaped = false

  for (let i = 0; i < value.length; i += 1) {
    const char = value[i]

    if (escaped) {
      escaped = false
      continue
    }
    if (char === "\\") {
      escaped = true
      continue
    }
    if ((char === "'" || char === "\"") && !quote) {
      quote = char
      continue
    }
    if (char === quote) {
      quote = undefined
      continue
    }
    if (char === "#" && !quote && (i === 0 || /\s/.test(value[i - 1] ?? ""))) {
      return value.slice(0, i).trimEnd()
    }
  }

  return value
}

function parseEnvValue(raw: string): string {
  const value = stripInlineComment(raw.trim())
  const first = value[0]
  const last = value[value.length - 1]

  if (
    value.length >= 2 &&
    ((first === "\"" && last === "\"") || (first === "'" && last === "'"))
  ) {
    const unquoted = value.slice(1, -1)
    if (first === "'") return unquoted
    return unquoted
      .replace(/\\n/g, "\n")
      .replace(/\\r/g, "\r")
      .replace(/\\t/g, "\t")
      .replace(/\\"/g, "\"")
      .replace(/\\\\/g, "\\")
  }

  return value
}

export function loadDotEnv(path = resolve(process.cwd(), ".env")): void {
  if (!existsSync(path)) return

  const raw = readFileSync(path, "utf-8")
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith("#")) continue

    const assignment = trimmed.startsWith("export ")
      ? trimmed.slice("export ".length).trimStart()
      : trimmed
    const equalsIndex = assignment.indexOf("=")
    if (equalsIndex <= 0) continue

    const key = assignment.slice(0, equalsIndex).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    if (process.env[key] !== undefined) continue

    process.env[key] = parseEnvValue(assignment.slice(equalsIndex + 1))
  }
}
