#!/usr/bin/env python3
"""Measure tool-call support and latency across models.

Usage: python3 scripts/probes/probe_models.py [model ...]"""

from __future__ import annotations

import json
import sys
import time
import urllib.error
import urllib.request

PID = "gpu-waste-auditor-2026"
KEY = "AIzaSyAg8QbppwIYUzp0x9Jw74pzFx3UwKAS0vo"

DEFAULT_MODELS = [
    "gemini-3.5-flash-lite",
    "gemini-3.1-flash-lite",
    "gemini-3.8-flash",
]

TOOLS = [
    {
        "functionDeclarations": [
            {
                "name": "query_metrics",
                "description": "按条件查询集群节点的算力浪费指标。每次分析请先调用本工具取数。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "cloud": {"type": "string", "description": "云厂商，如 cloud-a"},
                        "limit": {"type": "integer", "description": "返回条数上限，默认 10"},
                    },
                },
            },
            {
                "name": "propose_action",
                "description": "登记一条优化建议。每给出一条建议都必须调用本工具登记。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string"},
                        "detail": {"type": "string"},
                        "expected_cost_recovery_cny": {"type": "number"},
                    },
                    "required": ["title", "detail"],
                },
            },
        ]
    }
]

PAYLOAD = {
    "contents": [
        {
            "role": "user",
            "parts": [
                {
                    "text": "请**并行**调用两个工具：query_metrics(cloud='cloud-a', limit=3) 与 "
                    "propose_action(title='回收超额预留', detail='对齐申请与峰值用量', "
                    "expected_cost_recovery_cny=12345)。只调用工具，不要输出文字。"
                }
            ],
        }
    ],
    "tools": TOOLS,
    "generationConfig": {"temperature": 0.2, "maxOutputTokens": 2048},
}


def probe(model: str) -> dict:
    url = (
        f"https://firebasevertexai.googleapis.com/v1beta/projects/{PID}"
        f"/models/{model}:generateContent"
    )
    body = json.dumps(PAYLOAD).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={"Content-Type": "application/json", "x-goog-api-key": KEY},
        method="POST",
    )
    t0 = time.time()
    out: dict = {"model": model}
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        out["http"] = 200
        out["sec"] = round(time.time() - t0, 1)
        usage = data.get("usageMetadata") or {}
        out["thoughts"] = usage.get("thoughtsTokenCount", 0)
        out["served"] = data.get("modelVersion")
        cands = data.get("candidates") or []
        parts = (cands[0].get("content") or {}).get("parts") or [] if cands else []
        calls = [p["functionCall"] for p in parts if p.get("functionCall")]
        out["calls"] = [(c.get("name"), c.get("args")) for c in calls]
        out["text"] = "".join(p.get("text", "") for p in parts if p.get("text"))[:100]
        out["finish"] = cands[0].get("finishReason") if cands else None
    except urllib.error.HTTPError as exc:
        out["http"] = exc.code
        out["sec"] = round(time.time() - t0, 1)
        out["error"] = exc.read().decode("utf-8", "replace")[:300]
    except Exception as exc:  # noqa: BLE001
        out["http"] = 0
        out["sec"] = round(time.time() - t0, 1)
        out["error"] = f"{type(exc).__name__}: {exc}"
    return out


if __name__ == "__main__":
    models = sys.argv[1:] or DEFAULT_MODELS
    results = []
    for m in models:
        r = probe(m)
        results.append(r)
        if r.get("calls"):
            names = ", ".join(n for n, _ in r["calls"])
            print(f"{m:<24} {r['http']} {r['sec']:>5}s  tool calls {len(r['calls'])}: {names}")
            for n, a in r["calls"]:
                print(f"      {n} {json.dumps(a, ensure_ascii=False)}")
        elif r["http"] == 200:
            print(f"Warning: {m:<24} 200 {r['sec']:>5}s  no tool calls; finish={r.get('finish')}, "
                  f"text={r.get('text')!r}")
        else:
            print(f"Error: {m:<24} HTTP {r['http']} {r['sec']:>5}s  {str(r.get('error'))[:200]}")
    print()
    print("=" * 78)
    print(json.dumps(results, ensure_ascii=False, indent=2)[:2500])
