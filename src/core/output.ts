export function outputJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n")
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
