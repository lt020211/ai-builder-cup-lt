#!/usr/bin/env python3
"""Check complete model/tool round trips for the model fallback list.

Both turns must return HTTP 200, and the second must return nonempty text.
Send functionResponse parts with role=user and preserve model parts, including
thoughtSignature. Some models reject role=function.
Usage: python3 scripts/probes/probe_tool_roundtrip.py [model ...]"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request

PID = "gpu-waste-auditor-2026"
KEY = "AIzaSyAg8QbppwIYUzp0x9Jw74pzFx3UwKAS0vo"

MODELS = [
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3.8-flash",
    "gemini-3.5-flash",
]

TOOLS = [
    {
        "functionDeclarations": [
            {
                "name": "query_metrics",
                "description": "按条件查询集群节点的算力浪费指标，返回浪费金额最高的节点。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "pattern": {"type": "string", "description": "浪费模式"},
                    },
                },
            }
        ]
    }
]


RESPONSE_ROLE = "user"


def post(model: str, payload: dict) -> tuple[int, dict, str]:
    url = (
        f"https://firebasevertexai.googleapis.com/v1beta/projects/{PID}"
        f"/models/{model}:generateContent"
    )
    req = urllib.request.Request(
        url,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json", "x-goog-api-key": KEY},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            return resp.status, json.loads(resp.read().decode("utf-8")), ""
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            return exc.code, json.loads(raw), raw
        except Exception:  # noqa: BLE001
            return exc.code, {}, raw
    except Exception as exc:  # noqa: BLE001
        return 0, {}, f"{type(exc).__name__}: {exc}"


def probe(model: str) -> dict:
    out: dict = {"model": model}
    turn1 = {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {
                        "text": "请调用 query_metrics（参数 pattern='idle'），"
                        "拿到返回结果后用一句话说明匹配到几个节点。"
                    }
                ],
            }
        ],
        "tools": TOOLS,
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": 2048},
    }

    t0 = time.time()
    status, data, raw = post(model, turn1)
    if status != 200:
        out["error"] = f"Turn 1 HTTP {status}: {raw[:200]}"
        return out

    cands = data.get("candidates") or []
    parts = (cands[0].get("content") or {}).get("parts") or [] if cands else []
    calls = [p["functionCall"] for p in parts if p.get("functionCall")]
    out["turn1_calls"] = [c.get("name") for c in calls]
    if not calls:
        out["error"] = "Turn 1 returned no functionCall"
        return out


    turn2 = {
        "contents": turn1["contents"]
        + [
            {"role": "model", "parts": parts},
            {
                "role": RESPONSE_ROLE,
                "parts": [
                    {
                        "functionResponse": {
                            "name": calls[0].get("name"),
                            "response": {
                                "result": {
                                    "matched": 1,
                                    "nodes": [
                                        {"node": "node-a02", "gpu_type": "H800",
                                         "waste_cost_cny": 31127.04, "avg_util_pct": 3.5}
                                    ],
                                    "total_waste_cost_cny": 31127.04,
                                }
                            },
                        }
                    }
                ],
            },
        ],
        "tools": TOOLS,
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": 2048},
    }

    status2, data2, raw2 = post(model, turn2)
    out["sec"] = round(time.time() - t0, 1)
    if status2 != 200:
        out["error"] = f"Turn 2 HTTP {status2}: {raw2[:220]}"
        return out

    cands2 = data2.get("candidates") or []
    parts2 = (cands2[0].get("content") or {}).get("parts") or [] if cands2 else []
    text = "".join(p.get("text", "") for p in parts2 if p.get("text")).strip()
    out["turn2_text"] = text[:200]
    out["ok"] = bool(text)
    if not text:
        out["error"] = (
            f"Turn 2 HTTP 200 but text is empty (finishReason="
            f"{cands2[0].get('finishReason') if cands2 else '?'})"
        )
    return out


if __name__ == "__main__":
    models = sys.argv[1:] or MODELS
    results = []
    for m in models:
        print("=" * 78)
        print(m)
        try:
            r = probe(m)
        except Exception as exc:  # noqa: BLE001
            r = {"model": m, "ok": False, "error": f"{type(exc).__name__}: {exc}"}
        results.append(r)
        if r.get("ok"):
            print(f"  Round trip succeeded in {r['sec']}s; turn 2 response: {r['turn2_text'][:110]!r}")
        else:
            print(f"  Error: {r.get('error')}")

    print()
    print("=" * 78)
    print(f"Summary (response role fixed to role=\"{RESPONSE_ROLE}\")")
    for r in results:
        print(f"  {'PASS' if r.get('ok') else 'FAIL'} {r['model']:<24} "
              f"{str(r.get('sec', '')) + 's' if r.get('sec') else ''}")
    usable = [r["model"] for r in results if r.get("ok")]
    print()
    print("Available models (frontend fallback order):")
    print("  " + json.dumps(usable, ensure_ascii=False))
