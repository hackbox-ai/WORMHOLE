#!/usr/bin/env python3
"""Offline request correlation, experiment planning and state checks. Never sends requests."""
from __future__ import annotations
import argparse
from collections import defaultdict
from decimal import Decimal, InvalidOperation
import hashlib
import json
from pathlib import Path
import re
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

MAX_BYTES = 4 * 1024 * 1024
SENSITIVE = re.compile(r"(?:^|[_-])(password|passwd|secret|token|cookie|authorization|signature|api[_-]?key|ticket)(?:$|[_-])", re.I)
IDENTIFIER = re.compile(r"(?:id|_id|Id|_no|_ref|token|ticket|signature|receipt|reference)$", re.I)


def dumps(value): return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
def fingerprint(value): return hashlib.sha256(dumps(value).encode()).hexdigest()


def load(path, lines=False):
    source = Path(path)
    if source.stat().st_size > MAX_BYTES: raise ValueError("Input exceeds 4 MiB; use a bounded batch")
    raw = source.read_text(encoding="utf-8")
    result = [json.loads(line) for line in raw.splitlines() if line.strip()] if lines else json.loads(raw)
    # Reject non-standard JSON numbers and excessive nesting before analysis.
    def validate(value, depth=0):
        if depth > 32: raise ValueError("Input nesting exceeds 32")
        if isinstance(value, dict):
            for item in value.values(): validate(item, depth + 1)
        elif isinstance(value, list):
            if len(value) > 10000: raise ValueError("Array exceeds 10000 entries")
            for item in value: validate(item, depth + 1)
        elif isinstance(value, float) and (value != value or abs(value) == float("inf")):
            raise ValueError("Non-finite numbers are not supported")
    validate(result)
    return result


def redact(value, key=""):
    if SENSITIVE.search(key): return {"redacted": True, "sha256": fingerprint(value)}
    if isinstance(value, dict): return {k: redact(v, k) for k, v in value.items() if k.lower() != "headers"}
    if isinstance(value, list): return [redact(x) for x in value]
    if isinstance(value, str) and value.lower().startswith(("bearer ", "basic ")):
        return {"redacted": True, "sha256": fingerprint(value)}
    return value


def safe_url(value):
    p = urlsplit(value)
    if p.username or p.password: raise ValueError("URL credentials are not supported")
    query = [(k, "[runtime-secret]" if SENSITIVE.search(k) else v) for k, v in parse_qsl(p.query, keep_blank_values=True)]
    return urlunsplit((p.scheme, p.netloc, p.path, urlencode(query), ""))


def walk(value, pointer=""):
    if isinstance(value, dict):
        for key, item in value.items():
            escaped = str(key).replace("~", "~0").replace("/", "~1")
            yield from walk(item, pointer + "/" + escaped)
    elif isinstance(value, list):
        for index, item in enumerate(value): yield from walk(item, pointer + "/" + str(index))
    else:
        yield pointer, value


def parts(pointer):
    if not pointer.startswith("/") or "~" in re.sub(r"~[01]", "", pointer):
        raise ValueError("Expected a JSON Pointer")
    return [x.replace("~1", "/").replace("~0", "~") for x in pointer[1:].split("/")]


def replace_at(value, pointer, new_value):
    components = parts(pointer)
    current = value
    for key in components[:-1]: current = current[int(key)] if isinstance(current, list) else current[key]
    key = int(components[-1]) if isinstance(current, list) else components[-1]
    if isinstance(current, dict) and key not in current: raise ValueError("Mutation target does not exist")
    current[key] = new_value


def correlate(events):
    if not isinstance(events, list) or len(events) > 5000: raise ValueError("Expected at most 5000 observations")
    occurrences = defaultdict(list)
    ids = set()
    summaries = []
    for event in events:
        reference = event.get("evidence_ref")
        if not isinstance(reference, str) or not reference or reference in ids:
            raise ValueError("Every observation needs a unique evidence_ref")
        ids.add(reference)
        if not event.get("subject_ref"): raise ValueError("subject_ref is required; do not infer identity from a response owner field")
        summaries.append({"evidence_ref": reference, "subject_ref": event["subject_ref"], "identity_evidence": event.get("identity_evidence"), "method": event.get("method"), "url": safe_url(str(event.get("url", ""))), "status": event.get("status")})
        for direction in ("request", "response"):
            for pointer, value in walk(event.get(direction, {})):
                leaf = pointer.rsplit("/", 1)[-1]
                if IDENTIFIER.search(leaf) and isinstance(value, (str, int)) and not isinstance(value, bool) and value != "":
                    occurrences[fingerprint(value)].append({"evidence_ref": reference, "subject_ref": event["subject_ref"], "direction": direction, "pointer": pointer, "sensitive": bool(SENSITIVE.search(leaf))})
    links = []
    for digest, items in occurrences.items():
        if len({x["evidence_ref"] for x in items}) > 1:
            links.append({"value_sha256": digest, "occurrences": items, "cross_subject": len({x["subject_ref"] for x in items}) > 1})
    return {"observations": summaries, "links": links, "interpretation": "Shared identifiers are navigation hints. Confirm identity, ownership, visibility and actual effects with the cited traffic before recording facts."}


def matrix(config):
    subjects, objects = config.get("subjects", []), config.get("objects", [])
    if not subjects or not objects or len(subjects) * len(objects) > 256: raise ValueError("Matrix must contain 1 to 256 subject/object combinations")
    subject_ids = [x.get("id") for x in subjects]
    object_ids = [x.get("id") for x in objects]
    if any(not isinstance(x, str) or not x for x in subject_ids + object_ids) or len(set(subject_ids)) != len(subject_ids) or len(set(object_ids)) != len(object_ids):
        raise ValueError("Subject and object IDs must be nonempty and unique")
    for subject in subjects:
        if not subject.get("identity_evidence"): raise ValueError("Each subject needs independent identity evidence")
    for obj in objects:
        if obj.get("exists") is False:
            if not obj.get("absence_evidence"): raise ValueError("An absent-object control needs absence_evidence")
        elif obj.get("owner") not in subject_ids or not obj.get("ownership_evidence"):
            raise ValueError("Each existing object needs an owner and ownership evidence")
    request = config.get("request", {})
    if request.get("method") not in {"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD"}: raise ValueError("Explicit request method required")
    if not config.get("request_evidence"): raise ValueError("request_evidence is required")
    if "headers" in request: raise ValueError("Keep session credentials in the host; use subject_ref instead of headers")
    sanitized = redact(request)
    if sanitized != request: raise ValueError("Replace request secrets with host references before building a plan")
    if safe_url(str(request.get("url", ""))) != str(request.get("url", "")):
        raise ValueError("Use a fragment-free canonical URL without query secrets")
    pointer = config.get("object_pointer")
    if not pointer: raise ValueError("object_pointer must identify an existing JSON body or query field")
    plans = []
    for subject in subjects:
        for obj in objects:
            req = json.loads(dumps(request))
            replace_at(req, pointer, obj["value"])
            category = "absent_control" if obj.get("exists") is False else "baseline" if obj.get("owner") == subject["id"] else "cross_subject"
            plans.append({"subject_ref": subject["id"], "object_ref": obj["id"], "category": category, "request": req, "request_evidence": config["request_evidence"], "identity_evidence": subject["identity_evidence"], "ownership_evidence": obj.get("ownership_evidence"), "requires_regeneration": config.get("regenerate", []), "status": "PLANNED"})
    plans.sort(key=lambda x: {"baseline": 0, "absent_control": 1, "cross_subject": 2}[x["category"]])
    return {"plans": plans, "network_requests_sent": 0, "instructions": "Execute only through host-visible, authorized tools. Bind subject sessions and regenerate CSRF/signature/nonce at execution. Planned does not mean tested; verify foreign writes through the owner and attach real traffic references."}


def compare(baseline, experiment, control, ignore=()):
    def cleaned(value):
        value = json.loads(dumps(redact(value)))
        for pointer in ignore:
            try: replace_at(value, pointer, "[ignored]")
            except (KeyError, IndexError, TypeError): pass
        return value
    baseline, experiment, control = map(cleaned, (baseline, experiment, control))
    left, right, negative = (dict(walk(v)) for v in (baseline, experiment, control))
    changes = []
    for pointer in sorted(set(left) | set(right)):
        if pointer not in left or pointer not in right or left[pointer] != right[pointer]:
            changes.append({"pointer": pointer, "baseline": left.get(pointer, "[missing]"), "experiment": right.get(pointer, "[missing]"), "control": negative.get(pointer, "[missing]")})
    return {"changes": changes, "experiment_matches_control": experiment == control, "normalized_sha256": {"baseline": fingerprint(baseline), "experiment": fingerprint(experiment), "control": fingerprint(control)}, "conclusion": "Response differences alone do not establish authorization, persistence or impact. Independently read the affected object or downstream state."}


def number(value):
    if isinstance(value, bool) or not isinstance(value, (str, int, float)) or len(str(value)) > 128:
        raise ValueError("Expected a bounded decimal value")
    try: value = Decimal(str(value))
    except InvalidOperation as e: raise ValueError("Invalid decimal") from e
    if not value.is_finite() or abs(value.adjusted()) > 30: raise ValueError("Non-finite or excessively large decimal")
    return value


def check(config):
    rules = config.get("checks")
    if not isinstance(rules, list) or not 1 <= len(rules) <= 500: raise ValueError("Expected 1 to 500 checks")
    results = []
    for rule in rules:
        if not rule.get("evidence_refs") or not rule.get("name"): raise ValueError("Each check needs a name and real evidence references")
        kind = rule.get("kind")
        values = rule.get("values", [])
        if not isinstance(values, list) or len(values) > 10000: raise ValueError("Invalid values")
        if kind == "sum_lte":
            total, limit = sum((number(x) for x in values), Decimal(0)), number(rule["limit"])
            outcome = {"holds": total <= limit, "sum": str(total), "limit": str(limit), "excess": str(max(Decimal(0), total - limit))}
        elif kind == "equal":
            outcome = {"holds": all(x == values[0] for x in values)} if values else {"holds": True}
        elif kind == "unique":
            digests = [fingerprint(x) for x in values]
            outcome = {"holds": len(set(digests)) == len(digests), "duplicates": len(digests) - len(set(digests))}
        elif kind == "nondecreasing":
            nums = [number(x) for x in values]
            outcome = {"holds": all(a <= b for a, b in zip(nums, nums[1:]))}
        elif kind == "bound":
            low, high = number(rule["minimum"]), number(rule["maximum"])
            if low > high: raise ValueError("minimum must not exceed maximum")
            outcome = {"holds": all(low <= number(x) <= high for x in values)}
        else: raise ValueError("Unsupported check kind")
        results.append({"name": rule["name"], "kind": kind, "unit": rule.get("unit"), "evidence_refs": rule["evidence_refs"], **outcome})
    return {"checks": results, "boundary": "These calculations evaluate supplied values, not evidence authenticity or product expectations. Confirm business semantics and persistence in WORMHOLE before reporting a finding."}


def candidates(config):
    """Expand observed naming variants into an ordered, bounded candidate list. Ships no vocabulary."""
    parts, joins = config.get("parts"), config.get("joins", [])
    if not isinstance(parts, list) or not 1 <= len(parts) <= 8: raise ValueError("Expected 1 to 8 parts")
    if not isinstance(joins, list) or len(joins) not in (0, len(parts) - 1): raise ValueError("joins must sit between adjacent parts")
    for part in parts:
        if not isinstance(part, list) or not 1 <= len(part) <= 40: raise ValueError("Each part holds 1 to 40 variants")
        for value in part:
            if not isinstance(value, str) or not 1 <= len(value) <= 64: raise ValueError("Variants are bounded non-empty strings")
    for join in joins:
        if not isinstance(join, str) or len(join) > 8: raise ValueError("joins are short separators")
    total = 1
    for part in parts: total *= len(part)
    if total > 500: raise ValueError("Candidate set exceeds 500; narrow the hypothesis space from observed material")
    rows = [""]
    for index, part in enumerate(parts):
        join = joins[index - 1] if index and joins else ""
        rows = [row + join + value for row in rows for value in part]
    return {"candidates": rows, "count": len(rows),
            "instructions": "Order parts by observed likelihood before expansion. These are hypotheses, not findings: verify through host-visible authorized tools under the target's real throttling, and confirm any success by reaching a protected resource with that identity."}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)
    for name in ("correlate", "matrix", "check", "candidates"):
        p = sub.add_parser(name); p.add_argument("--input", required=True); p.add_argument("--output")
    p = sub.add_parser("compare")
    for name in ("baseline", "experiment", "control"): p.add_argument("--" + name, required=True)
    p.add_argument("--ignore", action="append", default=[]); p.add_argument("--output")
    args = parser.parse_args()
    try:
        if args.command == "compare": result = compare(load(args.baseline), load(args.experiment), load(args.control), args.ignore)
        else:
            source = load(args.input, lines=args.command == "correlate")
            result = {"correlate": correlate, "matrix": matrix, "check": check, "candidates": candidates}[args.command](source)
            result["input_sha256"] = hashlib.sha256(Path(args.input).read_bytes()).hexdigest()
        text = json.dumps(result, ensure_ascii=False, indent=2)
        if args.output: Path(args.output).write_text(text, encoding="utf-8")
        else: print(text)
    except (ValueError, KeyError, TypeError, IndexError, OSError) as e:
        parser.exit(2, "workflow_tools: " + str(e) + "\n")


if __name__ == "__main__": main()
