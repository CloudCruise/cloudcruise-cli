import { test } from "node:test"
import assert from "node:assert/strict"
import { notifyUpdate } from "../dist/src/core/update-notice.js"

function fakeStderr(isTTY: boolean) {
  const lines: string[] = []
  return {
    isTTY,
    lines,
    write(chunk: string) {
      lines.push(chunk)
      return true
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
  const stderr = fakeStderr(false)
  notifyUpdate(fakeNotifier({ current: "1.13.0", latest: "1.14.0" }), stderr)

  assert.equal(stderr.lines.length, 1)
  assert.ok(stderr.lines[0].endsWith("\n"))
  assert.deepEqual(JSON.parse(stderr.lines[0]), {
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
  const stderr = fakeStderr(false)
  notifyUpdate(fakeNotifier({ current: "1.14.0", latest: "1.14.0" }), stderr)
  notifyUpdate(fakeNotifier({ current: "1.14.0", latest: "1.13.0" }), stderr)
  assert.deepEqual(stderr.lines, [])
})

// update-notifier leaves `update` unset when no check has found one, and when
// it is disabled (CI, NO_UPDATE_NOTIFIER, NODE_ENV=test).
test("off a TTY, nothing is written when update-notifier reports no update", () => {
  const stderr = fakeStderr(false)
  notifyUpdate(fakeNotifier(undefined), stderr)
  assert.deepEqual(stderr.lines, [])
})

test("on a TTY, update-notifier's human-readable box is shown instead of JSON", () => {
  const stderr = fakeStderr(true)
  const notifier = fakeNotifier({ current: "1.13.0", latest: "1.14.0" })
  notifyUpdate(notifier, stderr)
  assert.equal(notifier.boxShown, true)
  assert.deepEqual(stderr.lines, [])
})
