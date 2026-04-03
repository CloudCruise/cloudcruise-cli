import type { SSEEvent } from "./sse-client.js"

const WAITING_STATUSES = ["waiting_for_input", "waiting_for_chat"]

interface MessageState {
  role: string
  type?: string
  status: string
  toolName?: string
  text: string
  emittedTextLength: number
}

export interface BuilderStreamResult {
  finalText: string
  waitingForInput?: { messageId: string }
}

interface BuilderStreamOptions {
  onDone: () => void
}

const isTTY = process.stderr.isTTY ?? false
const dim = isTTY ? "\x1b[2m" : ""
const reset = isTTY ? "\x1b[0m" : ""

function writeProgress(msg: string): void {
  process.stderr.write(`${dim}${msg}${reset}\n`)
}

function writeText(text: string): void {
  process.stderr.write(text)
}

export async function processBuilderStream(
  stream: AsyncGenerator<SSEEvent>,
  opts: BuilderStreamOptions
): Promise<BuilderStreamResult> {
  const messages = new Map<string, MessageState>()
  let finalText = ""
  let waitingForInput: { messageId: string } | undefined

  for await (const event of stream) {
    if (event.event === "ping") continue

    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(event.data)
    } catch {
      continue
    }

    if (parsed.event_type === "admin_debug.update") continue

    const id = parsed.id as string | undefined
    if (!id) continue

    const role = parsed.role as string
    const status = parsed.status as string
    const type = parsed.type as string | undefined
    const toolName = parsed.toolName as string | undefined
    const text = parsed.text as string | undefined

    const prev = messages.get(id)

    // Detect error messages from any role
    if (status === "error") {
      const errorText = text ?? (parsed.content as Record<string, unknown>)?.error as string ?? "Unknown error"
      writeProgress(`Error: ${errorText}`)
      finalText = errorText
      opts.onDone()
      break
    }

    if (role === "tool" && toolName) {
      if (!prev || prev.status !== status) {
        if (status === "success") {
          writeProgress(`[${toolName}] Done`)
        } else if (text) {
          writeProgress(`[${toolName}] ${text}`)
        }
      }

      messages.set(id, {
        role,
        type,
        status,
        toolName,
        text: text ?? "",
        emittedTextLength: 0
      })
    } else if (role === "assistant" && type === "text" && text) {
      const prevLen = prev?.emittedTextLength ?? 0

      if (text.length > prevLen) {
        const delta = text.slice(prevLen)
        writeText(delta)
      }

      messages.set(id, {
        role,
        type,
        status,
        text,
        emittedTextLength: text.length
      })

      if (status === "success") {
        writeText("\n")
        finalText = text
        opts.onDone()
        break
      }
    }

    if (WAITING_STATUSES.includes(status)) {
      const messageId = parsed.messageId as string | undefined ?? id
      waitingForInput = { messageId }
      writeText("\n")
      writeProgress(
        `Agent is waiting for input. Use \`cloudcruise builder respond --message-id ${messageId} --value <val>\` to continue.`
      )
      finalText = text ?? prev?.text ?? ""
      opts.onDone()
      break
    }
  }

  return { finalText, waitingForInput }
}

