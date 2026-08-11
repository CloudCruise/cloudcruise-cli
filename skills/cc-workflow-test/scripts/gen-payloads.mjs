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
// Modes:
//   null     every key present, leaves null, arrays empty
//   full     maximal coherent path; enum arrays get 1-3 values, object arrays 2 rows
//   partial  keep each leaf with probability --partial-p, then repair
//   sparse   every leaf filled but WIDTH-1: enum arrays get exactly one value, object
//            arrays one row. Pair with `--policy narrow` (see below) or the repair loop
//            widens the very lists you just narrowed.
//
// --policy widen|narrow  (default widen = historical behaviour)
//   A reveal is encoded as a PAIR of rules: forward (`if findings contains X then detail
//   is typed / else hidden`) and converse (`if detail is not hidden then findings contains
//   X`). A payload that fills a detail whose trigger was not sampled violates the converse
//   rule, and there are two ways to repair it: add the trigger to the driver list (widen)
//   or blank the detail (narrow). `widen` grows a 1-value list back to N and destroys the
//   point of `sparse`; `narrow` keeps the single selection and drops the unreachable
//   details, which is also what the live form does.
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
const POLICY = args.policy ?? "widen";
// Bias enum sampling toward values that some `if` keys off, so one selection opens a level
// below it. Default on for sparse (where the single draw decides whether a section's detail
// sub-tree opens at all), off elsewhere so existing payload classes are unchanged.
const PREFER_TRIGGERS = args["prefer-triggers"] !== undefined
  ? args["prefer-triggers"] !== "false"
  : (args.modes ?? "").split(",").includes("sparse");
const KNOWN_MODES = new Set(["null", "partial", "full", "sparse"]);
for (const m of MODES) if (!KNOWN_MODES.has(m)) { console.error(`unknown mode ${JSON.stringify(m)} (want: ${[...KNOWN_MODES].join(", ")})`); process.exit(2); }
if (!["widen", "narrow"].includes(POLICY)) { console.error(`unknown --policy ${POLICY} (want: widen, narrow)`); process.exit(2); }
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
// Un-anchored from ^ (F68/cluster C): every live spelling carries an OASIS option-code
// prefix before the negative word - "Z. None of the above", "3 - None of the above",
// "(-) No information available", "10 - None of the above". The old ^-anchored pattern
// matched none of them. Allow an optional leading code/bullet prefix.
// Absence/refusal options are excluded from the default sampling pool. Matched by MEANING,
// not by first word: OASIS labels carry an option-code prefix ("Z.", "3 -", "(-)") that the
// old ^-anchored pattern never got past (F68), while a loose ^no /^not /^declin match wrongly
// excluded real findings ("0 - No pain", "3 - Not healing", "Decline in mental status").
// Destructive exclusivity itself is now a schema rule; this pool is only a sampling default.
const CODE_PREFIX = /^(?:\(-\)|\[-\]|[A-Za-z]{0,2}\d{0,2}|\d{1,2})[.)\s-]*/;
const ABSENCE = /^(none of the above|none\b|no information available|not assessed|not applicable|not attempted|not tested|unknown\b|n\/a\b|refused\b|declined\b)/i;
// A bare no-answer, once the OASIS option code is stripped: "0 - No", "1. No", "9. No response",
// "No:", "None", "WNL", "0 - None of the time".
const BARE_NO = /^(no|none|n\/a|wnl|unknown|no response|no answer|none of the time)[\s.:;,-]*$/i;
// "No <thing> identified/noted/reported/found", "No problems identified", "No risk for
// infection identified", "No Acute Care Hospitalization", "0 - No pain".
// Deliberately NOT a bare /^no\b/: several REAL findings and orders begin with "No" —
// "No added salt", "No concentrated sweets", "No restrictions", "No willing/able caregiver",
// "No/Non-functioning smoking detectors", "Low/no income". Those must stay selectable.
const NO_FINDING = /^no[\s/]+.*\b(identified|noted|reported|found|hospitalization|problems?|pain|deficits?|abnormalit)/i;
// Non-answers: the patient/clinician did not supply one.
const NON_ANSWER = /^(patient (refused|declined|declines)|incorrect or no answer|missed by .* or no answer|could not recall)/i;
const NEGATIVE = {
  reason: (v) => {
    const t = String(v).trim();
    const s = t.replace(CODE_PREFIX, "").trim();
    for (const [name, re] of [["absence", ABSENCE], ["bare-no", BARE_NO], ["no-finding", NO_FINDING], ["non-answer", NON_ANSWER]])
      if (re.test(t) || re.test(s)) return name;
    return null;
  },
  test: (v) => NEGATIVE.reason(v) !== null,
};
// Audit trail for the exclusion: which values were filtered, and which enums the filter
// emptied (those fall back to the full list, so the payload can still carry a negative).
const excluded = new Map();   // value -> rule that excluded it
const emptiedPools = [];      // enums where every option read as negative

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
// Which values of `key` act as reveal triggers on the enclosing object? A sparse payload
// that picks one option per list is at the mercy of the draw: pick a leaf-only finding and
// that section's whole detail sub-tree stays closed. Preferring an option that some `if`
// keys off means the one selection also opens a level below it — "one selection at each
// subsequent level", rather than one selection and nothing under it.
function triggerValues(parent, key) {
  const out = new Set();
  for (const r of parent?.allOf ?? []) {
    const cond = r.if?.properties?.[key];
    if (!cond) continue;
    if (cond.contains?.const !== undefined) out.add(cond.contains.const);
    if (cond.const !== undefined) out.add(cond.const);
    for (const v of cond.contains?.enum ?? cond.enum ?? []) out.add(v);
  }
  return out;
}

function makeFiller(rand) {
  function pool(vals) {
    const pos = vals.filter((v) => {
      if (typeof v !== "string") return true;
      const why = NEGATIVE.reason(v);
      if (why) excluded.set(v, why);
      return !why;
    });
    if (pos.length) return pos;
    if (vals.length) emptiedPools.push(vals);
    return vals;
  }
  function pick(vals) { return vals[Math.floor(rand() * vals.length)]; }
  function leafValue(node, trig) {
    if (node.enum) {
      const vals = preferTriggers(pool(node.enum.filter((v) => v !== null)), trig);
      return vals.length ? pick(vals) : null;
    }
    if (node.example !== undefined && node.example !== null) return node.example;
    const base = Array.isArray(node.type) ? node.type.find((t) => t !== "null") : node.type;
    if (base === "boolean") return true;
    if (base === "number" || base === "integer") return 1;
    if (node.pattern) return null; // no example to conform with; repair may revisit
    return "CC test";
  }
  // Restrict a sampling pool to reveal triggers when any are available and we were asked to
  // prefer them. Falls back to the untouched pool when the control gates nothing.
  function preferTriggers(vals, trig) {
    if (!PREFER_TRIGGERS || !trig?.size) return vals;
    const hits = vals.filter((v) => trig.has(v));
    return hits.length ? hits : vals;
  }
  function fill(node, mode, parent, key) {
    if (isObj(node)) {
      const o = {};
      for (const [k, v] of Object.entries(node.properties)) {
        if (isObj(v)) o[k] = fill(v, mode, node, k);
        else {
          let m = mode;
          if (mode === "partial") m = rand() < PARTIAL_P ? "full" : "null";
          o[k] = fill(v, m, node, k);
        }
      }
      return o;
    }
    if (isArr(node)) {
      if (mode === "null") return [];
      const it = node.items ?? {};
      if (isObj(it)) {
        const n = mode === "full" ? 2 : 1;
        // Rows are filled coherently rather than at the parent's probability — a half-filled
        // row is not a row. `sparse` is the exception: it must stay width-1 all the way down,
        // or nested lists inside a row silently get full-mode breadth.
        const items = Array.from({ length: n }, () => fill(it, mode === "sparse" ? "sparse" : "full"));
        // Dedup on `label` when present, else on the whole row. Two rows sharing a label
        // check then UNCHECK the same box (F52 / #77) - whole-row equality missed that,
        // because the rows differed only in `text`.
        const seen = new Set();
        return items.filter((x) => {
          const k = (x && typeof x === "object" && x.label !== undefined && x.label !== null)
            ? `label:${JSON.stringify(x.label)}` : JSON.stringify(x);
          if (seen.has(k)) return false; seen.add(k); return true;
        });
      }
      const vals = preferTriggers(pool((it.enum ?? []).filter((v) => v !== null)), triggerValues(parent, key));
      if (!vals.length) return [it.example ?? "CC test"];
      const k = mode === "full" ? 1 + Math.floor(rand() * Math.min(3, vals.length)) : 1;
      const shuffled = [...vals].sort(() => rand() - 0.5);
      return [...new Set(shuffled.slice(0, k))];
    }
    return mode === "null" ? null : leafValue(node, triggerValues(parent, key));
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

// The repair loop also has to choose enum values. Left alone it takes the first allowed one,
// which on an OASIS scale is the "0. None" / "WNL" end — reintroducing exactly the values the
// sampler was told to withhold. Prefer a non-negative option, fall back only if there is none.
const firstAllowed = (vals, banned = new Set()) => {
  const ok = vals.filter((v) => v !== null && !banned.has(v));
  return ok.find((v) => typeof v !== "string" || !NEGATIVE.test(v)) ?? ok[0];
};

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
      // narrow: a `then` violation means a converse gate fired — "the detail is filled, so
      // the driver must carry its trigger". The repair can satisfy it by forcing the trigger
      // onto the driver (widen) or by blanking the detail the sibling `if` names (narrow).
      // Narrow keeps the single selection and drops the unreachable detail, which is also
      // what the live form does: no trigger checked, no detail rendered.
      //
      // Always skip the widening fallback once the rule is converse-shaped. `blanked` can be
      // false simply because pass 1's hidden-pin patch already emptied the detail this round;
      // falling through would then force a driver value nothing needs. If that leaves no
      // progress anywhere the loop reports a stall, which is the honest outcome.
      const conv = POLICY === "narrow" && ["contains", "const", "enum"].includes(e.keyword) &&
        e.schemaPath.match(/^(.*\/allOf\/\d+)\/then\/properties\//);
      if (conv) {
        const ifNode = resolveSchemaPath(conv[1] + "/if");
        const holder = getAt(payload, segs.slice(0, -1));
        let blanked = false;
        for (const ctrl of Object.keys(ifNode?.properties ?? {})) {
          if (!holder || !(ctrl in holder) || holder[ctrl] == null) continue;
          const bs = schemaAt([...segs.slice(0, -1).filter((s) => !/^\d+$/.test(s)), ctrl]);
          const blank = bs && isArr(bs) ? [] : bs && isObj(bs) ? hiddenSkeleton(bs) : null;
          // only count it if the value actually moves, else the loop spins without progress
          if (JSON.stringify(holder[ctrl]) === JSON.stringify(blank)) continue;
          holder[ctrl] = blank;
          blanked = true;
        }
        if (blanked) patched.add(key);
        continue;
      }
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
          if (base?.enum) v = firstAllowed(base.enum, ex);
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
        setAt(payload, segs, firstAllowed(e.params.allowedValues) ?? null); patched.add(key);
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
const manifest = { seed: SEED, policy: POLICY, generated_at_note: "regenerate after any input_schema change", payloads: {} };
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

// Exclusion audit — the negative filter is a judgement call per value, so make it reviewable
// rather than buried in a regex. Anything in `kept_but_negative_looking` is a value that
// starts with "no"/"none" but was deliberately KEPT because it is a real finding or order.
const negLooking = new Set();
(function scan(n) {
  if (!n || typeof n !== "object") return;
  if (Array.isArray(n.enum)) for (const v of n.enum)
    if (typeof v === "string" && /^(no|none|n\/a|unknown|wnl)\b/i.test(v.trim().replace(CODE_PREFIX, "")) && !excluded.has(v)) negLooking.add(v);
  for (const k of Object.keys(n)) if (typeof n[k] === "object") scan(n[k]);
})(schema);
manifest.exclusions = {
  note: "enum values withheld from sampling; rule = which pattern matched",
  count: excluded.size,
  by_value: Object.fromEntries([...excluded].sort(([a], [b]) => a.localeCompare(b))),
  kept_but_negative_looking: [...negLooking].sort(),
  enums_where_every_option_was_negative: emptiedPools.length,
};
fs.writeFileSync(path.join(OUT, "manifest.json"), JSON.stringify(manifest, null, 2));
console.log(`excluded ${excluded.size} negative enum value(s); ${negLooking.size} negative-looking value(s) kept (see manifest.exclusions)`);
