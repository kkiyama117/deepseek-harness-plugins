#!/usr/bin/env python3
"""Resolve the composed Session root and print one Session's effective-model evidence.

The Session root is not fixed. A profile may override
`session-persistence-jsonl.root` in its `cordis.patch.yml` or in a `--patch`
overlay, so searching a fixed `<DSH_HOME>/sessions` path can find stale logs and
report "no evidence". This script asks the same launcher for the composed
configuration, locates the Session log, and prints the `subagent/descriptor` and
the distinct `request/header` routes that carry the effective provider, model
and reasoning effort.

Usage:
  uv run bin/session-evidence.py --profile web --session-id session-<uuid>
  uv run bin/session-evidence.py --profile web --latest
  uv run bin/session-evidence.py --sessions-root /store/sessions --latest
"""
from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from pathlib import Path

# Session logs are `session.v<format>.jsonl[.zstd]`; rotated logs insert a
# numeric part before the format, so glob broadly and filter on the name.
SESSION_NAME = re.compile(r"^session(?:\.\d+)?\.v\d+\.jsonl(?:\.zstd)?$")


class EvidenceError(Exception):
    """A resolution, search or read step failed and must be reported as such."""


def first_diagnostic(completed: subprocess.CompletedProcess[str]) -> str:
    """Return the first meaningful launcher diagnostic, not a stack tail or Node banner."""
    lines = [line.strip() for line in (completed.stderr or completed.stdout).splitlines() if line.strip()]
    for line in lines:
        if line.startswith("Error:"):
            return line
    return lines[0] if lines else "no diagnostic"


def compose_root(profile: str, dsh: str) -> Path:
    """Return the literal Session root of the composed profile."""
    try:
        completed = subprocess.run(
            [dsh, "--profile", profile, "--dump-config"],
            capture_output=True,
            text=True,
            timeout=120,
        )
    except (OSError, subprocess.TimeoutExpired) as error:
        raise EvidenceError(f"cannot run {dsh!r} for profile {profile!r}: {error}") from error
    if completed.returncode != 0:
        raise EvidenceError(
            f"cannot compose profile {profile!r} (exit {completed.returncode}): "
            f"{first_diagnostic(completed)}"
        )

    block: list[str] | None = None
    for line in completed.stdout.splitlines():
        if re.match(r"^-\s+id:\s*session-persistence-jsonl\s*$", line):
            block = []
            continue
        if block is not None and re.match(r"^-\s+id:\s*", line):
            break
        if block is not None:
            block.append(line)
    if not block:
        raise EvidenceError("the composed configuration has no session-persistence-jsonl entry")

    for line in block:
        match = re.match(r"^\s+root:\s*(.+?)\s*$", line)
        if not match:
            continue
        value = match.group(1).strip().strip("\"'")
        if value.startswith("!!js"):
            raise EvidenceError(
                "the composed root is an expression, not a literal path "
                f"({value}); pass --sessions-root with the value it evaluates to"
            )
        root = Path(value).expanduser()
        if not root.is_absolute():
            raise EvidenceError(f"the composed root is not absolute: {value}")
        return root
    raise EvidenceError("session-persistence-jsonl has no root in the composed configuration")


def find_logs(root: Path, session_id: str | None) -> tuple[list[Path], list[str], int]:
    """Return candidate logs (newest first), the searched patterns, and project-dir count."""
    if not root.is_dir():
        raise EvidenceError(f"the Session root does not exist: {root}")
    try:
        project_dirs = [path for path in root.iterdir() if path.is_dir()]
    except OSError as error:
        raise EvidenceError(f"cannot read the Session root {root}: {error}") from error
    names = [None]
    if session_id is not None:
        names = [session_id, f"session-{session_id}" if not session_id.startswith("session-") else session_id[8:]]
    patterns: list[str] = []
    found: set[Path] = set()
    for name in names:
        pattern = "*/*/session*.jsonl*" if name is None else f"*/{name}/session*.jsonl*"
        patterns.append(str(root / pattern))
        found.update(root.glob(pattern))
    logs = sorted(
        (path for path in found if path.is_file() and SESSION_NAME.match(path.name)),
        key=lambda path: path.stat().st_mtime,
        reverse=True,
    )
    return logs, patterns, len(project_dirs)


def iter_events(path: Path):
    """Yield one JSON event per line, streaming a zstd-compressed log."""
    if path.name.endswith(".zstd"):
        if shutil.which("zstd") is None:
            raise EvidenceError("zstd is not on PATH; install it or read an uncompressed Session log")
        process = subprocess.Popen(
            ["zstd", "-dc", str(path)],
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        if process.stdout is None:
            raise EvidenceError(f"cannot read the decompressed output of {path}")
        for raw in process.stdout:
            line = raw.decode("utf-8", errors="replace").strip()
            if line:
                yield line
        error = (process.stderr.read() if process.stderr is not None else b"").decode(
            "utf-8", errors="replace"
        ).strip()
        if process.wait() != 0:
            raise EvidenceError(f"cannot decompress {path}: {error or 'zstd failed'}")
        return
    for line in path.read_text(encoding="utf-8", errors="replace").splitlines():
        if line.strip():
            yield line.strip()


def extract(events):
    """Collect the Session header, the subagent descriptor and distinct routes."""
    header: dict | None = None
    descriptor: dict | None = None
    routes: list[dict] = []
    seen: set[str] = set()
    for line in events:
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        kind = event.get("type")
        if kind == "session" and header is None:
            header = {
                key: event[key]
                for key in ("id", "version", "createdAt", "cwd", "agentPreset", "delegationDepth")
                if key in event
            }
        elif kind == "subagent/descriptor" and descriptor is None:
            descriptor = event.get("data")
        elif kind == "request/header":
            config = (((event.get("data") or {}).get("header") or {}).get("config")) or {}
            route = {
                key: config[key]
                for key in ("provider", "model", "reasoningEffort", "maxTokens")
                if config.get(key) is not None
            }
            if not route:
                continue
            fingerprint = json.dumps(route, sort_keys=True)
            if fingerprint not in seen:
                seen.add(fingerprint)
                routes.append({"seq": event.get("seq"), **route})
    return header, descriptor, routes


def parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Print the effective provider/model/reasoning route recorded in a Session log.",
    )
    parser.add_argument("--profile", help="profile whose composed configuration names the Session root")
    parser.add_argument("--session-id", help="Session id, with or without the 'session-' prefix")
    parser.add_argument("--latest", action="store_true", help="use the newest log under the root (project-agnostic)")
    parser.add_argument(
        "--sessions-root",
        help="Session root to read instead of resolving it from --profile (state why in the record)",
    )
    parser.add_argument("--dsh", default="dsh", help="launcher used to compose the profile (default: dsh)")
    args = parser.parse_args(argv)
    if args.sessions_root is None and args.profile is None:
        parser.error("pass --profile or --sessions-root")
    if bool(args.session_id) == bool(args.latest):
        parser.error("pass exactly one of --session-id or --latest")
    return args


def main(argv: list[str]) -> int:
    args = parse_args(argv)
    try:
        root = (
            Path(args.sessions_root).expanduser()
            if args.sessions_root is not None
            else compose_root(args.profile, args.dsh)
        )
        if not root.is_absolute():
            raise EvidenceError(f"the Session root is not absolute: {root}")
        logs, patterns, project_dirs = find_logs(root, args.session_id)
        if not logs:
            target = args.session_id or "the newest Session"
            searched = "\n".join(f"  {pattern}" for pattern in patterns)
            raise EvidenceError(
                f"no Session log found for {target}\n"
                f"  effective root: {root}\n"
                f"  project directories under the root: {project_dirs}\n"
                f"  searched:\n{searched}"
            )
        log = logs[0]
        header, descriptor, routes = extract(iter_events(log))
        result = {
            "effective_root": str(root),
            "session_file": str(log),
            "session": header,
            "descriptor": descriptor,
            "request_headers": routes,
            "other_candidate_logs": len(logs) - 1,
        }
        print(json.dumps(result, ensure_ascii=False, indent=2))
        return 0
    except EvidenceError as error:
        print(f"session-evidence: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
