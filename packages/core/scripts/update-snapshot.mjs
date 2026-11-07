// Usage: npm run spec:snapshot -w @cloudcruise/strata -- https://api.cloudcruise.com
// Writes the operations exposed on any surface, and the components they use, to
// src/openapi.snapshot.json. Run it when bumping a release.
import { writeFileSync } from "node:fs"

const METHODS = ["get", "put", "post", "delete", "patch"]
const baseUrl = process.argv[2]
if (!baseUrl || !/^https?:\/\/[^/]+$/.test(baseUrl)) {
  console.error("usage: update-snapshot.mjs <base URL, e.g. https://api.cloudcruise.com>")
  process.exit(1)
}

const res = await fetch(`${baseUrl}/openapi.json`)
if (!res.ok) {
  console.error(`GET ${baseUrl}/openapi.json failed (${res.status})`)
  process.exit(1)
}
const spec = await res.json()

const paths = {}
for (const [path, item] of Object.entries(spec.paths ?? {})) {
  const kept = {}
  for (const method of METHODS) {
    const surfaces = item[method]?.["x-strata-surfaces"]
    if (Array.isArray(surfaces) && surfaces.length > 0) kept[method] = item[method]
  }
  if (Object.keys(kept).length) {
    if (item.parameters) kept.parameters = item.parameters
    paths[path] = kept
  }
}

// Keep each component the kept operations reach, following refs transitively.
const components = {}
const seen = new Set()
function visit(node) {
  if (Array.isArray(node)) return node.forEach(visit)
  if (!node || typeof node !== "object") return
  if (typeof node.$ref === "string" && node.$ref.startsWith("#/components/") && !seen.has(node.$ref)) {
    seen.add(node.$ref)
    const [, , kind, name] = node.$ref.split("/")
    const target = spec.components?.[kind]?.[name]
    if (target) {
      ;(components[kind] ??= {})[name] = target
      visit(target)
    }
  }
  Object.values(node).forEach(visit)
}
visit(paths)

const out = { openapi: spec.openapi, info: spec.info, paths, components }
const file = new URL("../src/openapi.snapshot.json", import.meta.url)
writeFileSync(file, JSON.stringify(out, null, 2) + "\n")
console.log(`wrote ${Object.keys(paths).length} paths to src/openapi.snapshot.json`)
