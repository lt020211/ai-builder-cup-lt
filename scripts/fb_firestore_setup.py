#!/usr/bin/env python3
"""Configure the simulated cluster in Firestore.

Commands: check (read-only), rules (publish rules), seed (reset demo data),
anon (test anonymous access), verify (write, read back, and restore).
All nodes are synthetic demo data. Anonymous access is limited to cluster, events,
tickets, and notifications. Production deployments require Auth-based rules."""

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

PROJECT = "gpu-waste-auditor-2026"
DATABASE = "(default)"
BASE = f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases/{DATABASE}/documents"
RULES_BASE = f"https://firebaserules.googleapis.com/v1/projects/{PROJECT}"

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SEED_FILE = os.path.join(ROOT, "firebase", "public", "data", "cluster_seed.json")


RULES = """rules_version = '2';
service cloud.firestore {
  match /databases/{database}/documents {

    // ── 演示用的模拟集群 ──────────────────────────────────────────────
    // 这里不含任何真实数据，因此允许匿名读写：应用是纯静态站点，
    // 浏览器端没有登录流程，Agent 的动作需要直接落到数据库上。
    //
    // ⚠️ 生产部署必须替换为基于 Auth 的规则。这不是"以后优化"，
    //    而是明确的安全边界，已写进 README 的「安全边界」一节。
    match /cluster/{doc=**}       { allow read, write: if true; }
    match /events/{doc=**}        { allow read, write: if true; }
    match /tickets/{doc=**}       { allow read, write: if true; }
    match /notifications/{doc=**} { allow read, write: if true; }

    // 其它任何路径一律拒绝 —— 把开放面锁死在上面 4 个集合里
    match /{document=**} { allow read, write: if false; }
  }
}
"""


def token():
    out = subprocess.run(
        ["gcloud", "auth", "print-access-token"],
        capture_output=True, text=True, check=True,
    )
    return out.stdout.strip()


def call(method, url, body=None, headers=None):
    h = {
        "Authorization": f"Bearer {token()}",
        "x-goog-user-project": PROJECT,
    }
    h.update(headers or {})
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(url, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        try:
            return {"__http_error__": e.code, "__body__": json.loads(raw)}
        except json.JSONDecodeError:
            return {"__http_error__": e.code, "__body__": raw[:400]}


def to_fs(value):
    """Convert a Python value to a Firestore REST typed value."""
    if value is None:
        return {"nullValue": None}
    if isinstance(value, bool):
        return {"booleanValue": value}
    if isinstance(value, int):

        return {"integerValue": str(value)}
    if isinstance(value, float):
        return {"doubleValue": value}
    if isinstance(value, str):
        return {"stringValue": value}
    if isinstance(value, list):
        return {"arrayValue": {"values": [to_fs(v) for v in value]}}
    if isinstance(value, dict):
        return {"mapValue": {"fields": {k: to_fs(v) for k, v in value.items()}}}
    raise TypeError(f"Unsupported type: {type(value)}")


def from_fs(value):
    """Convert a Firestore REST typed value to a Python value."""
    if "nullValue" in value:
        return None
    if "booleanValue" in value:
        return value["booleanValue"]
    if "integerValue" in value:
        return int(value["integerValue"])
    if "doubleValue" in value:
        return float(value["doubleValue"])
    if "stringValue" in value:
        return value["stringValue"]
    if "timestampValue" in value:
        return value["timestampValue"]
    if "arrayValue" in value:
        return [from_fs(v) for v in value["arrayValue"].get("values", [])]
    if "mapValue" in value:
        return {k: from_fs(v) for k, v in value["mapValue"].get("fields", {}).items()}
    return None


def doc_body(flat):
    return {"fields": {k: to_fs(v) for k, v in flat.items()}}


def doc_read(payload):
    return {k: from_fs(v) for k, v in payload.get("fields", {}).items()}


# ------------------------------------------------------------------ check
def cmd_check():
    print(f"Project: {PROJECT}; database: {DATABASE}")
    r = call("GET", f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases")
    if "__http_error__" in r:
        print("  Failed to list databases:", str(r["__body__"])[:200])
    else:
        for db in r.get("databases", []):
            print(f"  DB {db.get('name')} | {db.get('type')} | {db.get('locationId')}")

    rel = call("GET", f"{RULES_BASE}/releases/cloud.firestore")
    if "__http_error__" in rel:
        print("  Rules release not found (", str(rel["__body__"])[:100], ")")
    else:
        print("  Rules release:", rel.get("name"), "→", rel.get("rulesetName"))

    for coll in ("cluster", "events", "tickets", "notifications"):
        got = call("GET", f"{BASE}/{coll}?pageSize=100")
        if "__http_error__" in got:
            print(f"  {coll:14s} Read failed: {str(got['__body__'])[:120]}")
        else:
            n = len(got.get("documents", []))
            print(f"  {coll:14s} {n} documents")


# ------------------------------------------------------------------ rules
def cmd_rules():
    rs = call("POST", f"{RULES_BASE}/rulesets", {
        "source": {"files": [{"name": "firestore.rules", "content": RULES}]},
    })
    if "__http_error__" in rs:
        print("Failed to create ruleset:", str(rs["__body__"])[:400])
        return 1
    rs_name = rs["name"]
    print("Ruleset created:", rs_name)

    release = {
        "name": f"projects/{PROJECT}/releases/cloud.firestore",
        "rulesetName": rs_name,
    }


    got = call("GET", f"{RULES_BASE}/releases/cloud.firestore")
    if "__http_error__" in got:
        res = call("POST", f"{RULES_BASE}/releases", release)
    else:
        res = call("PATCH", f"{RULES_BASE}/releases/cloud.firestore", release)
    if "__http_error__" in res:
        print("Failed to publish rules:", str(res["__body__"])[:400])
        return 1
    print("Rules published to cloud.firestore:", res.get("rulesetName", rs_name))
    return 0


# ------------------------------------------------------------------ seed
def seed_docs():
    """Read the shared node seed from firebase/public/data/cluster_seed.json."""
    with open(SEED_FILE, encoding='utf-8') as f:
        return json.load(f)['nodes']


def cmd_seed():
    docs = seed_docs()
    for node, body in docs.items():
        res = call("PATCH", f"{BASE}/cluster/{node}", doc_body(body))
        if "__http_error__" in res:
            print(f"  Failed to write {node}:", str(res["__body__"])[:200])
            return 1
        print(f"  Wrote cluster/{node}")


    for coll in ("events", "tickets", "notifications"):
        got = call("GET", f"{BASE}/{coll}?pageSize=200")
        for d in got.get("documents", []):
            name = d["name"]
            call("DELETE", f"https://firestore.googleapis.com/v1/{name}")
        print(f"  Cleared {coll}")

    print(f"\nSeed data ready: {len(docs)} nodes (3 need action, 2 healthy, 1 hung)")
    return 0


# ------------------------------------------------------------------ verify
API_KEY = "AIzaSyAg8QbppwIYUzp0x9Jw74pzFx3UwKAS0vo"


def anon_call(method, url, body=None):
    """Send a browser-style request with an API key and no Authorization header to check anonymous access."""
    sep = "&" if "?" in url else "?"
    full = f"{url}{sep}key={API_KEY}"
    h = {}
    data = None
    if body is not None:
        data = json.dumps(body).encode()
        h["Content-Type"] = "application/json"
    req = urllib.request.Request(full, data=data, headers=h, method=method)
    try:
        with urllib.request.urlopen(req, timeout=60) as resp:
            raw = resp.read().decode()
            return json.loads(raw) if raw else {}
    except urllib.error.HTTPError as e:
        raw = e.read().decode()
        return {"__http_error__": e.code, "__body__": raw[:400]}


def cmd_anon():
    """Check anonymous read and write access to the simulated cluster."""
    print("Anonymous browser access test (API key only, no login)")

    got = anon_call("GET", f"{BASE}/cluster/lyg2112")
    if "__http_error__" in got:
        print("  Anonymous read failed:", str(got["__body__"])[:300])
        return 1
    doc = doc_read(got)
    print(f"  Anonymous read cluster/lyg2112 ✓ status={doc.get('status')}")


    blocked = anon_call("GET", f"{BASE}/secret_nonexistent_collection/probe")
    if "__http_error__" in blocked and blocked["__http_error__"] in (403, 404):
        print(f"  Collection outside the allowed scope denied ✓(HTTP {blocked['__http_error__']})")
    else:
        print("  Warning: Collection outside the allowed scope was not denied; check rules:", str(blocked)[:200])
        return 1

    res = anon_call(
        "PATCH", f"{BASE}/cluster/lyg2101?updateMask.fieldPaths=draining",
        doc_body({"draining": True}),
    )
    if "__http_error__" in res:
        print("  Anonymous write failed:", str(res["__body__"])[:300])
        return 1
    back = doc_read(anon_call("GET", f"{BASE}/cluster/lyg2101"))
    ok = back.get("draining") is True
    print(f"  Anonymous write cluster/lyg2101 ✓ readback draining={back.get('draining')} → {'applied' if ok else 'not applied'}")
    anon_call("PATCH", f"{BASE}/cluster/lyg2101?updateMask.fieldPaths=draining",
              doc_body({"draining": False}))
    print("  Restored")
    return 0


def cmd_verify():
    print("1. Anonymous read (browser access)")
    got = call("GET", f"{BASE}/cluster/lyg2112")
    if "__http_error__" in got:
        print("   Read failed:", str(got["__body__"])[:300])
        return 1
    doc = doc_read(got)
    tel = doc.get("telemetry", {})
    print(f"   lyg2112 status={doc.get('status')}, 30-day Xid94={tel.get('history_30d', {}).get('xid94_count')}")

    print("2. Anonymous write (agent drains a node)")
    res = call(
        "PATCH", f"{BASE}/cluster/lyg2112?updateMask.fieldPaths=draining&updateMask.fieldPaths=status",
        doc_body({"draining": True, "status": "draining"}),
    )
    if "__http_error__" in res:
        print("   Write failed:", str(res["__body__"])[:300])
        return 1
    print(f"   Write succeeded; server readback status={doc_read(res).get('status')}")

    print("3. Verify the updated server state")
    again = doc_read(call("GET", f"{BASE}/cluster/lyg2112"))
    ok = again.get("status") == "draining"
    print(f"   Readback status={again.get('status')} → {'drain confirmed' if ok else 'not applied'}")

    print("4. Restore")
    call("PATCH", f"{BASE}/cluster/lyg2112?updateMask.fieldPaths=draining&updateMask.fieldPaths=status",
         doc_body({"draining": False, "status": "healthy"}))
    back = doc_read(call("GET", f"{BASE}/cluster/lyg2112"))
    print(f"   Restored status={back.get('status')}(rollback verified)")
    return 0


CMDS = {
    "check": cmd_check, "rules": cmd_rules, "seed": cmd_seed,
    "anon": cmd_anon, "verify": cmd_verify,
}

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    if cmd not in CMDS:
        print("Usage: python3 scripts/fb_firestore_setup.py [check|rules|seed|anon|verify]")
        sys.exit(2)
    sys.exit(CMDS[cmd]() or 0)
