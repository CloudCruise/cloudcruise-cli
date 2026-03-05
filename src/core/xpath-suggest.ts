import { parseHTML } from "linkedom"
import fontoxpath from "fontoxpath"

const DOCTYPE_REGEX = /<!DOCTYPE[^>]*>/gi
const STYLE_REGEX = /<style[^>]*>[\s\S]*?<\/style>/gi
const LINK_STYLESHEET_REGEX = /<link[^>]*\/?>/gi
const SCRIPT_REGEX = /<script[^>]*>[\s\S]*?<\/script>/gi
const NOSCRIPT_REGEX = /<noscript[^>]*>[\s\S]*?<\/noscript>/gi

const GENERATED_ID_PATTERNS = [
  /^[0-9a-f]{8}-[0-9a-f]{4}-/,
  /^:[a-zA-Z0-9]+:$/,
  /^[a-zA-Z]+_[a-zA-Z0-9]{8,}$/
]

const DATA_SELECTOR_ATTRS = [
  "data-qa",
  "data-testid",
  "data-test",
  "data-cy",
  "data-test-id"
]

const INTERACTIVE_TAGS = ["input", "button", "select", "textarea", "a"]

const SKIP_ATTR_KEYS = new Set([
  "class",
  "style",
  "tabindex",
  "maxlength",
  "autocomplete",
  "dir",
  "translate",
  "lang",
  "aria-describedby",
  "aria-required",
  "aria-expanded",
  "aria-haspopup",
  "aria-controls",
  "aria-owns"
])

export interface ElementSuggestion {
  index: number
  tag: string
  suggested_xpath: string
  unique: boolean
  match_count: number
  alternatives: XPathCandidate[]
  attributes: Record<string, string>
  text: string
}

interface XPathCandidate {
  xpath: string
  match_count: number
  unique: boolean
}

function stripStylesAndScripts(html: string): string {
  return html
    .replace(DOCTYPE_REGEX, "")
    .replace(STYLE_REGEX, "")
    .replace(LINK_STYLESHEET_REGEX, "")
    .replace(SCRIPT_REGEX, "")
    .replace(NOSCRIPT_REGEX, "")
}

function htmlNamespaceResolver(prefix: string | null): string | null {
  if (prefix === "" || prefix === null) {
    return "http://www.w3.org/1999/xhtml"
  }
  return null
}

const FONTOXPATH_OPTIONS = {
  language: fontoxpath.evaluateXPath.XPATH_3_1_LANGUAGE,
  namespaceResolver: htmlNamespaceResolver
}

export function parseSnapshot(html: string): Document {
  const cleaned = stripStylesAndScripts(html)
  const { document } = parseHTML(cleaned)
  return document as unknown as Document
}

export function evalXPath(xpath: string, doc: Document): Node[] {
  return fontoxpath.evaluateXPath(
    xpath,
    doc,
    null,
    null,
    fontoxpath.evaluateXPath.ALL_RESULTS_TYPE,
    FONTOXPATH_OPTIONS
  ) as Node[]
}

function isGeneratedId(id: string): boolean {
  return GENERATED_ID_PATTERNS.some((p) => p.test(id))
}

function escapeXPathString(value: string): string {
  if (!value.includes("'")) return `'${value}'`
  if (!value.includes('"')) return `"${value}"`
  return `concat('${value.replace(/'/g, "',\"'\",'")}')`
}

export function getVisibleText(el: Element): string {
  const text = (el.textContent ?? "").trim()
  return text.length > 100 ? text.substring(0, 100) : text
}

export function getMeaningfulAttributes(el: Element): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (let i = 0; i < el.attributes.length; i++) {
    const attr = el.attributes[i]
    if (SKIP_ATTR_KEYS.has(attr.name)) continue
    if (attr.name === "class" || attr.name === "style") continue
    if (attr.name === "id" && isGeneratedId(attr.value)) continue
    attrs[attr.name] = attr.value
  }
  return attrs
}

function generateCandidateXPaths(el: Element): string[] {
  const tag = el.localName
  const candidates: string[] = []

  const name = el.getAttribute("name")
  if (name) {
    candidates.push(`//${tag}[@name=${escapeXPathString(name)}]`)
  }

  const id = el.getAttribute("id")
  if (id && !isGeneratedId(id)) {
    candidates.push(`//${tag}[@id=${escapeXPathString(id)}]`)
  }

  for (const attr of DATA_SELECTOR_ATTRS) {
    const val = el.getAttribute(attr)
    if (val) {
      candidates.push(`//${tag}[@${attr}=${escapeXPathString(val)}]`)
    }
  }

  const ariaLabel = el.getAttribute("aria-label")
  if (ariaLabel) {
    candidates.push(
      `//${tag}[@aria-label=${escapeXPathString(ariaLabel)}]`
    )
  }

  const placeholder = el.getAttribute("placeholder")
  if (placeholder) {
    candidates.push(
      `//${tag}[@placeholder=${escapeXPathString(placeholder)}]`
    )
  }

  const type = el.getAttribute("type")
  if (type && type !== "text" && type !== "submit" && type !== "hidden") {
    candidates.push(`//${tag}[@type=${escapeXPathString(type)}]`)
  }

  const text = getVisibleText(el)
  if (text && text.length <= 80) {
    candidates.push(
      `//${tag}[normalize-space()=${escapeXPathString(text)}]`
    )
  }

  const role = el.getAttribute("role")
  if (role && text && text.length <= 80) {
    candidates.push(
      `//*[@role=${escapeXPathString(role)}][normalize-space()=${escapeXPathString(text)}]`
    )
  }

  if (tag === "a") {
    const href = el.getAttribute("href")
    if (
      href &&
      !href.startsWith("#") &&
      !href.startsWith("javascript:")
    ) {
      if (href.length <= 120) {
        candidates.push(`//a[@href=${escapeXPathString(href)}]`)
      } else {
        const short = href.substring(0, 60)
        candidates.push(`//a[starts-with(@href,${escapeXPathString(short)})]`)
      }
    }
  }

  return candidates
}

function evaluateCandidate(
  xpath: string,
  doc: Document
): XPathCandidate {
  const matches = evalXPath(xpath, doc)
  return {
    xpath,
    match_count: matches.length,
    unique: matches.length === 1
  }
}

export function suggestXPath(
  el: Element,
  doc: Document
): {
  suggested: string
  unique: boolean
  match_count: number
  alternatives: XPathCandidate[]
} {
  const candidates = generateCandidateXPaths(el)
  const evaluated: XPathCandidate[] = []

  let best: XPathCandidate | null = null

  for (const xpath of candidates) {
    let result: XPathCandidate
    try {
      result = evaluateCandidate(xpath, doc)
    } catch {
      continue
    }
    evaluated.push(result)

    if (!best) {
      best = result
    } else if (result.unique && !best.unique) {
      best = result
    } else if (
      !best.unique &&
      !result.unique &&
      result.match_count < best.match_count
    ) {
      best = result
    }
  }

  if (!best) {
    const tag = el.localName
    const fallback = `//${tag}`
    const fallbackResult = evaluateCandidate(fallback, doc)
    return {
      suggested: fallback,
      unique: fallbackResult.unique,
      match_count: fallbackResult.match_count,
      alternatives: []
    }
  }

  const alternatives = evaluated.filter((c) => c.xpath !== best!.xpath)

  return {
    suggested: best.xpath,
    unique: best.unique,
    match_count: best.match_count,
    alternatives
  }
}

export function findInteractiveElements(
  doc: Document,
  filter: string[]
): Element[] {
  const selector = filter.join(",")
  const all = doc.querySelectorAll(selector)
  const elements: Element[] = []

  for (let i = 0; i < all.length; i++) {
    const el = all[i] as Element
    if (el.getAttribute("type") === "hidden") continue
    if (el.getAttribute("aria-hidden") === "true") continue
    if (el.hasAttribute("hidden")) continue
    elements.push(el)
  }
  return elements
}

export function suggestAll(
  html: string,
  filter: string[] = INTERACTIVE_TAGS
): ElementSuggestion[] {
  const doc = parseSnapshot(html)
  const elements = findInteractiveElements(doc, filter)

  return elements.map((el, index) => {
    const result = suggestXPath(el, doc)
    return {
      index,
      tag: el.localName,
      suggested_xpath: result.suggested,
      unique: result.unique,
      match_count: result.match_count,
      alternatives: result.alternatives,
      attributes: getMeaningfulAttributes(el),
      text: getVisibleText(el)
    }
  })
}
