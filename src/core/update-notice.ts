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

export interface UpdateCheckIo {
  stdout: { isTTY?: boolean }
  stderr: StderrLike
}

/**
 * Run update-notifier's check and surface an available CLI update. With stdout
 * on a TTY, update-notifier's box. Otherwise (a coding agent, or piped output),
 * one JSON line on stderr; stdout stays clean.
 */
export function checkForUpdate(
  createNotifier: () => UpdateNotifierLike,
  io: UpdateCheckIo
): void {
  const exitListeners = new Set(process.listeners("exit"))
  const notifier = createNotifier()
  if (io.stdout.isTTY) {
    notifier.notify()
    return
  }
  // update-notifier queues a human-readable "update check failed" box for exit
  // when its cache is not writable, e.g. in a sandboxed agent.
  for (const listener of process.listeners("exit")) {
    if (!exitListeners.has(listener)) process.off("exit", listener)
  }
  const update = notifier.update
  if (!update || compareVersions(update.latest, update.current) <= 0) return
  const payload = {
    cliVersion: update.current,
    latestVersion: update.latest,
    remedy: UPDATE_COMMAND,
    pluginNote: PLUGIN_NOTE
  }
  io.stderr.write(`${JSON.stringify({ updateAvailable: payload })}\n`)
}
