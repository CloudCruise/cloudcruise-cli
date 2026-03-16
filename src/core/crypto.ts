import { createCipheriv, createDecipheriv, randomBytes } from "crypto"

const ALGO = "aes-256-gcm"
const IV_BYTES = 12
const TAG_BYTES = 16
const HEX_TAG_LEN = TAG_BYTES * 2
const HEX_IV_LEN = IV_BYTES * 2

export function encrypt(plaintext: string, hexKey: string): string {
  const key = Buffer.from(hexKey, "hex")
  const iv = randomBytes(IV_BYTES)
  const cipher = createCipheriv(ALGO, key, iv)
  const encrypted = cipher.update(plaintext, "utf8", "hex") + cipher.final("hex")
  const tag = cipher.getAuthTag().toString("hex")
  return iv.toString("hex") + encrypted + tag
}

export function decrypt(ciphertext: string, hexKey: string): string {
  const key = Buffer.from(hexKey, "hex")
  const iv = Buffer.from(ciphertext.slice(0, HEX_IV_LEN), "hex")
  const tag = Buffer.from(ciphertext.slice(-HEX_TAG_LEN), "hex")
  const encrypted = ciphertext.slice(HEX_IV_LEN, -HEX_TAG_LEN)
  const decipher = createDecipheriv(ALGO, key, iv)
  decipher.setAuthTag(tag)
  return decipher.update(encrypted, "hex", "utf8") + decipher.final("utf8")
}

export function validateHexKey(hexKey: string): void {
  if (!/^[0-9a-fA-F]{64}$/.test(hexKey)) {
    throw new Error(
      "Invalid encryption key. Expected 64 hex characters (256-bit AES key)."
    )
  }
}
