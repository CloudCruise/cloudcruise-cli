import { compareVersions } from "./skills.js"

export const UPDATE_COMMAND = "npm i -g @cloudcruise/cli@latest"

export const PLUGIN_NOTE =
  "Using the CloudCruise plugin in your coding agent? Update it there too."

export interface UpdateNotifierLike {
  update?: { current: string; latest: string }
  notify(): void
}

export interface StderrLike {
  isTTY?: boolean
  write(chunk: string): unknown
}

/**
 * Surface an available CLI update. On a TTY, update-notifier's box. Off a TTY
 * (a coding agent), one JSON line on stderr; stdout stays clean.
 */
export function notifyUpdate(
  notifier: UpdateNotifierLike,
  stderr: StderrLike
): void {
  if (stderr.isTTY) {
    notifier.notify()
    return
  }
  const update = notifier.update
  if (!update || compareVersions(update.latest, update.current) <= 0) return
  const payload = {
    cliVersion: update.current,
    latestVersion: update.latest,
    remedy: UPDATE_COMMAND,
    pluginNote: PLUGIN_NOTE
  }
  stderr.write(`${JSON.stringify({ updateAvailable: payload })}\n`)
}
