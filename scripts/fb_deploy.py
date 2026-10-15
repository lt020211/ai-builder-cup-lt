#!/usr/bin/env python3
"""Deploy a static directory to Firebase Hosting through the REST API.

Use the current gcloud access token. Create a version, submit compressed file hashes,
upload missing files, finalize the version, and release it.
Usage: python3 scripts/fb_deploy.py <public_dir> [--site <site_id>] [--project <project_id>]"""
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


# Hosting uses the last matching rule; versioned SDK files retain a longer cache.
DEFAULT_HEADERS = [
    {"glob": "**", "headers": {"Cache-Control": "no-cache"}},
    {"glob": "vendor/**", "headers": {"Cache-Control": "public, max-age=604800"}},
]


def access_token() -> str:
    """Read the current gcloud access token."""
    out = subprocess.run(
        [GCLOUD, "auth", "print-access-token"],
        capture_output=True,
        text=True,
        check=False,
    )
    token = out.stdout.strip()
    if not token:
        raise SystemExit(f"Access token unavailable. Run `{GCLOUD} auth login` first.\n{out.stderr}")
    return token


class Client:
    def __init__(self, project: str) -> None:
        self.project = project
        self.token = access_token()

    def _headers(self, extra: dict | None = None) -> dict:
        headers = {
            "Authorization": f"Bearer {self.token}",

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
    """Compress deterministically with mtime=0 so hash and upload bytes match."""
    return gzip.compress(data, mtime=0)


def collect_files(public_dir: Path) -> dict[str, tuple[bytes, str]]:
    """Return deployment paths mapped to compressed bytes and their SHA256 hashes."""
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
    """Upload gzip bytes without Content-Encoding; Hosting handles decompression."""
    client.request(
        "POST", url, packed, content_type="application/octet-stream", timeout=300
    )


def deploy(public_dir: Path, site: str, project: str) -> str:
    files = collect_files(public_dir)
    if not files:
        raise SystemExit(f"{public_dir} contains no files; refusing to deploy an empty site.")
    if "/index.html" not in files:
        raise SystemExit(f"{public_dir} is missing index.html, required by Firebase Hosting.")

    client = Client(project)

    print(f"[1/5] Create version ({len(files)} files)")
    version = client.request(
        "POST",
        f"{API}/sites/{site}/versions",
        {"config": {"headers": DEFAULT_HEADERS}},
    )
    version_name = version["name"]
    version_id = version_name.rsplit("/", 1)[-1]
    print(f"      version = {version_id}")

    print("[2/5] populateFiles (submit SHA256 hashes and request missing files)")
    hashes = {path: digest for path, (_, digest) in files.items()}
    populated = client.request(
        "POST", f"{API}/{version_name}:populateFiles", {"files": hashes}
    )
    upload_url = populated.get("uploadUrl")
    required = set(populated.get("uploadRequiredHashes") or [])
    print(f"      Server requested {len(required)} / {len(files)} files")

    if required:
        print("[3/5] Upload files (gzip)")
        by_hash = {digest: path for path, (_, digest) in files.items()}
        for index, digest in enumerate(sorted(required), start=1):
            path = by_hash.get(digest)
            if path is None:
                raise SystemExit(f"Server requested an unknown hash: {digest}")
            packed, _ = files[path]
            upload_one(client, f"{upload_url}/{digest}", packed)
            print(f"      [{index}/{len(required)}] {path}  ({len(packed)}B gzip)")
    else:
        print("[3/5] No upload needed (content matches the deployed version)")

    print("[4/5] finalize")


    client.request(
        "PATCH", f"{API}/{version_name}?updateMask=status", {"status": "FINALIZED"}
    )

    print("[5/5] release")
    release = client.request(
        "POST", f"{API}/sites/{site}/releases?versionName={version_name}", {}
    )
    url = release.get("name", "").split("/releases/")[0]
    domain = f"https://{site}.web.app"
    print(f"      Released -> {domain}")
    return domain


def main() -> int:
    parser = argparse.ArgumentParser(description="Deploy a static directory to Firebase Hosting")
    parser.add_argument("public_dir", type=Path)
    parser.add_argument("--site", default=DEFAULT_SITE)
    parser.add_argument("--project", default=DEFAULT_PROJECT)
    args = parser.parse_args()

    if not args.public_dir.is_dir():
        raise SystemExit(f"Directory not found: {args.public_dir}")
    deploy(args.public_dir.resolve(), args.site, args.project)
    return 0


if __name__ == "__main__":
    sys.exit(main())
