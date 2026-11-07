import { test } from "node:test"
import assert from "node:assert/strict"
import { spawn } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { createServer } from "node:http"
import type { AddressInfo } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { assertFlagsOrPayload } from "../dist/src/commands/vault.js"
import { decrypt, encrypt } from "../dist/src/core/crypto.js"

test("assertFlagsOrPayload allows flags alone and a payload alone", () => {
  assert.doesNotThrow(() => assertFlagsOrPayload({ userId: "u", domain: "d" }))
  assert.doesNotThrow(() => assertFlagsOrPayload({ file: "entry.json" }))
  assert.doesNotThrow(() => assertFlagsOrPayload({ stdin: true }))
})

test("assertFlagsOrPayload rejects field flags combined with --file or --stdin", () => {
  assert.throws(
    () => assertFlagsOrPayload({ file: "entry.json", domain: "new.example.com" }),
    { name: "UsageError", message: /not both \(got --domain\)/ }
  )
  assert.throws(
    () => assertFlagsOrPayload({ stdin: true, passwordStdin: true, proxyEnable: true }),
    { name: "UsageError", message: /\(got --password-stdin, --proxy-enable\)/ }
  )
})

const KEY = "11".repeat(32)

type Recorded = { method?: string; url?: string; body: unknown }

async function startVaultBackend(response: unknown = {}) {
  const requests: Recorded[] = []
  const server = createServer((req, res) => {
    let raw = ""
    req.on("data", (chunk) => (raw += chunk))
    req.on("end", () => {
      requests.push({ method: req.method, url: req.url, body: raw ? JSON.parse(raw) : undefined })
      res.writeHead(200, { "content-type": "application/json" })
      res.end(JSON.stringify(response))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  const { port } = server.address() as AddressInfo
  return { baseUrl: `http://127.0.0.1:${port}`, requests, server }
}

function runCli(args: string[], stdin?: string, env: Record<string, string | undefined> = {}) {
  const home = mkdtempSync(join(tmpdir(), "cloudcruise-test-"))
  const child = spawn(process.execPath, ["dist/bin/cloudcruise.js", ...args], {
    env: {
      ...process.env,
      HOME: home,
      CLOUDCRUISE_API_KEY: "test_key",
      CLOUDCRUISE_ENCRYPTION_KEY: KEY,
      CLOUDCRUISE_SKILLS_AUTO_UPDATE: "0",
      ...env
    }
  })
  let stdout = ""
  let stderr = ""
  child.stdout.on("data", (chunk) => (stdout += chunk))
  child.stderr.on("data", (chunk) => (stderr += chunk))
  child.stdin.end(stdin ?? "")
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) =>
    child.on("close", (code) => resolve({ code, stdout, stderr }))
  )
}

async function withBackend<T>(
  response: unknown,
  fn: (backend: Awaited<ReturnType<typeof startVaultBackend>>) => Promise<T>
): Promise<T> {
  const backend = await startVaultBackend(response)
  try {
    return await fn(backend)
  } finally {
    backend.server.close()
  }
}

const ENTRY = ["--user-id", "u1", "--domain", "https://bank.example.com"]

// An entry can use several TFA methods; the API takes them as the tfa_methods list.
test("vault create with --tfa-method repeated sends every method as tfa_methods", async () => {
  await withBackend({}, async ({ baseUrl, requests }) => {
    const result = await runCli([
      "vault", "create", ...ENTRY,
      "--tfa-method", "AUTHENTICATOR", "--tfa-method", "EMAIL",
      "--base-url", baseUrl
    ])
    assert.equal(result.code, 0, result.stderr)
    assert.deepEqual((requests[0].body as Record<string, unknown>).tfa_methods, ["AUTHENTICATOR", "EMAIL"])
  })
})

// The API answers 400 to an unknown or repeated method; the CLI refuses it
// before sending anything, as a usage error (exit 2).
test("vault create refuses an unknown or repeated --tfa-method without calling the API", async () => {
  await withBackend({}, async ({ baseUrl, requests }) => {
    const unknown = await runCli(["vault", "create", ...ENTRY, "--tfa-method", "PIGEON", "--base-url", baseUrl])
    const repeated = await runCli([
      "vault", "create", ...ENTRY, "--tfa-method", "EMAIL", "--tfa-method", "EMAIL", "--base-url", baseUrl
    ])
    assert.equal(unknown.code, 2)
    assert.match(unknown.stderr, /PIGEON/)
    assert.equal(repeated.code, 2)
    assert.equal(requests.length, 0)
  })
})

const NO_KEY = { CLOUDCRUISE_ENCRYPTION_KEY: undefined }

// The method check is a flag check: it must win over stdin and key problems,
// so a typo is reported as such and stdin is not consumed first.
test("vault create reports an invalid --tfa-method before reading stdin or requiring the encryption key", async () => {
  await withBackend({}, async ({ baseUrl, requests }) => {
    const result = await runCli(
      ["vault", "create", ...ENTRY, "--tfa-method", "PIGEON", "--password-stdin", "--base-url", baseUrl],
      "s3cret",
      NO_KEY
    )
    assert.equal(result.code, 2)
    assert.match(result.stderr, /PIGEON/)
    assert.equal(requests.length, 0)
  })
})

function writeJson(value: unknown): string {
  const file = join(mkdtempSync(join(tmpdir(), "cloudcruise-vault-")), "input.json")
  writeFileSync(file, JSON.stringify(value))
  return file
}

function decryptJson(ciphertext: unknown): unknown {
  return JSON.parse(decrypt(ciphertext as string, KEY))
}

const ADDRESS = { street: "1 Main St", city: "Springfield", state: "IL", zip: "62701", country: "US" }

// Additional field values are secrets like the password: the API only accepts
// them encrypted with the workspace key, as JSON (an Address as its object).
test("vault create with --additional-fields-file sends each value encrypted, names and types as given", async () => {
  await withBackend({}, async ({ baseUrl, requests }) => {
    const file = writeJson([
      { name: "Member ID", type: "Text", value: "M-123" },
      { name: "Home", type: "Address", value: ADDRESS },
      { name: "Backup OTP", type: "Totp", value: "JBSWY3DPEHPK3PXPJBSWY3DP" }
    ])
    const result = await runCli(["vault", "create", ...ENTRY, "--additional-fields-file", file, "--base-url", baseUrl])
    assert.equal(result.code, 0, result.stderr)
    const sent = (requests[0].body as { additional_fields: { name: string; type: string; value: string }[] })
      .additional_fields
    assert.deepEqual(
      sent.map((f) => ({ name: f.name, type: f.type, value: decryptJson(f.value) })),
      [
        { name: "Member ID", type: "Text", value: "M-123" },
        { name: "Home", type: "Address", value: ADDRESS },
        { name: "Backup OTP", type: "Totp", value: "JBSWY3DPEHPK3PXPJBSWY3DP" }
      ]
    )
  })
})

// Questions and answers are both stored encrypted; the API rejects plaintext.
test("vault create with --security-questions-stdin sends question and answer encrypted, in order", async () => {
  await withBackend({}, async ({ baseUrl, requests }) => {
    const questions = [
      { question: "What is your mother's maiden name?", answer: "Smith" },
      { question: "First pet?", answer: "Rex" }
    ]
    const result = await runCli(
      ["vault", "create", ...ENTRY, "--security-questions-stdin", "--base-url", baseUrl],
      JSON.stringify(questions)
    )
    assert.equal(result.code, 0, result.stderr)
    const sent = (requests[0].body as { security_questions: { question: string; answer: string }[] })
      .security_questions
    assert.deepEqual(
      sent.map((q) => ({ question: decryptJson(q.question), answer: decryptJson(q.answer) })),
      questions
    )
  })
})

// An empty list is how a user clears all fields on update (PUT replaces the list).
test("vault update with an empty additional fields list sends [] to clear the stored fields", async () => {
  await withBackend({}, async ({ baseUrl, requests }) => {
    const result = await runCli([
      "vault", "update", ...ENTRY, "--additional-fields-file", writeJson([]), "--base-url", baseUrl
    ])
    assert.equal(result.code, 0, result.stderr)
    assert.equal(requests[0].method, "PUT")
    assert.deepEqual((requests[0].body as Record<string, unknown>).additional_fields, [])
  })
})

// An empty list holds nothing to encrypt, so clearing works with an API key alone.
test("vault update clears both lists with [] without an encryption key", async () => {
  await withBackend({}, async ({ baseUrl, requests }) => {
    const result = await runCli(
      [
        "vault", "update", ...ENTRY,
        "--additional-fields-file", writeJson([]),
        "--security-questions-stdin",
        "--base-url", baseUrl
      ],
      "[]",
      NO_KEY
    )
    assert.equal(result.code, 0, result.stderr)
    const body = requests[0].body as Record<string, unknown>
    assert.deepEqual(body.additional_fields, [])
    assert.deepEqual(body.security_questions, [])
  })
})

// Malformed lists are usage errors (exit 2) caught before any request, so a
// typo never reaches the API half-encrypted.
test("vault create refuses malformed list input without calling the API", async () => {
  await withBackend({}, async ({ baseUrl, requests }) => {
    const badType = await runCli([
      "vault", "create", ...ENTRY,
      "--additional-fields-file", writeJson([{ name: "X", type: "Number", value: "1" }]),
      "--base-url", baseUrl
    ])
    const addressAsString = await runCli([
      "vault", "create", ...ENTRY,
      "--additional-fields-file", writeJson([{ name: "Home", type: "Address", value: "1 Main St" }]),
      "--base-url", baseUrl
    ])
    const notArray = await runCli(
      ["vault", "create", ...ENTRY, "--security-questions-stdin", "--base-url", baseUrl],
      JSON.stringify({ question: "Q", answer: "A" })
    )
    const missingAnswer = await runCli(
      ["vault", "create", ...ENTRY, "--security-questions-stdin", "--base-url", baseUrl],
      JSON.stringify([{ question: "Q" }])
    )
    for (const result of [badType, addressAsString, notArray, missingAnswer]) {
      assert.equal(result.code, 2, result.stderr)
    }
    assert.match(badType.stderr, /item 1 \(X\): type must be one of/)
    assert.match(addressAsString.stderr, /value must be an object/)
    assert.match(notArray.stderr, /must contain a JSON array/)
    assert.equal(requests.length, 0)
  })
})

// stdin can be read only once, and --file/--stdin payloads are taken as-is.
test("vault create refuses two stdin flags, and list flags combined with a JSON payload", async () => {
  await withBackend({}, async ({ baseUrl, requests }) => {
    const twoStdin = await runCli([
      "vault", "create", ...ENTRY, "--additional-fields-stdin", "--security-questions-stdin", "--base-url", baseUrl
    ])
    assert.equal(twoStdin.code, 2)
    assert.match(twoStdin.stderr, /Only one flag can read stdin/)
    assert.throws(
      () => assertFlagsOrPayload({ file: "entry.json", securityQuestionsFile: "q.json" }),
      { name: "UsageError", message: /\(got --security-questions-file\)/ }
    )
    assert.equal(requests.length, 0)
  })
})

function storedEntry() {
  const enc = (value: unknown) => encrypt(JSON.stringify(value), KEY)
  return {
    id: "e1",
    permissioned_user_id: "u1",
    domain: "https://bank.example.com",
    password: enc("s3cret"),
    tfa_methods: ["AUTHENTICATOR", "EMAIL"],
    additional_fields: [
      { name: "Member ID", type: "Text", value: enc("M-123") },
      { name: "Home", type: "Address", value: enc(ADDRESS) }
    ],
    security_questions: [{ question: enc("First pet?"), answer: enc("Rex") }]
  }
}

// Without --decrypt the user asked for the entry's shape, not its secrets:
// field names and types are shown, field values and answers are left out.
test("vault get lists additional field names and types and leaves out values and answers", async () => {
  const entry = storedEntry()
  await withBackend(entry, async ({ baseUrl }) => {
    const result = await runCli(["vault", "get", ...ENTRY, "--base-url", baseUrl])
    assert.equal(result.code, 0, result.stderr)
    const out = JSON.parse(result.stdout)
    assert.deepEqual(out.additional_fields, [
      { name: "Member ID", type: "Text" },
      { name: "Home", type: "Address" }
    ])
    assert.deepEqual(out.security_questions, [{ question: entry.security_questions[0].question }])
    assert.deepEqual(out.tfa_methods, ["AUTHENTICATOR", "EMAIL"])
  })
})

// vault list --full must not show more than vault get does.
test("vault list --full leaves out additional field values and answers like vault get", async () => {
  const entry = storedEntry()
  await withBackend([entry], async ({ baseUrl }) => {
    const result = await runCli(["vault", "list", "--full", "--base-url", baseUrl])
    assert.equal(result.code, 0, result.stderr)
    const [out] = JSON.parse(result.stdout)
    assert.deepEqual(out.additional_fields, [
      { name: "Member ID", type: "Text" },
      { name: "Home", type: "Address" }
    ])
    assert.deepEqual(out.security_questions, [{ question: entry.security_questions[0].question }])
  })
})

// --decrypt is the request for values: every field value, question and answer
// comes back as plaintext, an Address as its object.
test("vault get --decrypt shows additional field values, questions and answers in plaintext", async () => {
  await withBackend(storedEntry(), async ({ baseUrl }) => {
    const result = await runCli(["vault", "get", ...ENTRY, "--decrypt", "--base-url", baseUrl])
    assert.equal(result.code, 0, result.stderr)
    const out = JSON.parse(result.stdout)
    assert.equal(out.password, "s3cret")
    assert.deepEqual(out.additional_fields, [
      { name: "Member ID", type: "Text", value: "M-123" },
      { name: "Home", type: "Address", value: ADDRESS }
    ])
    assert.deepEqual(out.security_questions, [{ question: "First pet?", answer: "Rex" }])
  })
})

// An entry with several TFA methods needs --method; --field picks a Totp
// additional field. Both go to GET /vault/tfa-code as query parameters, and
// the code comes back unchanged.
test("vault tfa-code sends --method and --field as query parameters and prints the code", async () => {
  const code = { type: "authenticator", code: "123456", expires_in_seconds: 21 }
  await withBackend(code, async ({ baseUrl, requests }) => {
    const byMethod = await runCli(["vault", "tfa-code", ...ENTRY, "--method", "AUTHENTICATOR", "--base-url", baseUrl])
    const byField = await runCli(["vault", "tfa-code", ...ENTRY, "--field", "Backup OTP", "--base-url", baseUrl])
    const plain = await runCli(["vault", "tfa-code", ...ENTRY, "--base-url", baseUrl])
    for (const result of [byMethod, byField, plain]) {
      assert.equal(result.code, 0, result.stderr)
      assert.deepEqual(JSON.parse(result.stdout), code)
    }
    const queries = requests.map((r) => {
      const url = new URL(r.url ?? "", "http://x")
      assert.equal(r.method, "GET")
      assert.equal(url.pathname, "/vault/tfa-code")
      return Object.fromEntries(url.searchParams)
    })
    const base = { permissioned_user_id: "u1", domain: "https://bank.example.com" }
    assert.deepEqual(queries, [
      { ...base, method: "AUTHENTICATOR" },
      { ...base, field: "Backup OTP" },
      base
    ])
  })
})

// Methods are case-sensitive in the API; a typo is a usage error (exit 2), not a round trip.
test("vault tfa-code refuses an unknown --method without calling the API", async () => {
  await withBackend({}, async ({ baseUrl, requests }) => {
    const result = await runCli(["vault", "tfa-code", ...ENTRY, "--method", "Email", "--base-url", baseUrl])
    assert.equal(result.code, 2)
    assert.match(result.stderr, /Invalid --method value \\"Email\\"/)
    assert.equal(requests.length, 0)
  })
})
