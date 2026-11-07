import type { Operation } from "./spec.js"

const K1 = 1.2
const B = 0.75
const NAME_WEIGHT = 3
const SUMMARY_WEIGHT = 2
const STOPWORDS = new Set([
  "a", "an", "and", "all", "any", "by", "for", "from", "i", "in", "is", "it",
  "me", "my", "of", "on", "or", "our", "show", "the", "this", "to", "with", "your"
])

/** Lower-cases, splits on anything but letters and digits, drops stopwords, and strips a plural `s`. */
export function tokenize(text: string): string[] {
  const tokens: string[] = []
  for (const word of text.toLowerCase().split(/[^a-z0-9]+/)) {
    if (!word || STOPWORDS.has(word)) continue
    tokens.push(word.length > 3 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word)
  }
  return tokens
}

interface Doc {
  operation: Operation
  counts: Map<string, number>
  length: number
}

/** BM25 over operation names, summaries and descriptions. */
export class SearchIndex {
  private readonly docs: Doc[]
  private readonly docFreq = new Map<string, number>()
  private readonly avgLength: number

  constructor(operations: Operation[]) {
    this.docs = operations.map((operation) => {
      const tokens = [
        ...repeat(tokenize(operation.name), NAME_WEIGHT),
        ...repeat(tokenize(operation.summary ?? ""), SUMMARY_WEIGHT),
        ...tokenize(operation.description ?? "")
      ]
      const counts = new Map<string, number>()
      for (const t of tokens) counts.set(t, (counts.get(t) ?? 0) + 1)
      for (const t of counts.keys()) this.docFreq.set(t, (this.docFreq.get(t) ?? 0) + 1)
      return { operation, counts, length: tokens.length }
    })
    this.avgLength = this.docs.reduce((sum, d) => sum + d.length, 0) / (this.docs.length || 1)
  }

  search(query: string, limit: number): Operation[] {
    const exact = this.docs.find((d) => d.operation.name === query.trim())
    const terms = [...new Set(tokenize(query))]
    const n = this.docs.length
    const scored: { operation: Operation; score: number }[] = []
    for (const doc of this.docs) {
      if (doc === exact) continue
      let score = 0
      for (const term of terms) {
        const tf = doc.counts.get(term)
        if (!tf) continue
        const df = this.docFreq.get(term) ?? 0
        const idf = Math.log(1 + (n - df + 0.5) / (df + 0.5))
        score += (idf * tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * doc.length) / this.avgLength))
      }
      if (score > 0) scored.push({ operation: doc.operation, score })
    }
    scored.sort((a, b) => b.score - a.score || a.operation.name.localeCompare(b.operation.name))
    const ranked = scored.map((s) => s.operation)
    return (exact ? [exact.operation, ...ranked] : ranked).slice(0, limit)
  }
}

function repeat<T>(items: T[], times: number): T[] {
  return Array.from({ length: times }, () => items).flat()
}
