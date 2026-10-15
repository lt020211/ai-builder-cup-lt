#!/usr/bin/env python3
"""Probe AI Logic tool calls and thinking-budget support.

Use x-goog-api-key authentication and preserve thoughtSignature in tool round trips.
Thinking tokens count against maxOutputTokens.
Usage: python3 scripts/probes/probe_ailogic.py"""

from __future__ import annotations

import json
import time
import urllib.error
import urllib.request

PID = "gpu-waste-auditor-2026"
KEY = "AIzaSyAg8QbppwIYUzp0x9Jw74pzFx3UwKAS0vo"
MODEL = "gemini-3.8-flash"
URL = f"https://firebasevertexai.googleapis.com/v1beta/projects/{PID}/models/{MODEL}:generateContent"

TOOLS = [
    {
        "functionDeclarations": [
            {
                "name": "estimate_carbon",
                "description": "估算给定电耗在指定小时的碳排。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "energy_kwh": {"type": "number", "description": "电耗 kWh"},
                        "hour": {"type": "integer", "description": "小时 0-23"},
                    },
                    "required": ["energy_kwh", "hour"],
                },
            },
            {
                "name": "propose_action",
                "description": "登记一条优化建议。每条建议都必须调用本工具登记。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "title": {"type": "string"},
                        "detail": {"type": "string"},
                    },
                    "required": ["title", "detail"],
                },
            },
        ]
    }
]

CASES = {
    "A. Tool calls (maxOutputTokens=2048)": {
        "contents": [
            {
                "role": "user",
                "parts": [
                    {
                        "text": "请并行调用 estimate_carbon(energy_kwh=100, hour=19) 和 "
                        "propose_action(title='挪时段', detail='挪到 13 点')。只调用工具。"
                    }
                ],
            }
        ],
        "tools": TOOLS,
        "generationConfig": {"temperature": 0.2, "maxOutputTokens": 2048},
    },
    "B. Thinking disabled (thinkingBudget=0)": {
        "contents": [{"role": "user", "parts": [{"text": "只回复两个字：收到"}]}],
        "generationConfig": {
            "temperature": 0,
            "maxOutputTokens": 512,
            "thinkingConfig": {"thinkingBudget": 0},
        },
    },
}


def run(label: str, payload: dict) -> None:
    print("=" * 78)
    print(label)
    body = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(
        URL,
        data=body,
        headers={"Content-Type": "application/json", "x-goog-api-key": KEY},
        method="POST",
    )
    t0 = time.time()
    try:
        with urllib.request.urlopen(req, timeout=180) as resp:
            data = json.loads(resp.read().decode("utf-8"))
        dt = time.time() - t0
        cands = data.get("candidates") or []
        usage = data.get("usageMetadata") or {}
        print(f"HTTP 200  elapsed {dt:.1f}s  thinking tokens={usage.get('thoughtsTokenCount', 0)}  "
              f"output tokens={usage.get('candidatesTokenCount', 0)}")
        if not cands:
            print("!! No candidates:", json.dumps(data, ensure_ascii=False)[:400])
            return
        c0 = cands[0]
        parts = (c0.get("content") or {}).get("parts") or []
        calls = [p["functionCall"] for p in parts if p.get("functionCall")]
        texts = [p.get("text", "") for p in parts if p.get("text")]
        if calls:
            print(f"Tool calls succeeded: {len(calls)} calls:")
            for c in calls:
                print("   -", c.get("name"), json.dumps(c.get("args"), ensure_ascii=False))
            has_sig = any(p.get("thoughtSignature") for p in parts)
            print("   Includes thoughtSignature:", has_sig)
        elif texts:
            print("   Text response:", "".join(texts)[:120])
        else:
            print("   Warning: No functionCall or text; finishReason =", c0.get("finishReason"))
    except urllib.error.HTTPError as exc:
        print(f"HTTP {exc.code}  elapsed {time.time() - t0:.1f}s")
        print(exc.read().decode("utf-8", "replace")[:700])
    except Exception as exc:  # noqa: BLE001
        print(f"!! {type(exc).__name__}: {exc}  elapsed {time.time() - t0:.1f}s")


if __name__ == "__main__":
    for label, payload in CASES.items():
        run(label, payload)
