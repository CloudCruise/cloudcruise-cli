export function outputJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n")
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
