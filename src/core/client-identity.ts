import { detectAgent } from "std-env"
import { CLI_VERSION } from "./version.js"

/**
 * Name of the coding agent running the CLI, as reported by std-env.
 * Replit is only trusted when set explicitly via AI_AGENT: its REPL_ID marker
 * is also present in terminals humans use, and std-env checks it before most
 * other agents.
 */
export function detectCodingAgent(): string | undefined {
  const { name } = detectAgent()
  if (name !== "replit" || process.env.AI_AGENT) {
    return name
  }
  return detectAgentIgnoringReplit()
}

function detectAgentIgnoringReplit(): string | undefined {
  const replId = process.env.REPL_ID
  delete process.env.REPL_ID
  try {
    return detectAgent().name
  } finally {
    process.env.REPL_ID = replId
  }
}

export function clientIdentityHeaders(): Record<string, string> {
  const agent = detectCodingAgent()
  return {
    "X-CloudCruise-Client": `cli/${CLI_VERSION}`,
    ...(agent ? { "X-CloudCruise-Agent": agent } : {})
  }
}
