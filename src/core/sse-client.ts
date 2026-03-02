import { ApiClient } from "./api-client.js"

export interface SSEEvent {
  event?: string
  data: string
  id?: string
}

export async function* streamSSE(
  client: ApiClient,
  path: string
): AsyncGenerator<SSEEvent> {
  const url = client.sseUrl(path)
  const res = await fetch(url, {
    method: "GET",
    headers: {
      "cc-key": client.apiKey,
      Accept: "text/event-stream"
    }
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

  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break

      buffer += decoder.decode(value, { stream: true })
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""

      for (const line of lines) {
        if (line.startsWith("event:")) {
          currentEvent.event = line.slice(6).trim()
        } else if (line.startsWith("data:")) {
          const chunk = line.slice(5).trim()
          currentEvent.data =
            currentEvent.data !== undefined ? currentEvent.data + chunk : chunk
        } else if (line.startsWith("id:")) {
          currentEvent.id = line.slice(3).trim()
        } else if (line === "") {
          if (currentEvent.data !== undefined) {
            yield currentEvent as SSEEvent
          }
          currentEvent = {}
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}
