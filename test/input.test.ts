import { test } from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  readJsonObject,
  requireJsonObject
} from "../dist/src/core/input.js"

function writeFile(contents: string): string {
  const path = join(mkdtempSync(join(tmpdir(), "input-")), "payload.json")
  writeFileSync(path, contents)
  return path
}

test("readJsonObject returns undefined when no source is passed", async () => {
  assert.equal(await readJsonObject({}), undefined)
})

test("readJsonObject reads --data and --file", async () => {
  assert.deepEqual(await readJsonObject({ data: '{"a":1}' }), { a: 1 })
  assert.deepEqual(await readJsonObject({ file: writeFile('{"b":2}') }), { b: 2 })
})

test("readJsonObject rejects more than one source", async () => {
  await assert.rejects(readJsonObject({ data: "{}", file: "x.json" }), {
    name: "UsageError",
    message: "Pass only one of --data, --file"
  })
})

test("readJsonObject rejects invalid JSON as a usage error", async () => {
  await assert.rejects(readJsonObject({ file: writeFile("{nope") }), {
    name: "UsageError",
    message: /^--file must contain valid JSON/
  })
})

test("readJsonObject rejects arrays and scalars", async () => {
  await assert.rejects(readJsonObject({ data: "[1]" }), {
    name: "UsageError",
    message: "--data must contain a JSON object"
  })
  await assert.rejects(readJsonObject({ data: "null" }), {
    name: "UsageError",
    message: "--data must contain a JSON object"
  })
})

test("readJsonObject reports an unreadable --file as a usage error", async () => {
  await assert.rejects(readJsonObject({ file: "/nonexistent/payload.json" }), {
    name: "UsageError",
    message: /^Cannot read --file \/nonexistent\/payload\.json/
  })
})

test("requireJsonObject rejects a missing payload with the given message", async () => {
  await assert.rejects(requireJsonObject({}), {
    name: "UsageError",
    message: "Provide --file <path> or --stdin"
  })
  await assert.rejects(requireJsonObject({}, "Provide --data"), {
    name: "UsageError",
    message: "Provide --data"
  })
})
