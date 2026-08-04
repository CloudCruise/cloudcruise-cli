#!/usr/bin/env node
// Generate input_schema-valid test payloads for a CloudCruise workflow.
//
// Approach: naive fill, then a repair loop that patches AJV validation errors
// until the payload is valid. All reveal/coherence knowledge lives in the
// schema's own rules (hidden $refs, converse gates, contains implications);
// the repair loop enforces them mechanically. There is no reliable one-shot
// generator for JSON Schema with conditionals — generate-then-repair is the
// standard workaround.
//
// AJV options MUST mirror the backend's validator
// (backend/src/utils/variables/variable-validation.ts) so "valid here" means
// "accepted at run start".
//
// Usage:
//   node gen-payloads.mjs --schema workflow.json --config cfg.json --out dir [--seed 1] [--modes null,partial,full]
//   node gen-payloads.mjs --workflow <id> --profile prod --workspace-id <ws> --config cfg.json --out dir
//
// Config file:
// {
//   "envelope": { "<field>": <value>, ... },      // task-selection fields, set as-is in every payload
//   "vault":    { "<alias>": "<permissioned_user_id>" },  // vault aliases (backend injects these into the schema)
//   "scenarios": [ { "name": "x", "base": "null", "set": { "a.b.c": <value> } } ]
// }

import fs from "fs";
import path from "path";
import { execSync } from "child_process";
import { createRequire } from "module";
import { fileURLToPath } from "url";

// ajv is VENDORED (ajv.bundle.mjs, pinned 8.20.0) so the validator version matches
// the backend exactly and the script runs zero-install from any directory. To
// refresh after a backend ajv bump:
//   npm i ajv@<version> && echo 'export { default } from "ajv";' > entry.mjs \
//   && npx esbuild entry.mjs --bundle --format=esm --platform=node --outfile=ajv.bundle.mjs
// Upgrade path: when this generator is battle-tested and proves useful, fold it into
// the CLI proper as `cloudcruise payloads generate` — deps become the CLI package's
// problem and the skill doc shrinks to one command. Fallback resolution below exists
// only in case the bundle is missing from a partial skill copy.
let Ajv;
try {
  Ajv = (await import(new URL("./ajv.bundle.mjs", import.meta.url))).default;
} catch {
  try {
    const req = createRequire(path.join(process.cwd(), "package.json"));
    Ajv = req("ajv").default ?? req("ajv");
  } catch {
    console.error("ajv.bundle.mjs missing and ajv not resolvable — run `npm i -D ajv@^8` or restore the bundle");
    process.exit(2);
  }
}

// ---------- args ----------
const args = {};
for (let i = 2; i < process.argv.length; i++) {
  const a = process.argv[i];
  if (a.startsWith("--")) args[a.slice(2)] = process.argv[i + 1]?.startsWith("--") ? true : process.argv[++i];
}
const SEED = Number(args.seed ?? 1);
const MODES = (args.modes ?? "null,partial,full").split(",");
const PARTIAL_P = Number(args["partial-p"] ?? 0.5);
let OUT = args.out;
const cfg = args.config ? JSON.parse(fs.readFileSync(args.config, "utf8")) : {};

let workflowJson;
if (args.schema) workflowJson = JSON.parse(fs.readFileSync(args.schema, "utf8"));
else if (args.workflow) {
  const extra = (args.profile ? ` --profile ${args.profile}` : "") +
                (args["workspace-id"] ? ` --workspace-id ${args["workspace-id"]}` : "");
  workflowJson = JSON.parse(execSync(`cloudcruise workflows get ${args.workflow}${extra}`, { maxBuffer: 64e6 }).toString());
} else {
  console.error("need --schema <file> or --workflow <id>"); process.exit(2);
}
const schema = workflowJson.input_schema ?? workflowJson;
if (!OUT) {
  const slug = (workflowJson.name ?? path.basename(args.schema ?? "workflow", ".json"))
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  OUT = path.join("cc-workflows", slug, "payloads");
}

// ---------- seeded PRNG (mulberry32) ----------
function prng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- schema helpers ----------
const isObj = (n) => n && typeof n === "object" && "properties" in n;
const isArr = (n) => n && typeof n === "object" && (n.type === "array" || "items" in n);
// refusal/absence options are excluded from the default sampling pool: they often
// carry UI exclusivity semantics the schema doesn't encode. "Other:" is sampled —
// its reveal chain gets auto-filled by the repair loop.
const NEGATIVE = /^(no |none|not |n\/a|unknown|z1\.|\[-\]|refus|declin)/i;

function schemaAt(segs) {
  let cur = schema;
  for (const seg of segs) {
    if (isObj(cur)) cur = cur.properties[seg];
    else if (isArr(cur)) cur = cur.items;
    if (!cur) return null;
  }
  return cur;
}
function hiddenSkeleton(node) {
  if (isObj(node)) {
    const o = {};
    for (const [k, v] of Object.entries(node.properties)) o[k] = hiddenSkeleton(v);
    return o;
  }
  if (isArr(node)) return [];
  return null;
}

// ---------- fill ----------
function makeFiller(rand) {
  function pool(vals) {
    const pos = vals.filter((v) => typeof v !== "string" || !NEGATIVE.test(v));
    return pos.length ? pos : vals;
  }
  function pick(vals) { return vals[Math.floor(rand() * vals.length)]; }
  function leafValue(node) {
    if (node.enum) {
      const vals = pool(node.enum.filter((v) => v !== null));
      return vals.length ? pick(vals) : null;
    }
    if (node.example !== undefined && node.example !== null) return node.example;
    const base = Array.isArray(node.type) ? node.type.find((t) => t !== "null") : node.type;
    if (base === "boolean") return true;
    if (base === "number" || base === "integer") return 1;
    if (node.pattern) return null; // no example to conform with; repair may revisit
    return "CC test";
  }
  function fill(node, mode) {
    if (isObj(node)) {
      const o = {};
      for (const [k, v] of Object.entries(node.properties)) {
        if (isObj(v)) o[k] = fill(v, mode);
        else {
          let m = mode;
          if (mode === "partial") m = rand() < PARTIAL_P ? "full" : "null";
          o[k] = fill(v, m);
        }
      }
      return o;
    }
    if (isArr(node)) {
      if (mode === "null") return [];
      const it = node.items ?? {};
      if (isObj(it)) {
        const n = mode === "full" ? 2 : 1;
        const items = Array.from({ length: n }, () => fill(it, "full"));
        const seen = new Set(); // identical rows would toggle checkbox-style rows back off
        return items.filter((x) => { const s = JSON.stringify(x); if (seen.has(s)) return false; seen.add(s); return true; });
      }
      const vals = pool((it.enum ?? []).filter((v) => v !== null));
      if (!vals.length) return [it.example ?? "CC test"];
      const k = mode === "full" ? 1 + Math.floor(rand() * Math.min(3, vals.length)) : 1;
      const shuffled = [...vals].sort(() => rand() - 0.5);
      return [...new Set(shuffled.slice(0, k))];
    }
    return mode === "null" ? null : leafValue(node);
  }
  return { fill, leafValue };
}

// ---------- AJV (backend parity: variable-validation.ts) ----------
const BACKEND_OPTS = { strict: true, validateFormats: false, addUsedSchema: false, removeAdditional: false, strictSchema: false, keywords: ["example"] };
const fullSchema = JSON.parse(JSON.stringify(schema));
for (const alias of Object.keys(cfg.vault ?? {})) {
  fullSchema.properties[alias] = { oneOf: [{ type: "string" }, { type: "array", items: { type: "string" } }] };
  fullSchema.required = [...(fullSchema.required ?? []), alias];
}
const validateAll = new Ajv({ ...BACKEND_OPTS, allErrors: true }).compile(fullSchema);
const validateBackend = new Ajv(BACKEND_OPTS).compile(fullSchema);

// ---------- repair ----------
const parsePath = (p) => p.split("/").slice(1).map((s) => s.replace(/~1/g, "/").replace(/~0/g, "~"));
function resolveSchemaPath(sp) {
  let cur = schema;
  for (const seg of sp.split("/").slice(1))
    cur = cur?.[/^\d+$/.test(seg) ? Number(seg) : seg.replace(/~1/g, "/").replace(/~0/g, "~")];
  return cur;
}
function getAt(obj, segs) { return segs.reduce((c, s) => (c == null ? c : c[s]), obj); }
function setAt(obj, segs, val) {
  let c = obj;
  const walked = [];
  for (const s of segs.slice(0, -1)) {
    walked.push(s);
    if (c[s] == null) {
      const bs = schemaAt(walked.filter((x) => !/^\d+$/.test(x)));
      c[s] = bs ? hiddenSkeleton(bs) : {};
    }
    c = c[s];
  }
  c[segs.at(-1)] = val;
}

function repair(payload, leafValue) {
  for (let round = 0; round < 120; round++) {
    if (validateAll(payload)) return round;
    const errs = validateAll.errors;
    const patched = new Set();
    const hiddenPrefixes = [];
    for (const e of errs) { // pass 1: hidden pins -> hidden skeleton
      const isHidden = e.schemaPath.includes("definitions/hidden") ||
        resolveSchemaPath(e.schemaPath.replace(/\/[^/]+$/, ""))?.$ref === "#/definitions/hidden";
      if (!isHidden || e.keyword !== "anyOf") continue;
      const segs = parsePath(e.instancePath);
      const key = segs.join("/");
      if (patched.has(key)) continue;
      patched.add(key); hiddenPrefixes.push(key);
      setAt(payload, segs, hiddenSkeleton(schemaAt(segs.filter((s) => !/^\d+$/.test(s))) ?? {}));
    }
    for (const e of errs) { // pass 2: everything else
      const segs = parsePath(e.instancePath);
      const key = segs.join("/");
      if (patched.has(key) || hiddenPrefixes.some((h) => key.startsWith(h))) continue;
      if (e.schemaPath.includes("definitions/hidden")) continue;
      const base = schemaAt(segs.filter((s) => !/^\d+$/.test(s)));
      if (e.keyword === "contains") {
        const need = resolveSchemaPath(e.schemaPath.replace(/\/contains$/, ""))?.contains?.const;
        const arr = getAt(payload, segs);
        if (need !== undefined && Array.isArray(arr) && !arr.includes(need)) { arr.unshift(need); patched.add(key); }
      } else if (e.keyword === "not") {
        const notSub = resolveSchemaPath(e.schemaPath);
        if (notSub?.contains) {
          const arr = getAt(payload, segs);
          if (Array.isArray(arr)) setAt(payload, segs, arr.filter((v) => v !== notSub.contains.const));
        } else if (notSub?.enum) {
          const ex = new Set(notSub.enum);
          const baseType = Array.isArray(base?.type) ? base.type.find((t) => t !== "null") : base?.type;
          let v;
          if (base?.enum) v = base.enum.find((x) => x !== null && !ex.has(x));
          else if (baseType === "boolean") v = [false, true].find((x) => !ex.has(x));
          else v = "CC test";
          setAt(payload, segs, v ?? null);
        }
        patched.add(key);
      } else if (e.keyword === "const") {
        // per-element const sub-errors of a failing `contains` belong to the array-level handler
        if (e.schemaPath.includes("/contains/")) continue;
        setAt(payload, segs, e.params.allowedValue); patched.add(key);
      } else if (e.keyword === "enum") {
        setAt(payload, segs, e.params.allowedValues.find((v) => v !== null) ?? null); patched.add(key);
      } else if (e.keyword === "type") {
        const want = e.params.type;
        if (want === "string" || (Array.isArray(want) && want.includes("string"))) {
          let v = base ? leafValue(base) : "CC test";
          setAt(payload, segs, v ?? "CC test");
        } else if (want === "array") setAt(payload, segs, []);
        else if (want === "object") setAt(payload, segs, hiddenSkeleton(base ?? {}));
        else if (want === "boolean") setAt(payload, segs, true);
        else setAt(payload, segs, null);
        patched.add(key);
      } else if (e.keyword === "maxItems") {
        setAt(payload, segs, []); patched.add(key);
      } else if (e.keyword === "required") {
        const missing = e.params.missingProperty;
        const tgt = getAt(payload, segs) ?? {};
        const bs = schemaAt([...segs.filter((s) => !/^\d+$/.test(s)), missing]);
        tgt[missing] = bs && isArr(bs) ? [] : bs && isObj(bs) ? hiddenSkeleton(bs) : null;
        patched.add(key + "+" + missing);
      }
    }
    if (!patched.size) {
      console.error("repair stalled; sample errors:", JSON.stringify(errs.slice(0, 3), null, 1));
      return -1;
    }
  }
  return -2;
}

// ---------- build ----------
function applyEnvelope(p) {
  for (const [k, v] of Object.entries(cfg.envelope ?? {})) p[k] = v;
  for (const [k, v] of Object.entries(cfg.vault ?? {})) p[k] = v;
}
function setDotted(obj, dotted, val) {
  const segs = dotted.split(".");
  setAt(obj, segs, val);
}

fs.mkdirSync(OUT, { recursive: true });
const manifest = { seed: SEED, generated_at_note: "regenerate after any input_schema change", payloads: {} };
const filler = makeFiller(prng(SEED));
const built = {};

for (const mode of MODES) {
  const p = filler.fill(schema, mode);
  applyEnvelope(p);
  const rounds = repair(p, filler.leafValue);
  applyEnvelope(p); // repair never touches envelope keys, but keep them authoritative
  const ok = validateBackend(p);
  built[mode] = p;
  const file = `payload-${mode}.json`;
  fs.writeFileSync(path.join(OUT, file), JSON.stringify(p, null, 2));
  manifest.payloads[file] = { mode, repairRounds: rounds, backendValid: ok };
  if (!ok) { console.error(`${mode}: INVALID`, JSON.stringify(validateBackend.errors?.slice(0, 3))); process.exitCode = 1; }
  console.log(`${file}  repairRounds=${rounds}  backendValid=${ok}`);
}

for (const sc of cfg.scenarios ?? []) {
  const base = JSON.parse(JSON.stringify(built[sc.base ?? "null"] ?? filler.fill(schema, sc.base ?? "null")));
  for (const [dotted, val] of Object.entries(sc.set ?? {})) setDotted(base, dotted, val);
  const rounds = repair(base, filler.leafValue); // scenario edits get coherence fixes too
  applyEnvelope(base);
  const ok = validateBackend(base);
  const file = `payload-${sc.name}.json`;
  fs.writeFileSync(path.join(OUT, file), JSON.stringify(base, null, 2));
  manifest.payloads[file] = { scenario: sc.name, base: sc.base ?? "null", repairRounds: rounds, backendValid: ok };
  if (!ok) { console.error(`${sc.name}: INVALID`, JSON.stringify(validateBackend.errors?.slice(0, 3))); process.exitCode = 1; }
  console.log(`${file}  repairRounds=${rounds}  backendValid=${ok}`);
}

fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
