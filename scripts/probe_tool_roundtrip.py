#!/usr/bin/env python3
"""验证模型是否支持**完整的工具调用往返**，并据此决定前端的模型降级链。

为什么必须测往返：
  最初只测「模型能否发出 functionCall」时，gemini-3.5-flash-lite 顺利通过
  （2 次并行调用、1.5s）。可上真机却报：
      400 Role 'function' is not supported.
  也就是说它**能发不能收**——第二回合把工具结果回传时被拒。
  只测「能发」会得出完全错误的结论。

★ 关键发现（2026-10-14 实测）★
  新版模型**不再接受 `role: "function"`**。服务端给出的合法角色是
  SYSTEM / USER / ASSISTANT / DEVELOPER / CONTEXT / MODEL 等，没有 function。
  把工具结果放进 `role: "user"` 的 functionResponse part 里，各模型都接受；
  且 `role: "function"` 只有 gemini-3.1-flash-lite 还兼容。

  → 这直接影响实现：Firebase AI Logic 的 JS SDK（ChatSession）**写死了
    role: "function"**，所以在这些模型上第二回合必失败。前端因此改用
    原生 fetch 直接打 REST，自己控制角色。

判定标准：两个回合都 200，且第二回合产出**非空文本**（说明模型真的消化了工具结果）。

用法：python3 scripts/probe_tool_roundtrip.py [model ...]
"""

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

# 工具结果的回传角色。user 是实测唯一对所有模型都通用的写法。
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
        out["error"] = f"第1回合 HTTP {status}: {raw[:200]}"
        return out

    cands = data.get("candidates") or []
    parts = (cands[0].get("content") or {}).get("parts") or [] if cands else []
    calls = [p["functionCall"] for p in parts if p.get("functionCall")]
    out["turn1_calls"] = [c.get("name") for c in calls]
    if not calls:
        out["error"] = "第1回合没有 functionCall"
        return out

    # 原样回传模型产出的 parts（含 thoughtSignature），工具结果放进 role=user
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
        out["error"] = f"第2回合 HTTP {status2}: {raw2[:220]}"
        return out

    cands2 = data2.get("candidates") or []
    parts2 = (cands2[0].get("content") or {}).get("parts") or [] if cands2 else []
    text = "".join(p.get("text", "") for p in parts2 if p.get("text")).strip()
    out["turn2_text"] = text[:200]
    out["ok"] = bool(text)
    if not text:
        out["error"] = (
            f"第2回合 200 但文本为空（finishReason="
            f"{cands2[0].get('finishReason') if cands2 else '?'}）"
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
            print(f"  ✅ 完整往返可用，{r['sec']}s，第2回合结论：{r['turn2_text'][:110]!r}")
        else:
            print(f"  ❌ {r.get('error')}")

    print()
    print("=" * 78)
    print(f"汇总（回传角色固定为 role=\"{RESPONSE_ROLE}\"）")
    for r in results:
        print(f"  {'✅' if r.get('ok') else '❌'} {r['model']:<24} "
              f"{str(r.get('sec', '')) + 's' if r.get('sec') else ''}")
    usable = [r["model"] for r in results if r.get("ok")]
    print()
    print("可用的模型（写入前端降级链的顺序）:")
    print("  " + json.dumps(usable, ensure_ascii=False))
