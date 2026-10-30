#!/usr/bin/env python3
"""Read exact Session files; emit only routes, lesson retrieval, and bounded incident excerpts."""
import argparse
import collections
import json
import re
import subprocess
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument("logs", nargs="+", type=Path)
args = parser.parse_args()
needles = ["対象が未設定", "hermes_home", "全く意味", "MVP完成", "target=", "完成しました"]
secrets = re.compile(r"(?:xox[baprs]-[\w-]+|xapp-[\w-]+|sk-[\w-]+|gh[pousr]_[\w]+|AIza[\w-]+|Bearer\s+\S+)")
reports = []
for path in args.logs:
    raw = subprocess.check_output(["zstd", "-dc", str(path)], stderr=subprocess.DEVNULL) if path.suffix == ".zstd" else path.read_bytes()
    rows = [json.loads(line) for line in raw.splitlines() if line]
    routes = []
    sources = collections.Counter()
    calls = []
    excerpts = {}
    initial_requests = []
    delegations = []
    lessons = []
    lesson_calls = {}
    prompts = []
    usage = collections.Counter()
    for event in rows:
        kind, data = event.get("type"), event.get("data", {})
        if kind == "request/header":
            config = data["header"]["config"]
            routes.append({"seq": event["seq"], "reason": data["reason"], "config": {k: config.get(k) for k in ("provider", "model", "reasoningEffort", "maxTokens")}})
        if kind == "assistant/message":
            source = data["message"].get("source", {})
            sources[(source.get("kind"), source.get("provider"), source.get("model"))] += 1
            for key in ("inputTokens", "outputTokens", "cacheReadTokens", "reasoningTokens"):
                value = data.get("usage", {}).get(key)
                if isinstance(value, (int, float)):
                    usage[key] += value
        if kind == "tool/call":
            calls.append({"seq": event["seq"], "name": data["name"]})
            if data["name"] in ("subagent", "subagent_fork"):
                try:
                    delegation = json.loads(data["arguments"])
                except (ValueError, TypeError):
                    delegation = {}
                prompt = delegation.get("prompt", "")
                if isinstance(prompt, str):
                    delegations.append({"seq": event["seq"], "tool": data["name"], "description": secrets.sub("[REDACTED]", str(delegation.get("description", "")))[:120],
                                        "prompt_characters": len(prompt), "bounded_prompt_head": secrets.sub("[REDACTED]", prompt[:240])})
            if data["name"].startswith("kura_"):
                try:
                    tool_args = json.loads(data["arguments"])
                except (ValueError, TypeError):
                    tool_args = {}
                lesson = {"seq": event["seq"], "tool": data["name"], "slug": tool_args.get("slug"), "success": None}
                lessons.append(lesson)
                lesson_calls[data["callId"]] = lesson
        if kind == "tool/result":
            message = data.get("message", {})
            if message.get("toolCallId") in lesson_calls:
                lesson_calls[message["toolCallId"]]["success"] = not message.get("isError", False)
        if kind in ("system/message", "user/message", "developer/message"):
            message = data.get("message", data)
            text = "\n".join(b.get("text", "") for b in message.get("content", []) if b.get("type") == "text")
            source_kind = message.get("source", {}).get("kind")
            if kind == "system/message" or source_kind not in ("user", "model") and ("KURA-MAP" in text or "Operational Discipline" in text):
                prompts.append({"seq": event["seq"], "source": source_kind, "kura_index_present": "KURA-MAP" in text, "discipline_present": "Operational Discipline" in text})
        if kind not in ("assistant/message", "user/message"):
            continue
        message = data.get("message", data)
        text = "\n".join(b.get("text", "") for b in message.get("content", []) if b.get("type") == "text")
        if kind == "user/message" and message.get("source", {}).get("kind") == "user" and len(initial_requests) < 3 and re.search(r"Jev|日報|即検証|保存期限", text):
            initial_requests.append({"seq": event["seq"], "excerpt": secrets.sub("[REDACTED]", text[:300])})
        for needle in needles:
            index = text.find(needle)
            if index >= 0 and len(excerpts.setdefault(needle, [])) < 3:
                excerpts[needle].append({"seq": event["seq"], "source": message.get("source", {}).get("kind"), "text": secrets.sub("[REDACTED]", text[max(0, index - 80):index + 200])})
    reports.append({"session": path.parent.name, "routes": routes,
                    "assistant_sources": [{"kind": k[0], "provider": k[1], "model": k[2], "count": count} for k, count in sources.items()],
                    "first_tool_seq": calls[0]["seq"] if calls else None, "tool_count": len(calls),
                    "lesson_reads": lessons, "prompt_flags": prompts, "reported_usage": dict(usage), "bounded_excerpts": excerpts,
                    "initial_human_requests": initial_requests, "delegations": delegations})
print(json.dumps(reports, ensure_ascii=False, indent=2))
