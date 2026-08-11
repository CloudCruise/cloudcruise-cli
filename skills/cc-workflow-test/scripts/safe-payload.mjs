// safe-payload.mjs --workflow <wf.json> --payload <payload-full.json> --out <file> [--rules ...]
//
// Rewrite a generated payload so it avoids the traps confirmed by sweep-01 + the live
// diagnosis (cc-workflows/diagnose-01.md, findings F1-F68), then re-validate with
// backend-parity AJV. Purpose: exercise everything EXCEPT the known bugs.
//
// Every edit is logged with the finding/failure it suppresses. As each cluster is fixed,
// drop its letter from --rules (or delete its PRUNE entries) and regenerate — the
// suppressed nodes come back into coverage.
//
// Rules:
//   B   shingles reveal chain (2 missing else + 1 entirely-absent gate)   F65 F66
//   C   destructive exclusivity: exclusive N/A clears the whole list      F68
//   G   orders label lists carry placeholders present in no live list     F21 F27 F36 F47
//   F   selector ambiguity: substring collisions + over-broad scope       F50 F57
//   I   n0415 indication_noted must be a subset of is_taking             (static, #36/#51)
//   M   GG0170 not-attempted skip hides the following step items          F62
//   DUP object array with a duplicate `label` toggles the checkbox off    F52
//   O   Recert-only: orders live in a form-wide modal, no inline grids    F17 F8
//   E   per-form: element/section absent on THIS assessment type          F23 F30 F41 F56 F59
//   A   per-form: write reports success but never actuates                F64 (+H, J)
//   K   per-form: enum is a union across forms, not forked                F45 F31 F32 F26
//   L   settle/scroll-dependent targets                                   (weak: #23 #35 #37)
import fs from "fs";
import path from "path";
const A = {}; for (let i=2;i<process.argv.length;i++){const a=process.argv[i]; if(a.startsWith("--")) A[a.slice(2)]=process.argv[++i];}
const HERE = path.dirname(new URL(import.meta.url).pathname);
const Ajv = (await import(new URL("file://"+path.join(HERE,"ajv.bundle.mjs")))).default;
const wf = JSON.parse(fs.readFileSync(A.workflow,"utf8"));
const schema = wf.input_schema;
const p = JSON.parse(fs.readFileSync(A.payload,"utf8"));
const log = [];
// Default trimmed after schema pass 01 (input_schema v60/v38/v45) + component fixes.
// DROPPED, each now enforced upstream — keeping them would only mask the fix:
//   B,C,I,M,K  schema rules (gates, exclusivity, n0415 subset, GG0170 chain, forked enums)
//   G          44 live label enums authored; the rule self-disables once a leaf has an enum
//   E          absent sections are `$ref: hidden`, so the payload is null and nodes self-gate
//   DUP        generator now dedups object rows on `label` (F52)
//   F          every known substring collision fixed with a nbsp-safe exact match
//              (components bf3f85fe, 0ada4dda) or a narrowed scope (9aab0231)
//   L          weak late-sweep evidence; the clean run is the re-test
// KEPT:
//   O  Recert's orders live in a form-wide modal — architecture unfixed, parked
//   A  25 defects, mechanism still unresolved after seven refuted hypotheses
const RULES = new Set((A.rules ?? "A").split(",").map(x=>x.trim()).filter(Boolean));
const on = (r) => RULES.has(r);

// --unsuppress a.b.c,d.e — dotted paths to EXEMPT from the prune rules, so one cluster-A area
// can be exercised while the rest stay suppressed. A path exempts itself and anything under it.
// Used to build the per-area test payloads (payloads-areas/), one area live at a time.
const UNSUP = (A.unsuppress ?? "").split(",").map(x=>x.trim()).filter(Boolean);
const exempt = (dotted) => UNSUP.some(u => dotted === u || dotted.startsWith(u + "."));

// ---- which assessment type is this? ----
const WF_KEY = {
  "fcad601a-eff1-4029-82b5-6978761a97fe":"SoC",
  "af414413-bb92-4d2c-9c61-2bd28b5d5670":"Recert",
  "ddc84b12-ec64-4dc4-a2c2-c73ef69cdc63":"PT",
}[wf.id] ?? "UNKNOWN";
if (WF_KEY === "UNKNOWN") console.error(`!! unrecognised workflow id ${wf.id} — per-form rules (O/E/A/K) will be skipped`);

const sAt = (segs) => segs.reduce((c,s)=> c==null?c : (c.properties?.[s] ?? (c.items&&c.items.properties?.[s]) ?? null), schema);
const getAt=(o,segs)=>segs.reduce((c,s)=>c==null?c:c[s],o);
const setAt=(o,segs,v)=>{let c=o;for(const s of segs.slice(0,-1)){if(c==null)return false;c=c[s];}if(c==null||!(segs.at(-1) in c))return false;c[segs.at(-1)]=v;return true;};
const nullify=(dotted,why)=>{
  const segs=dotted.split(".");
  const cur=getAt(p,segs);
  if(cur===undefined){log.push(`   skip  ${dotted}  (not in this workflow)`);return;}
  if(cur===null||(Array.isArray(cur)&&!cur.length))return;
  const v = Array.isArray(cur)?[]:(cur&&typeof cur==="object"?blank(cur):null);
  setAt(p,segs,v);
  log.push(`   null  ${dotted}   ${why}`);
};
// blank an object subtree in place of null (schema requires the keys to exist)
function blank(o){ if(Array.isArray(o))return[]; if(o&&typeof o==="object"){const r={};for(const[k,v]of Object.entries(o))r[k]=blank(v);return r;} return null; }

// ================= H — normalise against `$ref: hidden` (always on) =================
// A schema hide-pass (cluster E/H) marks absent fields `$ref: #/definitions/hidden`, which
// permits only null / [] / an all-hidden object. A payload generated before that pass still
// carries values there and is simply invalid — and the repair loop below cannot fix it, because
// there is no sibling `if` control to neutralise. So walk the schema and blank every hidden
// path up front. This makes a payload survive future hide-passes instead of silently going
// invalid, which matters while the hide-passes are still landing.
let hiddenBlanked = 0;
(function hide(snode, val, pth){
  if (snode == null || val == null) return;
  // check the marker before recursing — a hidden leaf is usually a scalar, not an object
  if (snode.$ref === "#/definitions/hidden") {
    const blanked = blank(val);
    if (JSON.stringify(val) !== JSON.stringify(blanked)) {
      setAt(p, pth, blanked);
      log.push(`H  blank ${pth.join(".")}   schema marks it $ref:hidden`);
      hiddenBlanked++;
    }
    return;
  }
  if (typeof val !== "object") return;
  for (const [k,v] of Object.entries(val)) {
    const child = snode.properties?.[k] ?? snode.items?.properties?.[k];
    if (child) hide(child, v, [...pth, k]);
  }
})(schema, p, []);

// ================= generic, schema-derivable rules =================
const EXCLUSIVE = /(none of the above|no information available)/i;
const ORDERS_LISTS = new Set(["interventions","goals","medical_necessity","homebound"]);
let counts = { G:0, Gkept:0, C:0, F:0, DUP:0 };

(function walk(val, snode, pth){
  if (val === null || val === undefined) return;
  if (Array.isArray(val)) {
    const items = snode?.items ?? {};
    const key = pth[pth.length-1];
    const inOrders = pth.includes("orders");
    // G — placeholder labels ('SN to instruct', 'Verbalizes understanding', 'Skilled need',
    // 'Homebound') appear in NO live option list. Only 44 of 94 label leaves are affected:
    // the rest carry a REAL enum and work fine, so suppress precisely rather than wholesale.
    if (on("G") && inOrders && ORDERS_LISTS.has(key) && val.length) {
      const lab = items?.properties?.label;
      const placeholderOnly = lab && !Array.isArray(lab.enum);   // example-only => never a live option
      if (placeholderOnly) {
        log.push(`G  empty ${pth.join(".")}  (${val.length} item(s))  label leaf is example-only (no enum) -> placeholder, F21/F27/F36/F47`);
        counts.G++; val.length = 0; return;
      }
      counts.Gkept++;   // enum-backed list: leave it in for coverage
    }
    // DUP — two object rows sharing a `label` check then UNCHECK the same box (F52)
    if (on("DUP") && val.some(x=>x&&typeof x==="object"&&"label" in x)) {
      const seen=new Set(), kept=[];
      for(const r of val){ const k=r?.label; if(k!==undefined&&seen.has(k))continue; if(k!==undefined)seen.add(k); kept.push(r); }
      if (kept.length!==val.length){ log.push(`DUP trim  ${pth.join(".")}  ${val.length} -> ${kept.length} (duplicate label toggles off, F52)`); counts.DUP++; val.length=0; val.push(...kept); }
    }
    if (items.enum) {
      const before=[...val];
      // C — an exclusive N/A option CLEARS and HIDES every other option (F68)
      if (on("C") && val.some(v=>EXCLUSIVE.test(String(v)))) {
        const kept = val.filter(v=>!EXCLUSIVE.test(String(v)));
        val.length=0; val.push(...kept);
        log.push(`C  strip ${pth.join(".")}  ${JSON.stringify(before)} -> ${JSON.stringify(val)}  destructive exclusivity, F68`);
        counts.C++;
      }
      // F — drop a member that is a SUBSTRING of another member of the same enum:
      // contains() would match both (F50). Substring, not just prefix.
      if (on("F")) {
        const drop = val.filter(v => typeof v==="string" && items.enum.some(e => typeof e==="string" && e!==v && e.includes(v)));
        if (drop.length) {
          const kept=val.filter(v=>!drop.includes(v));
          val.length=0; val.push(...kept);
          log.push(`F  drop  ${pth.join(".")}  ambiguous ${JSON.stringify(drop)} -> ${JSON.stringify(val)}  substring collision, F50`);
          counts.F++;
        }
      }
    } else {
      val.forEach((v,i)=>walk(v, items, [...pth, String(i)]));
    }
    return;
  }
  if (typeof val === "object") for (const [k,v] of Object.entries(val)) walk(v, snode?.properties?.[k] ?? snode?.items?.properties?.[k], [...pth,k]);
})(p, schema, []);

// G follow-up — if emptying the placeholder lists leaves an orders section with NO populated
// list, its problem_statement must be cleared too. Leaving the statement checked with every
// list empty makes the form raise "Response is required." — the SoC run produced 11 left-nav
// validation errors this way (F78), all traceable to this rule. Manufactured validation errors
// are exactly what we are trying to avoid, since a blocked page can mask later failures.
if (on("G")) {
  const LISTS=["interventions","goals","homebound","medical_necessity"];
  for (const [page,obj] of Object.entries(p)) {
    if (!obj || typeof obj!=="object" || !obj.orders) continue;
    for (const [k,v] of Object.entries(obj.orders)) {
      if (!v || typeof v!=="object" || v.problem_statement==null) continue;
      const present=LISTS.filter(l=>l in v);
      if (!present.length) continue;
      const anyPopulated=present.some(l=>Array.isArray(v[l]) && v[l].length);
      if (!anyPopulated) {
        v.problem_statement=null;
        log.push(`G  null  ${page}.orders.${k}.problem_statement   all its lists were emptied; leaving the statement checked raises "Response is required." F78`);
      }
    }
  }
}

// B — shingles: ever_received -> offered_vaccine -> declined_reason -> other (F65/F66)
if (on("B")) {
  const sh = p.risk_assessment?.shingles;
  if (sh) {
    if (sh.ever_received !== "No:" && sh.offered_vaccine !== null) { log.push(`B  null  risk_assessment.shingles.offered_vaccine  (ever_received=${JSON.stringify(sh.ever_received)}) F66 gate absent from schema`); sh.offered_vaccine=null; }
    if (sh.offered_vaccine !== "Patient declined" && sh.declined_reason !== null) { log.push(`B  null  risk_assessment.shingles.declined_reason  (offered_vaccine=${JSON.stringify(sh.offered_vaccine)}) F65`); sh.declined_reason=null; }
    if (sh.declined_reason !== "Other reason:" && sh.declined_reason_other !== null) { log.push(`B  null  risk_assessment.shingles.declined_reason_other  F65`); sh.declined_reason_other=null; }
  }
}

// I — n0415: indication_noted must be a subset of is_taking, else the row never renders
if (on("I")) {
  const n = p.medications?.n0415;
  if (n && Array.isArray(n.is_taking) && Array.isArray(n.indication_noted)) {
    const orphan = n.indication_noted.filter(x=>!n.is_taking.includes(x));
    if (orphan.length) { n.indication_noted = n.indication_noted.filter(x=>n.is_taking.includes(x));
      log.push(`I  trim  medications.n0415.indication_noted  removed ${JSON.stringify(orphan)} (not in is_taking -> row absent) #36/#51`); }
  }
}

// M — GG0170 steps progression (M -> N -> O) is a CHAIN: a non-attempt code on ANY step
// item hides every step item after it. F62 proved the M->N/O link by hand; SoC's run
// (fe8b8009 SELECTOR_NO_MATCH on twelve_steps) proved the N->O link, which F62's
// one_step_curb-only reading missed. Walk the chain and null everything after the first
// non-attempt code. The walk items (I/J/K/L) are a separate group and do NOT gate steps —
// SoC had walk_150_feet='09. Not applicable' with one_step_curb still rendering.
const GG_STEP_CHAIN = ["one_step_curb","four_steps","twelve_steps"];
const NOT_ATTEMPTED = /^(07|09|10|88)\./;
if (on("M")) {
  const g = p.functional_abilities?.gg0170_mobility;
  if (g) {
    let blockedBy = null;
    for (const k of GG_STEP_CHAIN) {
      if (blockedBy && g[k]!=null) {
        log.push(`M  null  functional_abilities.gg0170_mobility.${k}  hidden by ${blockedBy}=${JSON.stringify(g[blockedBy])} (GG0170 steps skip chain) F62/F72`);
        g[k]=null; continue;
      }
      if (g[k]!=null && NOT_ATTEMPTED.test(String(g[k]))) blockedBy = k;
    }
  }
}

// ================= per-assessment-type rules =================
// F — over-broad scope: the colliding value is NOT in the enum, it is a nested sub-option
if (on("F")) {
  const d = p.endocrine?.endocrine_hematological_assessment?.diabetes;
  if (d && Array.isArray(d.insulin_administered_by)) {
    const bad = d.insulin_administered_by.filter(v=>v==="Patient"||v==="Caregiver");
    if (bad.length) { d.insulin_administered_by = d.insulin_administered_by.filter(v=>!bad.includes(v));
      log.push(`F  drop  endocrine…diabetes.insulin_administered_by  ${JSON.stringify(bad)} collide with nested SnToAdministerDueTo options, F57 (#27/#34)`); }
  }
}

// K — the discipline-orders enum is a UNION across three forms; keep only what THIS form has
const DISC_ABSENT = {
  Recert: ["Need for oral explanation of patient rights by 2nd visit:"],           // F31/F45
  PT:     ["Therapy-only case (Chosen only if an order was written for therapy-only services)",
           "Management and evaluation of non-skilled plan of care (Physician addendum required):",
           "Skilled nurse evaluation performed; Need for skilled nursing services:",
           "Skilled nurse evaluation performed; no further visits required:",
           "Non-admit:", "Plan of care SN orders locator:"],                        // F42/F45
  SoC:    [],
};
if (on("K") && WF_KEY!=="UNKNOWN") {
  const arr = p.summary_of_care?.discipline_orders_and_treatment?.orders;
  const absent = DISC_ABSENT[WF_KEY] ?? [];
  if (Array.isArray(arr) && absent.length) {
    const bad = arr.filter(v=>absent.includes(v));
    if (bad.length) { p.summary_of_care.discipline_orders_and_treatment.orders = arr.filter(v=>!absent.includes(v));
      log.push(`K  drop  summary_of_care.discipline_orders_and_treatment.orders  ${JSON.stringify(bad)} absent on ${WF_KEY}'s live list, F45`); }
  }
  // #44 — 'Legal:' is not a real category (F32)
  const ri = p.summary_of_care?.visit_interventions?.reviewed_and_instructed;
  if (Array.isArray(ri)) {
    const bad = ri.filter(x=>/Legal:/.test(typeof x==="string"?x:JSON.stringify(x)));
    if (bad.length) { p.summary_of_care.visit_interventions.reviewed_and_instructed = ri.filter(x=>!bad.includes(x));
      log.push(`K  drop  summary_of_care.visit_interventions.reviewed_and_instructed  'Legal:' is not a live category, F32 (#44)`); }
  }
  // #50 — one-character casing drift: the live label is 'IV And/or Parenteral Therapy' but
  // the schema enum only permits the lowercase 'and/or' (F26). We cannot write the correct
  // value here without failing schema validation, so suppress the node instead. The real
  // fix is to correct the enum in the input_schema; then drop this and regenerate.
  const iv = p.medications?.orders?.iv_parenteral;
  if (iv && typeof iv.problem_statement==="string" && /^IV and\/or Parenteral Therapy$/.test(iv.problem_statement)) {
    iv.problem_statement = null;
    log.push(`K  null  medications.orders.iv_parenteral.problem_statement   live label is 'IV And/or…' (capital A) but the schema enum only allows lowercase — cannot be corrected in the payload, F26 (#50)`);
  }
}

// O — Recert's orders are a form-wide modal; every inline *ProblemStatement node fails (F17)
if (on("O") && WF_KEY==="Recert") {
  for (const [page,obj] of Object.entries(p)) {
    if (!obj || typeof obj!=="object" || !obj.orders) continue;
    for (const [k,v] of Object.entries(obj.orders)) {
      // The whole section is unreachable (no inline grid at all), so suppress ALL of it.
      // Nulling only problem_statement leaves the anyOf rule "any list non-empty =>
      // problem_statement must be a string" unsatisfiable.
      if (v && typeof v==="object" && JSON.stringify(v)!==JSON.stringify(blank(v))) {
        obj.orders[k]=blank(v);
        log.push(`O  blank ${page}.orders.${k}   whole section unreachable: Recert uses the form-wide Plan of Care Profile modal, F17/F8`); }
    }
  }
}

// PT — nursing per-page orders sections do not exist on the PT form (F23, observed failures)
const PT_NO_ORDERS = ["cardiac_status","respiratory_status","neuro_emotional_behavioral_status",
                      "pain_status","elimination_status","endocrine","nutrition","medications"];
if (on("E") && WF_KEY==="PT") {
  for (const page of PT_NO_ORDERS) {
    const o = p[page]?.orders; if (!o) continue;
    for (const [k,v] of Object.entries(o)) if (v && typeof v==="object" && JSON.stringify(v)!==JSON.stringify(blank(v))) {
      o[k]=blank(v);
      log.push(`E  blank ${page}.orders.${k}   section absent on the PT form, F23 (#9 #13 #16 #18 #24 #38 #45 #52)`);
    }
  }
}

// ---- explicit per-form prune list; each entry cites its finding ----
const PRUNE = {
  ALL: [
    // dropped #55 f2f      — FIXED, component 4cda463b: scoped starts-with, DOM-validated 2/2
    // dropped #23 self_care, #35/#37 infection_control — cluster L, weak late-sweep evidence
    //   gathered under the accumulation confound. The clean run IS the re-test.
    // dropped #31 m2001    — cluster N, same reasoning.
    ["functional_status.plan_of_care_activities.partial_weight_bearing",      "#21/#26 A — PWB parent write no-ops, F64"],
  ],
  SoC: [
    // dropped m1332/m1334 — suppressed on the assumption m1330 no-ops; F79 caught it landing
    //   cleanly, so this was over-cautious.
  ],
  Recert: [
    // dropped m1845, k0520 — the schema now marks both `$ref: hidden` on Recert (F56/F59),
    //   so the payload is null there and the nodes self-gate. Suppressing too would hide it.
    ["sensory_status.sensory_assessment.hearing_impaired.items",    "#7 A — category write no-ops, F64"],
    ["integumentary_status.pressure_ulcer.m1311",                  "#11 A — m1306 write no-ops, F64"],
    ["respiratory_status.respiratory_assessment.cough_productive_sputum", "#12 A — findings[] write no-ops, F64"],
    ["pain_status.pain_assessment.primary_site",                   "#8 A — pain_present dropdown no-ops, F64"],
    ["elimination_status.m_codes.m1600",                           "#17 A — blocked by an upstream no-op"],
    ["supportive_assistance.safety_measures.presence_of_animals",   "#6 A — measures[] write no-ops, F64"],
  ],
  PT: [
    // dropped #83 labs — the schema now marks it `$ref: hidden` on PT (F41). Note #83 needed
    //   NO selector fix: F33/F46 read SummaryLabComments as a sibling on Recert, but the live
    //   DOM shows it nested inside SummaryAssessment1Labs and node df9642cb resolves 1/1.
    ["cardiac_status.cardiac_assessment.pacemaker",                "#16 A — date typed but never commits, F63/F64"],
    ["therapy_evaluation.balance.sitting",                         "#58 A — dropdown write no-ops (containers present), F54"],
    ["therapy_evaluation.balance.standing",                        "#58 A — plus stale-report contamination, re-test needed"],
    ["therapy_evaluation.weight_bearing.status",                   "#59 A — F54"],
    ["therapy_evaluation.weight_bearing.comment",                  "#60 cascade of #59"],
    ["therapy_evaluation.posture.status",                          "#61 A — F54"],
    ["therapy_evaluation.posture.comment",                         "#62 cascade of #61"],
    ["therapy_evaluation.activity_tolerance.comments",             "#63 A — F54"],
  ],
};
// PT therapy_tool_box: all 11 tests fail on their first data node (H). Keep `comments`,
// which is the one field on that section that demonstrably persisted (F7).
if (on("A") && WF_KEY==="PT") {
  const tb = p.therapy_evaluation?.therapy_tool_box;
  if (tb) for (const k of Object.keys(tb)) {
    if (k==="comments") continue;
    if (exempt(`therapy_evaluation.therapy_tool_box.${k}`)) { log.push(`   keep  therapy_evaluation.therapy_tool_box.${k}   --unsuppress`); continue; }
    if (tb[k]==null || (typeof tb[k]==="object" && !Object.keys(tb[k]).length)) continue;
    tb[k]=blank(tb[k]);
    log.push(`A  null  therapy_evaluation.therapy_tool_box.${k}   enable click never actuates, F5/F10/F64 (#64-#74)`);
  }
}
for (const [dotted,why] of [...(on("A")||on("E")||on("L")?PRUNE.ALL:[]), ...((on("A")||on("E"))?(PRUNE[WF_KEY]??[]):[])]) {
  if (exempt(dotted)) { log.push(`   keep  ${dotted}   --unsuppress (was: ${why})`); continue; }
  nullify(dotted,why);
}

// ================= validate with backend-parity AJV, then repair =================
const full = JSON.parse(JSON.stringify(schema));
for (const alias of Object.keys(wf.vault_schema ?? {})) {
  full.properties[alias] = { oneOf:[{type:"string"},{type:"array",items:{type:"string"}}] };
  full.required = [...(full.required??[]), alias];
}
const validate = new Ajv({ strict:true, validateFormats:false, addUsedSchema:false, removeAdditional:false, strictSchema:false, keywords:["example"], allErrors:true }).compile(full);

// A nulled dependent whose control still triggers its reveal is invalid. Walk the `then`
// violation back to the sibling `if` and neutralise the CONTROL — which is also the
// semantically right move: do not check a control whose dependent we are suppressing.
const resolve = (sp) => sp.split("/").slice(1).reduce((c,seg)=>c?.[/^\d+$/.test(seg)?Number(seg):seg.replace(/~1/g,"/").replace(/~0/g,"~")], schema);
const parse = (ip) => ip.split("/").slice(1).map(x=>x.replace(/~1/g,"/").replace(/~0/g,"~"));
for (let round=0; round<60; round++) {
  if (validate(p)) break;
  let acted=false;
  for (const e of validate.errors) {
    const m = e.schemaPath.match(/^(.*\/allOf\/\d+)\/then\/properties\/([^/]+)\//);
    if (!m) continue;
    const ifNode = resolve(m[1]+"/if");
    // anyOf-shaped if (e.g. "any of goals/interventions/homebound/medical_necessity
    // non-empty => problem_statement must be a string"): empty every listed array.
    if (!ifNode?.properties && Array.isArray(ifNode?.anyOf)) {
      const holder2 = getAt(p, parse(e.instancePath).slice(0,-1));
      if (holder2) { let did=false;
        for (const br of ifNode.anyOf) for (const kk of Object.keys(br.properties??{}))
          if (Array.isArray(holder2[kk]) && holder2[kk].length) { holder2[kk]=[]; did=true; }
        if (did) { log.push(`   ctrl  ${parse(e.instancePath).slice(0,-1).join(".")}  empty orders lists (un-reveal ${m[2]})`); acted=true; continue; }
      }
    }
    const ctrl = Object.keys(ifNode?.properties ?? {})[0];
    if (!ctrl) continue;
    const cond = ifNode.properties[ctrl];
    const parent = parse(e.instancePath).slice(0,-1);
    const holder = getAt(p,parent);
    if (!holder || !(ctrl in holder)) continue;
    if (cond.contains?.const !== undefined && Array.isArray(holder[ctrl])) {
      const v=cond.contains.const;
      if (holder[ctrl].includes(v)) { holder[ctrl]=holder[ctrl].filter(x=>x!==v);
        log.push(`   ctrl  ${[...parent,ctrl].join(".")}  remove ${JSON.stringify(v)} (un-reveal ${m[2]})`); acted=true; }
    } else if (cond.const !== undefined && holder[ctrl]===cond.const) {
      const alt=(sAt([...parent,ctrl])?.enum ?? []).find(x=>x!==null&&x!==cond.const) ?? null;
      holder[ctrl]=alt;
      log.push(`   ctrl  ${[...parent,ctrl].join(".")}  ${JSON.stringify(cond.const)} -> ${JSON.stringify(alt)} (un-reveal ${m[2]})`); acted=true;
    } else if (cond.not?.$ref === "#/definitions/hidden" && holder[ctrl]!==null) {
      const was=holder[ctrl]; holder[ctrl]=Array.isArray(was)?[]:(was&&typeof was==="object"?blank(was):null);
      log.push(`   ctrl  ${[...parent,ctrl].join(".")}  hide (was ${JSON.stringify(was).slice(0,40)}) — sibling of nulled ${m[2]}`); acted=true;
    } else if (Array.isArray(cond.enum) && cond.enum.includes(holder[ctrl])) {
      const bad=new Set(cond.enum);
      const alt=(sAt([...parent,ctrl])?.enum ?? []).find(x=>x!==null&&!bad.has(x)) ?? null;
      const was=holder[ctrl]; holder[ctrl]=alt;
      log.push(`   ctrl  ${[...parent,ctrl].join(".")}  ${JSON.stringify(was)} -> ${JSON.stringify(alt)} (un-reveal ${m[2]})`); acted=true;
    }
  }
  if (!acted) break;
}
const ok = validate(p);
fs.writeFileSync(A.out, JSON.stringify(p,null,2));
const hdr = [
  `# ${path.basename(A.out)} — ${WF_KEY} (${wf.name})`,
  `# generated from ${path.basename(A.payload)} by safe-payload.mjs`,
  `# rules: ${[...RULES].join(",")}`,
  `# AJV valid: ${ok}`,
  `# ${log.length} edits. Each cites the sweep-01 failure / diagnose-01 finding it suppresses.`,
  `# Drop a rule letter and regenerate once that cluster is fixed, to restore coverage.`,
  ``,
].join("\n");
fs.writeFileSync(A.out.replace(/\.json$/,".changes.txt"), hdr+log.join("\n")+"\n");
console.log(`${path.basename(A.out)}  wf=${WF_KEY}  valid=${ok}  edits=${log.length}  (G-emptied:${counts.G} G-kept:${counts.Gkept} C:${counts.C} F:${counts.F} DUP:${counts.DUP})`);
if (!ok) console.log("  ERRORS:", JSON.stringify(validate.errors?.slice(0,3)));
