#!/usr/bin/env python3
"""验证 AI Logic 的「工具调用」与「思考预算」两个关键点。

背景（2026-10-14 实测）：
  - 端点鉴权**必须用 header** `x-goog-api-key`；用 `?key=` 会被边缘直接 400。
  - gemini-3.8-flash 是思考模型：thoughtsTokenCount 会吃掉 maxOutputTokens，
    给 64 会直接 MAX_TOKENS 且 content 为空 —— 必须给足，否则看不到任何输出。
  - 返回里带 thoughtSignature，思考模型的工具调用需要回传该字段。

用法：python3 scripts/probe_ailogic.py
"""

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
    "A. 工具调用（maxOutputTokens=2048）": {
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
    "B. 关思考（thinkingBudget=0）": {
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
        print(f"HTTP 200  耗时 {dt:.1f}s  思考token={usage.get('thoughtsTokenCount', 0)}  "
              f"输出token={usage.get('candidatesTokenCount', 0)}")
        if not cands:
            print("!! 无 candidates:", json.dumps(data, ensure_ascii=False)[:400])
            return
        c0 = cands[0]
        parts = (c0.get("content") or {}).get("parts") or []
        calls = [p["functionCall"] for p in parts if p.get("functionCall")]
        texts = [p.get("text", "") for p in parts if p.get("text")]
        if calls:
            print(f"✅ 工具调用成功，共 {len(calls)} 次：")
            for c in calls:
                print("   -", c.get("name"), json.dumps(c.get("args"), ensure_ascii=False))
            has_sig = any(p.get("thoughtSignature") for p in parts)
            print("   带 thoughtSignature:", has_sig)
        elif texts:
            print("   文本回复:", "".join(texts)[:120])
        else:
            print("   ⚠️ 既无 functionCall 也无 text；finishReason =", c0.get("finishReason"))
    except urllib.error.HTTPError as exc:
        print(f"HTTP {exc.code}  耗时 {time.time() - t0:.1f}s")
        print(exc.read().decode("utf-8", "replace")[:700])
    except Exception as exc:  # noqa: BLE001
        print(f"!! {type(exc).__name__}: {exc}  耗时 {time.time() - t0:.1f}s")


if __name__ == "__main__":
    for label, payload in CASES.items():
        run(label, payload)
