import { ApiClient } from "./api-client.js"

export interface SSEEvent {
  event?: string
  data: string
  id?: string
}

export async function* streamSSE(
  client: ApiClient,
  path: string,
  signal?: AbortSignal
): AsyncGenerator<SSEEvent> {
  const url = client.sseUrl(path)
  const res = await fetch(url, {
    method: "GET",
    headers: client.authHeaders({
      Accept: "text/event-stream"
    }),
    signal
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`SSE ${path} failed (${res.status}): ${body}`)
  }

  if (!res.body) {
    throw new Error("No response body for SSE stream")
  }

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  let currentEvent: Partial<SSEEvent> = {}
  const processLine = (rawLine: string): SSEEvent | null => {
    const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine
    if (line.startsWith("event:")) {
      let event = line.slice(6)
      if (event.startsWith(" ")) event = event.slice(1)
      currentEvent.event = event
    } else if (line.startsWith("data:")) {
      let chunk = line.slice(5)
      if (chunk.startsWith(" ")) chunk = chunk.slice(1)
      currentEvent.data =
        currentEvent.data !== undefined ? `${currentEvent.data}\n${chunk}` : chunk
    } else if (line.startsWith("id:")) {
      let id = line.slice(3)
      if (id.startsWith(" ")) id = id.slice(1)
      currentEvent.id = id
    } else if (line === "") {
      if (currentEvent.data !== undefined) {
        const event = currentEvent as SSEEvent
        currentEvent = {}
        return event
      }
      currentEvent = {}
    }
    return null
  }

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        const event = processLine(line)
        if (event) yield event
      }
    }
    buffer += decoder.decode()
    if (buffer.length > 0) {
      const lines = buffer.split("\n")
      for (const line of lines) {
        const event = processLine(line)
        if (event) yield event
      }
    }
    if (currentEvent.data !== undefined) {
      yield currentEvent as SSEEvent
    }
  } catch (err: unknown) {
    if (err instanceof DOMException && err.name === "AbortError") return
    throw err
  } finally {
    reader.releaseLock()
  }
}
