"""List Gemini models or probe function calling using a DSH process credential.

Run with uv run bin/check-gemini-models.py --pid PID [--probe MODEL ...].
Only public model metadata and probe results are printed; credentials stay in memory.
"""

import argparse
import concurrent.futures
import json
from pathlib import Path
import urllib.error
import urllib.parse
import urllib.request

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--pid", type=int, required=True)
parser.add_argument("--probe", nargs="+")
args = parser.parse_args()
environ = dict(
    entry.split("=", 1)
    for entry in Path(f"/proc/{args.pid}/environ").read_text().split("\0")
    if "=" in entry
)
key = environ["GEMINI_API_KEY"]
base = "https://generativelanguage.googleapis.com/v1beta/"


def request(resource, payload=None):
    req = urllib.request.Request(
        base + resource,
        data=None if payload is None else json.dumps(payload).encode(),
        headers={"x-goog-api-key": key, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as response:
            return response.status, json.load(response)
    except urllib.error.HTTPError as error:
        return error.code, json.load(error)


def probe(model):
    status, result = request(
        f"models/{model}:generateContent",
        {
            "contents": [{"role": "user", "parts": [{"text": "Call report_status with status GEMINI_OK."}]}],
            "tools": [{"functionDeclarations": [{
                "name": "report_status",
                "description": "Report the probe status.",
                "parameters": {"type": "OBJECT", "properties": {"status": {"type": "STRING"}}, "required": ["status"]},
            }]}],
            "toolConfig": {"functionCallingConfig": {"mode": "ANY"}},
            "generationConfig": {"maxOutputTokens": 2048},
        },
    )
    calls = [
        part["functionCall"]
        for candidate in result.get("candidates", [])
        for part in candidate.get("content", {}).get("parts", [])
        if "functionCall" in part
    ]
    ok = status == 200 and any(
        call.get("name") == "report_status" and call.get("args", {}).get("status") == "GEMINI_OK"
        for call in calls
    )
    return {"model": model, "httpStatus": status, "ok": ok, "calls": calls,
            "error": result.get("error", {}).get("message")}


if args.probe:
    with concurrent.futures.ThreadPoolExecutor(max_workers=3) as pool:
        results = list(pool.map(probe, args.probe))
    print(json.dumps(results, indent=2))
    raise SystemExit(0 if all(result["ok"] for result in results) else 1)

resource = "models?pageSize=1000"
while resource:
    status, result = request(resource)
    if status != 200:
        raise SystemExit(f"Google models HTTP {status}")
    for model in result.get("models", []):
        if model["name"].startswith("models/gemini-"):
            print(json.dumps(model))
    token = result.get("nextPageToken")
    resource = "models?pageSize=1000&pageToken=" + urllib.parse.quote(token) if token else None
