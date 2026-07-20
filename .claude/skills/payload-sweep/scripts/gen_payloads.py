#!/usr/bin/env python3
"""Generate synthetic run payloads from a workflow's input_schema.

Usage:
    cloudcruise workflows get <workflow_id> > workflow.json
    python3 gen_payloads.py workflow.json [--outdir .] [--a 40] [--b 60]

Emits, into --outdir:
    payloads.json                  # bundle: {_meta, full, empty, partial_a, partial_b}
    run_input_full.json            # every field populated with a valid value
    run_input_empty.json           # full key/nesting depth, all leaf scalars null
    run_input_partial_a.json       # ~A% of leaves nulled (deterministic by path)
    run_input_partial_b.json       # ~B% of leaves nulled (different, higher mask)

Values come from the SCHEMA (enum / example / type default) -- no faker, no
randomness. Masks are deterministic (md5 of the field path) so a given schema
always yields the same partials -- reproducible repros.

`max` is intentionally NOT generated here: it is a hand-authored maximal-coverage
payload (every bool true, every multi-select carrying all options, one row per
object-array type). See SKILL.md for how to build it.
"""
import json, sys, hashlib, argparse, os


def types_of(node):
    """Return the schema type(s) as a list, tolerating union arrays like ['string','null']."""
    t = node.get("type")
    if isinstance(t, list):
        return t
    if isinstance(t, str):
        return [t]
    return []


def pick_enum(node):
    """First meaningful enum value: skip '' and null sentinels."""
    for v in node.get("enum", []) or []:
        if v not in ("", None):
            return v
    return None


def full_leaf(node):
    """A valid value for a leaf: enum -> example -> type default. Free-text -> '' (skip)."""
    tl = types_of(node)
    e = pick_enum(node)
    if e is not None:
        return e
    if "example" in node:
        return node["example"]
    if "boolean" in tl:
        return True
    if "integer" in tl or "number" in tl:
        return 1
    if "string" in tl:
        return ""            # unconstrained free-text: leave blank rather than invent
    if tl == ["null"]:
        return None
    return "sample"


def is_object(node):
    return "object" in types_of(node) or "properties" in node


def is_array(node):
    return "array" in types_of(node) or "items" in node


def gen_full(node):
    if is_object(node):
        return {k: gen_full(v) for k, v in (node.get("properties") or {}).items()}
    if is_array(node):
        items = node.get("items") or {}
        # one element for object/enum-bearing items; [] for unconstrained
        if is_object(items) or items.get("enum") or "example" in items:
            return [gen_full(items)]
        return []
    return full_leaf(node)


def gen_empty(node):
    """Preserve full key/nesting depth; every leaf scalar -> null."""
    if is_object(node):
        return {k: gen_empty(v) for k, v in (node.get("properties") or {}).items()}
    if is_array(node):
        items = node.get("items") or {}
        if is_object(items):
            return [gen_empty(items)]   # one fully-null skeleton row to show depth
        return None                     # primitive-item array -> null
    return None


def gen_partial(node, path, threshold):
    """~threshold% of leaves nulled, chosen deterministically by field path."""
    if is_object(node):
        return {k: gen_partial(v, f"{path}.{k}", threshold)
                for k, v in (node.get("properties") or {}).items()}
    if is_array(node):
        items = node.get("items") or {}
        if is_object(items) or items.get("enum") or "example" in items:
            return [gen_partial(items, f"{path}[]", threshold)]
        return []
    h = int(hashlib.md5(path.encode()).hexdigest(), 16) % 100
    if h < threshold:
        return None
    return full_leaf(node)


def count_leaves(obj):
    """(total_leaves, null_leaves) for a sanity check."""
    if isinstance(obj, dict):
        t = n = 0
        for v in obj.values():
            dt, dn = count_leaves(v)
            t += dt; n += dn
        return t, n
    if isinstance(obj, list):
        t = n = 0
        for v in obj:
            dt, dn = count_leaves(v)
            t += dt; n += dn
        return t, n
    return 1, (1 if obj is None else 0)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("workflow", help="workflow.json from `cloudcruise workflows get`")
    ap.add_argument("--outdir", default=".")
    ap.add_argument("--a", type=int, default=40, help="partial_a null%% (default 40)")
    ap.add_argument("--b", type=int, default=60, help="partial_b null%% (default 60)")
    args = ap.parse_args()

    wf = json.load(open(args.workflow))
    schema = wf.get("input_schema") or wf.get("inputSchema")
    if not schema:
        sys.exit("no input_schema in workflow json")

    tiers = {
        "full": gen_full(schema),
        "empty": gen_empty(schema),
        "partial_a": gen_partial(schema, "$", args.a),
        "partial_b": gen_partial(schema, "$", args.b),
    }

    # Scaffold keys are navigation/identification config (patient id, which packet
    # to open, the form link text) -- NOT test data. If they get nulled, the run
    # dies at patient selection for a bogus reason that has nothing to do with the
    # null-safety we're actually testing. Force them fully-valid on EVERY tier.
    SCAFFOLD_KEYS = {"run_configuration"}
    props = schema.get("properties") or {}
    for key in SCAFFOLD_KEYS:
        if key in props:
            full_val = gen_full(props[key])
            for tier in tiers.values():
                if isinstance(tier, dict):
                    tier[key] = full_val
    os.makedirs(args.outdir, exist_ok=True)
    bundle = {"_meta": {
        "workflow_id": wf.get("id"),
        "version_number": wf.get("version_number"),
        "tiers": {
            "full": "every field a valid value",
            "empty": "full depth, all leaves null",
            "partial_a": f"~{args.a}% leaves null (deterministic)",
            "partial_b": f"~{args.b}% leaves null (deterministic)",
        },
    }, **tiers}
    with open(os.path.join(args.outdir, "payloads.json"), "w") as f:
        json.dump(bundle, f, indent=2)

    for k, v in tiers.items():
        with open(os.path.join(args.outdir, f"run_input_{k}.json"), "w") as f:
            json.dump(v, f, indent=2)
        t, n = count_leaves(v)
        print(f"{k:10s} leaves={t:4d} null={n:4d} ({(100*n//t) if t else 0}%)")

    print(f"\nwrote payloads.json + run_input_{{full,empty,partial_a,partial_b}}.json -> {args.outdir}")
    print("REMINDER: add the vault credential key (see workflow vault_schema alias) before triggering.")


if __name__ == "__main__":
    main()
