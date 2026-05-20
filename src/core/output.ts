export function outputJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n")
}

const BASE64_RE = /^data:image\/[^;]+;base64,.{100,}/

export function stripBase64(obj: unknown): unknown {
  if (typeof obj === "string" && BASE64_RE.test(obj)) {
    return "[base64 image omitted]"
  }
  if (Array.isArray(obj)) return obj.map(stripBase64)
  if (obj !== null && typeof obj === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, value] of Object.entries(obj as Record<string, unknown>)) {
      out[key] = stripBase64(value)
    }
    return out
  }
  return obj
}

function useColor(stream: NodeJS.WriteStream): boolean {
  return Boolean(stream.isTTY || process.env.FORCE_COLOR)
}

export function outputError(message: string): void {
  if (useColor(process.stderr)) {
    process.stderr.write(`\x1b[31mError:\x1b[0m ${message}\n`)
    return
  }

  process.stderr.write(`Error: ${message}\n`)
}

export function outputEvent(
  event: string,
  data: Record<string, unknown>
): void {
  process.stdout.write(JSON.stringify({ event, ...data }) + "\n")
}
