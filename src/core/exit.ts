import { ApiError } from "./api-client.js"

/**
 * The machine-first exit-code taxonomy shared by every command. A driver keys
 * its control flow on these numbers alone — stderr is for humans/logs.
 *
 * See the "Exit-code taxonomy" contract note for the full mapping.
 */
export const ExitCode = {
  SUCCESS: 0,
  FAILURE: 1,
  BAD_ARGS: 2,
  AUTH: 3,
  SESSION_NOT_FOUND: 4,
  AMBIGUOUS_SESSION: 5,
  SESSION_BUSY: 6,
  AWAITING_HUMAN_INPUT: 7,
  AGENT_ERROR: 8,
  TIMEOUT: 9,
  NO_BROWSER_ATTACHED: 10,
  SKILLS_INCOMPATIBLE: 11
} as const

export type ExitCodeValue = (typeof ExitCode)[keyof typeof ExitCode]

/**
 * A client-side usage error (bad flags, malformed stdin, conflicting options).
 * Maps to exit 2 so it is distinguishable from an unexpected failure (exit 1).
 */
export class UsageError extends Error {
  readonly name = "UsageError"
}

/**
 * More than one live conversation in scope and no explicit `--conversation`.
 * Maps to exit 5. Carries the candidate roster so the handler can print it to
 * stderr.
 */
export class AmbiguousSessionError extends Error {
  readonly name = "AmbiguousSessionError"
  constructor(
    message: string,
    readonly sessions: unknown[] = []
  ) {
    super(message)
  }
}

/**
 * Installed CloudCruise skills are incompatible with this CLI version (a breaking
 * skills/CLI change). Maps to exit 11. Only thrown when the skills gate is set to
 * "refuse" and a gated command runs.
 */
export class SkillsIncompatibleError extends Error {
  readonly name = "SkillsIncompatibleError"
  constructor(
    message: string,
    readonly packs: string[] = []
  ) {
    super(message)
  }
}

/**
 * Map a backend error to an exit code. The machine `code` wins (it disambiguates
 * same-status cases like 409 SESSION_BUSY vs ALREADY_ANSWERED); HTTP status is
 * the fallback for any error the backend has not (yet) given a specific code.
 */
export function exitCodeForApiError(err: ApiError): ExitCodeValue {
  switch (err.code) {
    case "SESSION_BUSY":
      return ExitCode.SESSION_BUSY
    case "ALREADY_ANSWERED":
      return ExitCode.AWAITING_HUMAN_INPUT
    case "CONVERSATION_NOT_FOUND":
      return ExitCode.SESSION_NOT_FOUND
    case "VALIDATION_FAILED":
    case "BAD_REQUEST":
      return ExitCode.BAD_ARGS
    case "UNAUTHENTICATED":
    case "FORBIDDEN":
      return ExitCode.AUTH
    case "TIMEOUT":
      return ExitCode.TIMEOUT
    case "NO_BROWSER_ATTACHED":
      return ExitCode.NO_BROWSER_ATTACHED
  }
  switch (err.status) {
    case 400:
    case 422:
      return ExitCode.BAD_ARGS
    case 401:
    case 403:
      return ExitCode.AUTH
    case 404:
      return ExitCode.SESSION_NOT_FOUND
    case 408:
      return ExitCode.TIMEOUT
    default:
      return ExitCode.FAILURE
  }
}

/**
 * Map an observed conversation status to an exit code (for observe commands like
 * `status`). `processing` only reaches here when a long-poll expired without
 * settling — the driver ticks and re-arms (exit 9).
 */
export function exitCodeForStatus(status: string): ExitCodeValue {
  switch (status) {
    case "completed":
    case "idle":
    case "ended":
      return ExitCode.SUCCESS
    case "awaiting-human-input":
      return ExitCode.AWAITING_HUMAN_INPUT
    case "agent-errored":
      return ExitCode.AGENT_ERROR
    case "processing":
      return ExitCode.TIMEOUT
    default:
      // An unrecognized status means the CLI is out of sync with the backend
      // taxonomy. Don't fail open to SUCCESS (a driver would proceed on a
      // session that isn't actually done); treat it as tick+re-arm (exit 9) so
      // the driver keeps polling — safe for a new transient status (queued/
      // paused) and, for a new terminal one, its own poll cap bails it out.
      return ExitCode.TIMEOUT
  }
}

/**
 * Terminal error handler for every command. Writes a machine-readable error
 * envelope to stderr (never stdout — stdout stays clean for parsers) and exits
 * with the mapped code.
 */
export function fail(err: unknown): never {
  let exitCode: ExitCodeValue = ExitCode.FAILURE
  const envelope: Record<string, unknown> = {}

  if (err instanceof ApiError) {
    exitCode = exitCodeForApiError(err)
    envelope.code = err.code ?? "ERROR"
    envelope.statusCode = err.status
    envelope.message = err.message
    let messageId: string | undefined
    try {
      messageId = (JSON.parse(err.body) as { messageId?: string }).messageId
    } catch {
      // Non-JSON body — nothing more to surface.
    }
    if (messageId) envelope.messageId = messageId
  } else if (err instanceof AmbiguousSessionError) {
    exitCode = ExitCode.AMBIGUOUS_SESSION
    envelope.code = "AMBIGUOUS_SESSION"
    envelope.message = err.message
    envelope.sessions = err.sessions
  } else if (err instanceof UsageError) {
    exitCode = ExitCode.BAD_ARGS
    envelope.code = "BAD_ARGS"
    envelope.message = err.message
  } else if (err instanceof SkillsIncompatibleError) {
    exitCode = ExitCode.SKILLS_INCOMPATIBLE
    envelope.code = "SKILLS_INCOMPATIBLE"
    envelope.message = err.message
    envelope.packs = err.packs
  } else {
    envelope.code = "FAILURE"
    envelope.message = err instanceof Error ? err.message : String(err)
  }

  envelope.exitCode = exitCode
  process.stderr.write(`${JSON.stringify(envelope)}\n`)
  process.exit(exitCode)
}

/**
 * Echo the resolved conversation on stderr so a driver always knows which
 * conversation a command acted on and how it was resolved (stdout stays
 * reserved for the answer). Naming the source lets a driver tell it fell into
 * implicit roster resolution — the case a second live conversation breaks with
 * exit 5.
 */
export function echoSession(
  conversationId: string,
  source?: "flag" | "env" | "roster"
): void {
  process.stderr.write(
    `conversation ${conversationId}${source ? ` (via ${source})` : ""}\n`
  )
}
