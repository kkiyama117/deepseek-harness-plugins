"""DeepSeek Harness (DSH) runtime glue for the skill-creator eval scripts.

Replaces the Claude Code CLI (`claude -p`) with the DeepSeek Harness one-shot
runner (`dsh --profile headless "<task>"`).

The dsh-base bundle already mounts the skill registry provider and the
model-facing `skill` tool in every profile (including headless), so a trigger
eval just runs the query from an isolated temp project whose only project
skill is the description under test, and detects triggering deterministically
from the persisted session transcript
(`~/.dsh/sessions/<cwd-slug>/<session>/session.jsonl.zstd`): a `tool/call`
event whose tool is `skill` and whose arguments name the eval skill.
"""

import glob
import json
import os
import shutil
import subprocess
from pathlib import Path

HOME = Path.home()


def find_dsh_binary() -> str | None:
    """Locate a usable `dsh` CLI: DSH_BIN env, PATH, ~/.dsh/cli, or the bunx cache."""
    env = os.environ.get("DSH_BIN")
    if env:
        return env
    on_path = shutil.which("dsh")
    if on_path:
        return on_path
    cli = HOME / ".dsh" / "cli" / "node_modules" / ".bin" / "dsh"
    if cli.is_file():
        return str(cli)
    candidates = sorted(
        glob.glob("/tmp/bunx-*-@deepseek-ai/dsh@*/node_modules/.bin/dsh"),
        key=os.path.getmtime,
    )
    if candidates:
        return candidates[-1]
    return None


def eval_skill_md(skill_name: str, description: str) -> str:
    """Render the SKILL.md under test: the description is the trigger surface."""
    return (
        f"---\n"
        f"name: {skill_name}\n"
        f"description: {json.dumps(description)}\n"
        f"---\n\n"
        f"# {skill_name}\n\n"
        f"This skill handles: {description}\n"
    )


def _sessions_slug(cwd: Path) -> str:
    """Session dir slug for a cwd: separators become '-', wrapped in '--...--'."""
    return "--" + str(cwd).strip("/").replace("/", "-") + "--"


def find_newest_transcript(cwd: Path) -> Path | None:
    """Newest persisted session transcript for runs whose cwd was `cwd`."""
    session_dir = HOME / ".dsh" / "sessions" / _sessions_slug(cwd)
    if not session_dir.is_dir():
        return None
    files = sorted(
        session_dir.glob("*/session.jsonl.zstd"),
        key=lambda p: p.stat().st_mtime,
    )
    return files[-1] if files else None


def _zstd_decompress(transcript: Path) -> str:
    zstd = os.environ.get("ZSTD_BIN", "zstd")
    result = subprocess.run(
        [zstd, "-dc", str(transcript)], capture_output=True, timeout=60
    )
    return result.stdout.decode("utf-8", "replace")


def transcript_used_skill(transcript: Path, skill_name: str) -> bool:
    """True when the transcript contains a `skill` tool call naming the skill."""
    try:
        data = _zstd_decompress(transcript)
    except Exception:
        return False
    for line in data.splitlines():
        if '"type":"tool/call"' not in line:
            continue
        try:
            event = json.loads(line)
        except json.JSONDecodeError:
            continue
        call = event.get("data", {})
        if call.get("name") != "skill":
            continue
        try:
            arguments = json.loads(call.get("arguments") or "{}")
        except json.JSONDecodeError:
            continue
        if arguments.get("name") == skill_name:
            return True
    return False


def run_headless(
    binary: str,
    task: str,
    cwd: Path,
    timeout: int,
) -> subprocess.CompletedProcess | None:
    """Run one one-shot headless task; None on timeout."""
    cmd = [binary, "--profile", "headless", task]
    try:
        return subprocess.run(
            cmd,
            cwd=str(cwd),
            capture_output=True,
            text=True,
            timeout=timeout,
        )
    except subprocess.TimeoutExpired:
        return None
