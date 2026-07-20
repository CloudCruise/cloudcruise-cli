#!/usr/bin/env python3
"""Generate the `max` (maximal-coverage) run payload from a workflow's input_schema.

Usage:
    python3 gen_max.py workflow.json [--out run_input_max.json] [--date MM/DD/YYYY]

The `max` tier is schema-ceiling + form-contradiction coverage (see payload-sweep
SKILL.md). Rules applied here:
  - every boolean -> true
  - scalar-enum array (multi-select) -> ALL enum options
  - object-array whose item has a `template` enum -> ONE row per template value
    (the "one sub-row per object-array type" rule) with text_append filled
  - object-array with no enum (e.g. frequencies) -> one fully-populated row
  - free-text string -> node.example, else a test sentence
  - date-looking free-text (key contains 'date') -> --date value
  - scalar enum -> first meaningful enum (a single-select can't carry all)
  - number/integer -> example, else 1

Deliberately produces incoherent single-select-violating combos: that's the signal
for missing schema if/then guards. run_configuration + the vault credential key are
NOT maximized -- splice those from run_input_full.json after generating.
"""
import json, sys, argparse

TEST_SENTENCE = "Lorem ipsum dolor sit amet"


def types_of(node):
    t = node.get("type")
    if isinstance(t, list):
        return t
    if isinstance(t, str):
        return [t]
    return []


def is_object(node):
    return "object" in types_of(node) or "properties" in node


def is_array(node):
    return "array" in types_of(node) or "items" in node


def enum_of(node):
    return [v for v in (node.get("enum") or []) if v not in ("", None)]


def max_leaf(node, key):
    tl = types_of(node)
    e = enum_of(node)
    if e:                                   # single-select: first meaningful
        return e[0]
    if "boolean" in tl:
        return True
    if "integer" in tl or "number" in tl:
        return node.get("example", 1)
    if "string" in tl:
        if "example" in node and node["example"] not in ("", None):
            return node["example"]
        if "date" in key.lower():
            return DATE
        return TEST_SENTENCE
    if tl == ["null"]:
        return None
    return TEST_SENTENCE


def gen_max(node, key=""):
    if is_object(node):
        return {k: gen_max(v, k) for k, v in (node.get("properties") or {}).items()}
    if is_array(node):
        items = node.get("items") or {}
        e = enum_of(items)
        # scalar-enum array -> ALL options
        if e and not is_object(items):
            return e
        if is_object(items):
            props = items.get("properties") or {}
            # object-array keyed by a `template` enum -> one row per template value
            tmpl = props.get("template")
            if tmpl and enum_of(tmpl):
                rows = []
                for val in enum_of(tmpl):
                    row = {}
                    for pk, pv in props.items():
                        row[pk] = val if pk == "template" else gen_max(pv, pk)
                    rows.append(row)
                return rows
            # generic object-array -> one fully-populated row
            return [gen_max(items, key)]
        return [max_leaf(items, key)]
    return max_leaf(node, key)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("workflow")
    ap.add_argument("--out", default="run_input_max.json")
    ap.add_argument("--date", default="07/20/2026")
    ap.add_argument("--splice-from", help="run_input_full.json to copy run_configuration + credential key from")
    args = ap.parse_args()

    global DATE
    DATE = args.date

    wf = json.load(open(args.workflow))
    schema = wf.get("input_schema") or wf.get("inputSchema")
    if not schema:
        sys.exit("no input_schema")

    payload = gen_max(schema)

    if args.splice_from:
        full = json.load(open(args.splice_from))
        if "run_configuration" in full:
            payload["run_configuration"] = full["run_configuration"]
        # copy any top-level key present in full but not part of the schema properties
        # (the vault credential alias, e.g. USER)
        for k in full:
            if k not in schema.get("properties", {}):
                payload[k] = full[k]

    json.dump(payload, open(args.out, "w"), indent=2)

    def count(o):
        if isinstance(o, dict):
            return sum(count(v) for v in o.values())
        if isinstance(o, list):
            return sum(count(v) for v in o) or len(o)
        return 1
    print(f"wrote {args.out}  (~{count(payload)} leaves)")


if __name__ == "__main__":
    main()
