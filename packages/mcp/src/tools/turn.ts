import { createHash } from "node:crypto"
import { ApiError, type StrataClient } from "@cloudcruise/strata"
import { waitForChange, type Wait } from "./common.js"

/** A builder turn's phase, as /turn-state reports it; `ended` only observe reports, for a gone conversation. */
export type Phase = "processing" | "awaiting-human-input" | "completed" | "agent-errored" | "idle" | "ended"

/** What /turn-state returns. */
export interface TurnState {
  phase: Phase
  /** The user message that opened the current turn; null before any turn. */
  turnId?: string | null
  report?: string
  humanInput?: { messageId: string; prompt?: string; fields?: Record<string, unknown>[] }
}

export const GONE = "This conversation is gone: it was cleared or has expired."

/** The builder's path for a conversation. */
export function builderPath(conversationId: string, action: string): string {
  return `/workflow-builder/agent/${conversationId}/${action}`
}

/** What the caller last saw of a turn: the v1 cursor `t<turn>.<phase>[.<question>]`. */
export interface TurnCursor {
  turn: string
  /** A phase from a cursor the caller passed back, so not checked against Phase. */
  phase: string
  question?: string
}

const TURN_CURSOR = /^t([0-9a-f]{8}|0)\.([a-z-]+)(?:\.([0-9a-f]{8}))?$/

export function turnCursor(state: TurnState): TurnCursor {
  const question = state.phase === "awaiting-human-input" && state.humanInput ? digest(state.humanInput.messageId) : undefined
  return { turn: state.turnId ? digest(state.turnId) : "0", phase: state.phase, ...(question ? { question } : {}) }
}

export function formatTurnCursor(cursor: TurnCursor): string {
  return `t${cursor.turn}.${cursor.phase}${cursor.question ? `.${cursor.question}` : ""}`
}

export function parseTurnCursor(after: string): TurnCursor | undefined {
  const match = TURN_CURSOR.exec(after)
  return match ? { turn: match[1], phase: match[2], ...(match[3] ? { question: match[3] } : {}) } : undefined
}

// Short, so the cursor stays readable; ids only need telling apart, not recovering.
function digest(id: string): string {
  return createHash("sha256").update(id).digest("hex").slice(0, 8)
}

/** The live conversation a cleared or restarted one continues as, when the API's 404 names it. */
export function successorOf(err: unknown): string | undefined {
  if (!(err instanceof ApiError) || err.code !== "CONVERSATION_NOT_FOUND") return undefined
  try {
    const id = (JSON.parse(err.body) as { successorConversationId?: unknown }).successorConversationId
    return typeof id === "string" && id ? id : undefined
  } catch {
    return undefined
  }
}

export function isGone(err: unknown): boolean {
  return err instanceof ApiError && err.code === "CONVERSATION_NOT_FOUND"
}

// Reads the turn until it differs from the cursor or the wait ends. A stopped turn
// returns at once: nothing changes until the caller acts. The signature is the one
// an API-side wait would take.
export function readTurn(api: StrataClient, id: string, cursor: TurnCursor | undefined, wait: Wait): Promise<TurnState> {
  return waitForChange(
    () => api.get<TurnState>(builderPath(id, "turn-state")),
    (state) => !cursor || turnChanged(state, cursor),
    wait
  )
}

function turnChanged(state: TurnState, cursor: TurnCursor): boolean {
  if (state.phase !== "processing") return true
  const now = turnCursor(state)
  return now.turn !== cursor.turn || now.phase !== cursor.phase || now.question !== cursor.question
}
