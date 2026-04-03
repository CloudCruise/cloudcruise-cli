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
    for (const [k, v] of Object.entries(obj as Record<string, unknown>)) {
      out[k] = stripBase64(v)
    }
    return out
  }
  return obj
}

export function outputError(message: string): void {
  process.stderr.write(`Error: ${message}\n`)
}

export function outputEvent(
  event: string,
  data: Record<string, unknown>
): void {
  process.stdout.write(JSON.stringify({ event, ...data }) + "\n")
}
