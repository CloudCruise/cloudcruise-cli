import { ApiError } from "./api-client.js"

const SEVERAL_ENTRIES_HINT =
  "A 409 without --domain means the user ID has several vault entries, and the message lists their domains: pass --domain with one of them. (On tfa-code a 409 can also mean the method cannot be read.)"

/**
 * The API answers 409 and lists the domains when a user ID without a domain
 * has several entries; the hint says what to do about it.
 */
export function withDomainHint(err: unknown, domain: string | undefined): unknown {
  if (domain === undefined && err instanceof ApiError && err.status === 409 && !err.hint) {
    err.hint = SEVERAL_ENTRIES_HINT
  }
  return err
}
