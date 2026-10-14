#!/usr/bin/env python3
"""把静态目录发布到 Firebase Hosting（纯 REST，不依赖 firebase CLI）。

为什么不用 firebase CLI：本机没有装，且 CLI 需要一个交互式 OAuth 登录流程；
而 gcloud 已经登录好了，直接用它的 access token 打 REST 接口最省事。

用法：
    python3 scripts/fb_deploy.py <public_dir> [--site SITE] [--project PID]

发布流程（官方 Hosting REST API v1beta1）：
    1. 创建 version
    2. populateFiles —— 提交每个文件的 sha256，服务端告诉我们哪些需要上传
    3. 逐个上传（内容是 gzip 后的字节）
    4. finalize
    5. release
"""
from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import subprocess
import sys
import urllib.error
import urllib.request
from pathlib import Path

DEFAULT_PROJECT = "gpu-waste-auditor-2026"
DEFAULT_SITE = "gpu-waste-auditor-2026"
API = "https://firebasehosting.googleapis.com/v1beta1"
GCLOUD = str(Path.home() / "google-cloud-sdk" / "bin" / "gcloud")

# Hosting 默认给静态资源发 max-age=3600。对演示型应用这是坑：
# 重新发布后浏览器仍用缓存里的旧 JS，改了代码却「看起来没生效」，
# 白白花时间怀疑逻辑。所以这里显式改成 no-cache（仍走 ETag，命中时是 304）。
#
# 顺序有讲究：Hosting 是**后匹配的规则生效**，所以先用 `**` 兜底成全站 no-cache，
# 再用 `vendor/**` 把有版本的 Firebase SDK 覆盖成长缓存。
# 另外 `/` 这个根路径不会被 `**/*.html` 匹配到——踩过这个坑，所以用 `**` 兜底。
DEFAULT_HEADERS = [
    {"glob": "**", "headers": {"Cache-Control": "no-cache"}},
    {"glob": "vendor/**", "headers": {"Cache-Control": "public, max-age=604800"}},
]


def access_token() -> str:
    """取 gcloud 当前的 access token。"""
    out = subprocess.run(
        [GCLOUD, "auth", "print-access-token"],
        capture_output=True,
        text=True,
        check=False,
    )
    token = out.stdout.strip()
    if not token:
        raise SystemExit(f"拿不到 access token，先跑一次 `{GCLOUD} auth login`。\n{out.stderr}")
    return token


class Client:
    def __init__(self, project: str) -> None:
        self.project = project
        self.token = access_token()

    def _headers(self, extra: dict | None = None) -> dict:
        headers = {
            "Authorization": f"Bearer {self.token}",
            # 不带这个头会报「ADC quota project 未设置」，是 Firebase 侧的硬要求
            "x-goog-user-project": self.project,
        }
        headers.update(extra or {})
        return headers

    def request(self, method: str, url: str, body: dict | bytes | None = None,
                content_type: str = "application/json", timeout: int = 120,
                raw: bool = False, extra_headers: dict | None = None) -> dict:
        if body is None:
            data = None
        elif isinstance(body, bytes):
            data = body
        else:
            data = json.dumps(body).encode("utf-8")

        headers = self._headers({"Content-Type": content_type} if data is not None else None)
        headers.update(extra_headers or {})
        request = urllib.request.Request(url, data=data, headers=headers, method=method)
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = response.read().decode("utf-8")
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", "replace")
            raise SystemExit(f"HTTP {exc.code} {method} {url}\n{detail}") from exc
        if raw or not payload:
            return {}
        return json.loads(payload)


def gz_bytes(data: bytes) -> bytes:
    """确定性的 gzip 压缩。

    **必须固定 mtime=0**：gzip.compress 默认会把当前时间写进头部，
    同一份内容两次调用会得到不同字节 —— 而我们要在同一份字节上
    既算哈希又做上传，只要两次拿到的不一样就会被服务端判定
    `content hash doesn't match content`。这个坑踩过一次，务必保留 mtime=0。
    """
    return gzip.compress(data, mtime=0)


def collect_files(public_dir: Path) -> dict[str, tuple[bytes, str]]:
    """返回 {部署路径: (gzip 后的字节, sha256)}。

    官方文档要求「先 gzip，再对压缩后的字节取 SHA256」：
        Calculate a hash by Gzipping the file then taking the SHA256 hash of
        the newly compressed file.
    用原始内容的哈希会被服务端拒绝。
    """
    files: dict[str, tuple[bytes, str]] = {}
    for path in sorted(public_dir.rglob("*")):
        if not path.is_file():
            continue
        if path.name.startswith(".") or "__pycache__" in path.parts:
            continue
        deploy_path = "/" + str(path.relative_to(public_dir)).replace("\\", "/")
        packed = gz_bytes(path.read_bytes())
        files[deploy_path] = (packed, hashlib.sha256(packed).hexdigest())
    return files


def upload_one(client: "Client", url: str, packed: bytes) -> None:
    """上传单个文件：传 **gzip 压缩后的字节**。

    实测（2026-10-14）三种形式的结果：
        gzip 字节 + application/octet-stream            -> 200 OK  ✅
        gzip 字节 + application/octet-stream + Content-Encoding: gzip -> 400
        原始字节                                         -> 400
    所以这里**不能**带 Content-Encoding —— 服务端自己就是按 gzip 处理的。
    """
    client.request(
        "POST", url, packed, content_type="application/octet-stream", timeout=300
    )


def deploy(public_dir: Path, site: str, project: str) -> str:
    files = collect_files(public_dir)
    if not files:
        raise SystemExit(f"{public_dir} 里没有文件，拒绝发布空站点。")
    if "/index.html" not in files:
        raise SystemExit(f"{public_dir} 缺少 index.html，Firebase Hosting 需要一个入口。")

    client = Client(project)

    print(f"[1/5] 创建 version（{len(files)} 个文件）")
    version = client.request(
        "POST",
        f"{API}/sites/{site}/versions",
        {"config": {"headers": DEFAULT_HEADERS}},
    )
    version_name = version["name"]
    version_id = version_name.rsplit("/", 1)[-1]
    print(f"      version = {version_id}")

    print("[2/5] populateFiles（提交 sha256，询问需要上传哪些）")
    hashes = {path: digest for path, (_, digest) in files.items()}
    populated = client.request(
        "POST", f"{API}/{version_name}:populateFiles", {"files": hashes}
    )
    upload_url = populated.get("uploadUrl")
    required = set(populated.get("uploadRequiredHashes") or [])
    print(f"      服务端要求上传 {len(required)} / {len(files)} 个文件")

    if required:
        print("[3/5] 上传文件（gzip）")
        by_hash = {digest: path for path, (_, digest) in files.items()}
        for index, digest in enumerate(sorted(required), start=1):
            path = by_hash.get(digest)
            if path is None:
                raise SystemExit(f"服务端要求了一个未知 hash：{digest}")
            packed, _ = files[path]
            upload_one(client, f"{upload_url}/{digest}", packed)
            print(f"      [{index}/{len(required)}] {path}  ({len(packed)}B gzip)")
    else:
        print("[3/5] 无需上传（内容与线上一致）")

    print("[4/5] finalize")
    # 注意：REST 里**没有** `versions/{id}:finalize` 这个自定义方法（会 404）。
    # 正确做法是用 PATCH 把 status 改成 FINALIZED —— firebase-tools 内部也是这么做的。
    client.request(
        "PATCH", f"{API}/{version_name}?updateMask=status", {"status": "FINALIZED"}
    )

    print("[5/5] release")
    release = client.request(
        "POST", f"{API}/sites/{site}/releases?versionName={version_name}", {}
    )
    url = release.get("name", "").split("/releases/")[0]
    domain = f"https://{site}.web.app"
    print(f"      发布完成 -> {domain}")
    return domain


def main() -> int:
    parser = argparse.ArgumentParser(description="发布静态目录到 Firebase Hosting")
    parser.add_argument("public_dir", type=Path)
    parser.add_argument("--site", default=DEFAULT_SITE)
    parser.add_argument("--project", default=DEFAULT_PROJECT)
    args = parser.parse_args()

    if not args.public_dir.is_dir():
        raise SystemExit(f"目录不存在：{args.public_dir}")
    deploy(args.public_dir.resolve(), args.site, args.project)
    return 0


if __name__ == "__main__":
    sys.exit(main())
