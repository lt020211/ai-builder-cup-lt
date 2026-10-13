"""Flask 应用：Web 入口 + JSON API。"""

from __future__ import annotations

import json
import os
from pathlib import Path

from flask import Flask, jsonify, render_template, request

from src.ai import diagnose
from src.analyzer import analyze_batch

BASE_DIR = Path(__file__).resolve().parent.parent
SAMPLE_PATH = BASE_DIR / "data" / "sample_metrics.json"

app = Flask(__name__, template_folder=str(BASE_DIR / "src" / "templates"))
app.config["JSON_AS_ASCII"] = False


def load_sample() -> dict:
    return json.loads(SAMPLE_PATH.read_text(encoding="utf-8"))


@app.get("/healthz")
def healthz():
    return jsonify({"status": "ok"})


@app.get("/")
def index():
    return render_template("index.html")


@app.get("/api/sample")
def api_sample():
    return jsonify(load_sample())


@app.post("/api/analyze")
def api_analyze():
    payload = request.get_json(silent=True) or {}
    records = payload.get("records")
    window = payload.get("window")
    if not records:
        sample = load_sample()
        records = sample["records"]
        window = window or sample.get("meta", {}).get("window")

    if not isinstance(records, list):
        return jsonify({"error": "records 必须是数组"}), 400

    result = analyze_batch(records, window=window)
    result["ai"] = diagnose(result["summary"], result["findings"])
    return jsonify(result)


if __name__ == "__main__":
    port = int(os.environ.get("PORT", "8080"))
    app.run(host="0.0.0.0", port=port, debug=False)
