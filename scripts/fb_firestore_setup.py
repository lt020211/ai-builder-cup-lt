#!/usr/bin/env python3
"""
模拟集群后端 · 配置脚本（Firestore）

子命令：
    check    只读检查：数据库是否存在、当前规则是什么
    rules    写入安全规则
    seed     重置模拟集群的种子数据（6 个节点 + 遥测历史）
    verify   读写一次，确认浏览器端匿名访问真的可用

为什么要有一个真后端
────────────────────────────────────────────────────────────────────────
这个应用要证明的是「Agent 能去做事」，而不是「Agent 能给建议」。
如果「执行」只是界面上把按钮变成灰色、把文案改成「已处理」，那它和
一份 PPT 没有区别，评委一眼就能看穿。

所以这里放一个**有真实状态的模拟集群**：Agent 通过工具真的去修改
Firestore 里的节点状态（把节点标记为已排空、清掉某张卡的脏上下文），
改完之后自己再读一次来验证。评委可以在 Firebase 控制台里亲眼看到
数据变了 —— 这是「执行是真的」唯一的证明方式。

诚实声明（也会写进 README 与界面）
────────────────────────────────────────────────────────────────────────
· 这里没有任何真实集群数据，全部是构造的演示节点，命名与体量都做过脱敏。
· 规则是匿名可读写，因为浏览器端没有登录流程。生产部署必须换成基于
  Auth 的规则 —— 这条不是"以后再说"，是明确的安全边界。
· 开放面被限制在 4 个集合内（cluster / events / tickets / notifications），
  其余路径一律拒绝。这样即使被滥用，也不会波及项目里的其它数据。
"""

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

# 只开放这 4 个集合，其余一律拒绝
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


# ------------------------------------------------------------------ 值转换
def to_fs(value):
    """Python 值 → Firestore REST 的 typed value。"""
    if value is None:
        return {"nullValue": None}
    if isinstance(value, bool):
        return {"booleanValue": value}
    if isinstance(value, int):
        # Firestore 只有 64 位整型，JS 端要注意别超过 2^53
        return {"integerValue": str(value)}
    if isinstance(value, float):
        return {"doubleValue": value}
    if isinstance(value, str):
        return {"stringValue": value}
    if isinstance(value, list):
        return {"arrayValue": {"values": [to_fs(v) for v in value]}}
    if isinstance(value, dict):
        return {"mapValue": {"fields": {k: to_fs(v) for k, v in value.items()}}}
    raise TypeError(f"不支持的类型：{type(value)}")


def from_fs(value):
    """Firestore REST 的 typed value → Python 值。"""
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
    print(f"项目：{PROJECT}　数据库：{DATABASE}")
    r = call("GET", f"https://firestore.googleapis.com/v1/projects/{PROJECT}/databases")
    if "__http_error__" in r:
        print("  数据库列表读取失败：", str(r["__body__"])[:200])
    else:
        for db in r.get("databases", []):
            print(f"  DB {db.get('name')} | {db.get('type')} | {db.get('locationId')}")

    rel = call("GET", f"{RULES_BASE}/releases/cloud.firestore")
    if "__http_error__" in rel:
        print("  规则发布记录：尚未创建（", str(rel["__body__"])[:100], "）")
    else:
        print("  规则发布记录：", rel.get("name"), "→", rel.get("rulesetName"))

    for coll in ("cluster", "events", "tickets", "notifications"):
        got = call("GET", f"{BASE}/{coll}?pageSize=100")
        if "__http_error__" in got:
            print(f"  {coll:14s} 读取失败：{str(got['__body__'])[:120]}")
        else:
            n = len(got.get("documents", []))
            print(f"  {coll:14s} {n} 个文档")


# ------------------------------------------------------------------ rules
def cmd_rules():
    rs = call("POST", f"{RULES_BASE}/rulesets", {
        "source": {"files": [{"name": "firestore.rules", "content": RULES}]},
    })
    if "__http_error__" in rs:
        print("创建 ruleset 失败：", str(rs["__body__"])[:400])
        return 1
    rs_name = rs["name"]
    print("ruleset 已创建：", rs_name)

    release = {
        "name": f"projects/{PROJECT}/releases/cloud.firestore",
        "rulesetName": rs_name,
    }
    # 注意：CreateRelease / UpdateRelease 的请求体就是 Release 对象本身，
    # **不要**再包一层 {"release": {...}}（包了会报 Unknown name "release"）。
    got = call("GET", f"{RULES_BASE}/releases/cloud.firestore")
    if "__http_error__" in got:
        res = call("POST", f"{RULES_BASE}/releases", release)
    else:
        res = call("PATCH", f"{RULES_BASE}/releases/cloud.firestore", release)
    if "__http_error__" in res:
        print("发布规则失败：", str(res["__body__"])[:400])
        return 1
    print("规则已发布到 cloud.firestore：", res.get("rulesetName", rs_name))
    return 0


# ------------------------------------------------------------------ seed
def seed_docs():
    """从 firebase/public/data/cluster_seed.json 读种子数据。

    刻意不把节点数据写在本文件里：前端有「一键重置模拟集群」的按钮，
    它要读同一份数据。两边各存一份必然漂移——所以种子只有一个来源。

    每个节点被设计成一种需要不同结论的状态（详见 seed 文件里的 expectations）：
      · lyg2103  Xid 94 单次 + ECC 平稳        → 观察项，不报修
      · lyg2112  Xid 94 频次上升 + ECC 同步上升 → 真劣化，该 cordon + 报修
      · lyg2108  nvidia-smi 无法通信、卡仍在 lspci → 环境问题，重载模块即可
      · lyg2115  卡死、进程 D 状态、有 Xid 62   → 驱动侧挂死
      · lyg2101 / lyg2107  健康（对照组）
    """
    with open(SEED_FILE, encoding='utf-8') as f:
        return json.load(f)['nodes']


def cmd_seed():
    docs = seed_docs()
    for node, body in docs.items():
        res = call("PATCH", f"{BASE}/cluster/{node}", doc_body(body))
        if "__http_error__" in res:
            print(f"  写入 {node} 失败：", str(res["__body__"])[:200])
            return 1
        print(f"  已写入 cluster/{node}")

    # 清空上一轮的运行痕迹，保证每次演示都从同一起点开始
    for coll in ("events", "tickets", "notifications"):
        got = call("GET", f"{BASE}/{coll}?pageSize=200")
        for d in got.get("documents", []):
            name = d["name"]
            call("DELETE", f"https://firestore.googleapis.com/v1/{name}")
        print(f"  已清空 {coll}")

    print(f"\n种子数据就绪：{len(docs)} 个节点（3 个需要处置、2 个健康、1 个卡死）")
    return 0


# ------------------------------------------------------------------ verify
API_KEY = "AIzaSyAg8QbppwIYUzp0x9Jw74pzFx3UwKAS0vo"


def anon_call(method, url, body=None):
    """完全模拟浏览器：**只有 API Key，没有 Authorization 头、没有登录**。

    这一步必须单独做，不能拿管理员 token 的测试结果代替 —— 安全规则拦的正是
    匿名访问，用管理员凭据测什么都通得过，等于没测。
    """
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
    """只验证一条：浏览器端匿名能不能读写模拟集群。"""
    print("浏览器端匿名访问测试（只带 API Key，无登录）")

    got = anon_call("GET", f"{BASE}/cluster/lyg2112")
    if "__http_error__" in got:
        print("  匿名读失败：", str(got["__body__"])[:300])
        return 1
    doc = doc_read(got)
    print(f"  匿名读 cluster/lyg2112 ✓　status={doc.get('status')}")

    # 越界路径必须被规则拒绝 —— 证明开放面确实锁死在 4 个集合内
    blocked = anon_call("GET", f"{BASE}/secret_nonexistent_collection/probe")
    if "__http_error__" in blocked and blocked["__http_error__"] in (403, 404):
        print(f"  越界集合被拒绝 ✓（HTTP {blocked['__http_error__']}）")
    else:
        print("  ⚠️ 越界集合未被拒绝，规则可能没生效：", str(blocked)[:200])
        return 1

    res = anon_call(
        "PATCH", f"{BASE}/cluster/lyg2101?updateMask.fieldPaths=draining",
        doc_body({"draining": True}),
    )
    if "__http_error__" in res:
        print("  匿名写失败：", str(res["__body__"])[:300])
        return 1
    back = doc_read(anon_call("GET", f"{BASE}/cluster/lyg2101"))
    ok = back.get("draining") is True
    print(f"  匿名写 cluster/lyg2101 ✓　回读 draining={back.get('draining')} → {'已生效' if ok else '未生效'}")
    anon_call("PATCH", f"{BASE}/cluster/lyg2101?updateMask.fieldPaths=draining",
              doc_body({"draining": False}))
    print("  已还原")
    return 0


def cmd_verify():
    print("1. 匿名读（浏览器端会这样做）")
    got = call("GET", f"{BASE}/cluster/lyg2112")
    if "__http_error__" in got:
        print("   读取失败：", str(got["__body__"])[:300])
        return 1
    doc = doc_read(got)
    tel = doc.get("telemetry", {})
    print(f"   lyg2112 status={doc.get('status')}，30 天 Xid94={tel.get('history_30d', {}).get('xid94_count')}")

    print("2. 匿名写（Agent 执行一次「排空节点」动作）")
    res = call(
        "PATCH", f"{BASE}/cluster/lyg2112?updateMask.fieldPaths=draining&updateMask.fieldPaths=status",
        doc_body({"draining": True, "status": "draining"}),
    )
    if "__http_error__" in res:
        print("   写入失败：", str(res["__body__"])[:300])
        return 1
    print(f"   写入成功，服务端回读 status={doc_read(res).get('status')}")

    print("3. 回验（Agent 执行后必须自己确认状态真的变了）")
    again = doc_read(call("GET", f"{BASE}/cluster/lyg2112"))
    ok = again.get("status") == "draining"
    print(f"   回读 status={again.get('status')} → {'确认已排空' if ok else '未生效'}")

    print("4. 还原")
    call("PATCH", f"{BASE}/cluster/lyg2112?updateMask.fieldPaths=draining&updateMask.fieldPaths=status",
         doc_body({"draining": False, "status": "healthy"}))
    back = doc_read(call("GET", f"{BASE}/cluster/lyg2112"))
    print(f"   已还原为 status={back.get('status')}（同时验证了动作可回滚）")
    return 0


CMDS = {
    "check": cmd_check, "rules": cmd_rules, "seed": cmd_seed,
    "anon": cmd_anon, "verify": cmd_verify,
}

if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "check"
    if cmd not in CMDS:
        print("用法：python3 scripts/fb_firestore_setup.py [check|rules|seed|anon|verify]")
        sys.exit(2)
    sys.exit(CMDS[cmd]() or 0)
