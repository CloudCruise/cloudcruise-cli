import { readFileSync } from "fs"
import { UsageError } from "./exit.js"

export async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(chunk as Buffer)
  }
  return Buffer.concat(chunks).toString("utf-8")
}

/** The payload flags a command may offer: --data <json>, --file <path>, --stdin. */
export type JsonObjectSource = {
  data?: string
  file?: string
  stdin?: boolean
}

export function hasJsonObjectSource(src: JsonObjectSource): boolean {
  return (
    src.data !== undefined || src.file !== undefined || src.stdin === true
  )
}

/**
 * Read a JSON object from whichever of --data, --file or --stdin was passed.
 * Returns undefined when none was. Every input problem is a UsageError (exit 2).
 */
export async function readJsonObject(
  src: JsonObjectSource
): Promise<Record<string, unknown> | undefined> {
  const given: string[] = []
  if (src.data !== undefined) given.push("--data")
  if (src.file !== undefined) given.push("--file")
  if (src.stdin) given.push("--stdin")
  if (given.length === 0) return undefined
  if (given.length > 1) {
    throw new UsageError(`Pass only one of ${given.join(", ")}`)
  }
  const flag = given[0]
  const value = await readJson(flag, src)
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new UsageError(`${flag} must contain a JSON object`)
  }
  return value as Record<string, unknown>
}

/**
 * Read a JSON array from a --<name>-file path or --<name>-stdin. Returns
 * undefined when neither was passed. Every input problem is a UsageError.
 */
export async function readJsonArray(
  flag: string,
  src: { file?: string; stdin?: boolean }
): Promise<unknown[] | undefined> {
  if (src.file === undefined && !src.stdin) return undefined
  const value = await readJson(flag, src)
  if (!Array.isArray(value)) {
    throw new UsageError(`${flag} must contain a JSON array`)
  }
  return value
}

async function readJson(flag: string, src: JsonObjectSource): Promise<unknown> {
  let raw: string
  if (src.stdin) {
    raw = await readStdin()
  } else if (src.file !== undefined) {
    try {
      raw = readFileSync(src.file, "utf-8")
    } catch (err: unknown) {
      const reason = err instanceof Error ? err.message : String(err)
      throw new UsageError(`Cannot read ${flag} ${src.file}: ${reason}`)
    }
  } else {
    raw = src.data as string
  }
  try {
    return JSON.parse(raw)
  } catch (err: unknown) {
    const reason = err instanceof Error ? err.message : String(err)
    throw new UsageError(`${flag} must contain valid JSON: ${reason}`)
  }
}

/** readJsonObject, but a missing payload is a UsageError too. */
export async function requireJsonObject(
  src: JsonObjectSource,
  missingMessage = "Provide --file <path> or --stdin"
): Promise<Record<string, unknown>> {
  const value = await readJsonObject(src)
  if (value === undefined) throw new UsageError(missingMessage)
  return value
}
