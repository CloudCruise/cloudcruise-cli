import { test } from "node:test"
import assert from "node:assert/strict"
import { checkForUpdate } from "../dist/src/core/update-notice.js"

function fakeIo(stdoutIsTTY: boolean, stderrIsTTY = stdoutIsTTY) {
  const lines: string[] = []
  return {
    lines,
    stdout: { isTTY: stdoutIsTTY },
    stderr: {
      isTTY: stderrIsTTY,
      write(chunk: string) {
        lines.push(chunk)
        return true
      }
    }
  }
}

function fakeNotifier(update?: { current: string; latest: string }) {
  const notifier = {
    update,
    boxShown: false,
    notify() {
      notifier.boxShown = true
    }
  }
  return notifier
}

test("off a TTY, an available update is one JSON line on stderr with the update command and the plugin note", () => {
  const io = fakeIo(false)
  checkForUpdate(() => fakeNotifier({ current: "1.13.0", latest: "1.14.0" }), io)

  assert.equal(io.lines.length, 1)
  assert.ok(io.lines[0].endsWith("\n"))
  assert.deepEqual(JSON.parse(io.lines[0]), {
    updateAvailable: {
      cliVersion: "1.13.0",
      latestVersion: "1.14.0",
      remedy: "npm i -g @cloudcruise/cli@latest",
      pluginNote:
        "Using the CloudCruise plugin in your coding agent? Update it there too."
    }
  })
})

// update-notifier caches the last registry answer; after the user upgrades,
// that cached "latest" can equal or trail the running version.
test("off a TTY, nothing is written when the cached latest version is not newer than the running one", () => {
  const io = fakeIo(false)
  checkForUpdate(() => fakeNotifier({ current: "1.14.0", latest: "1.14.0" }), io)
  checkForUpdate(() => fakeNotifier({ current: "1.14.0", latest: "1.13.0" }), io)
  assert.deepEqual(io.lines, [])
})

// update-notifier leaves `update` unset when no check has found one, and when
// it is disabled (CI, NO_UPDATE_NOTIFIER, NODE_ENV=test).
test("off a TTY, nothing is written when update-notifier reports no update", () => {
  const io = fakeIo(false)
  checkForUpdate(() => fakeNotifier(undefined), io)
  assert.deepEqual(io.lines, [])
})

test("with stdout on a TTY, update-notifier's human-readable box is shown instead of JSON", () => {
  const io = fakeIo(true)
  const notifier = fakeNotifier({ current: "1.13.0", latest: "1.14.0" })
  checkForUpdate(() => notifier, io)
  assert.equal(notifier.boxShown, true)
  assert.deepEqual(io.lines, [])
})

// update-notifier's box only renders when stdout is a TTY, and reading the
// update consumes it, so `cloudcruise ... | jq` must get the JSON line instead.
test("with stdout piped and stderr on a TTY, the update is still reported as a JSON line", () => {
  const io = fakeIo(false, true)
  checkForUpdate(() => fakeNotifier({ current: "1.13.0", latest: "1.14.0" }), io)
  assert.equal(JSON.parse(io.lines[0]).updateAvailable.latestVersion, "1.14.0")
})

// When ~/.config is not writable (sandboxed agents), update-notifier queues a
// multi-line "update check failed" box for process exit. Off a TTY that box
// would land on stderr after every command, between the JSON lines agents parse.
test("off a TTY, an exit message queued by update-notifier is dropped", () => {
  const queued = () => {}
  checkForUpdate(() => {
    process.on("exit", queued)
    return fakeNotifier(undefined)
  }, fakeIo(false))
  assert.equal(process.listeners("exit").includes(queued), false)
})

test("with stdout on a TTY, an exit message queued by update-notifier is kept", () => {
  const queued = () => {}
  try {
    checkForUpdate(() => {
      process.on("exit", queued)
      return fakeNotifier(undefined)
    }, fakeIo(true))
    assert.equal(process.listeners("exit").includes(queued), true)
  } finally {
    process.off("exit", queued)
  }
})
