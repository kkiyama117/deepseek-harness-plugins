#!/usr/bin/env python3
"""Link the consolidated skill, preserving replaced entries outside discovery."""
import json
from datetime import datetime, timezone
from pathlib import Path
from uuid import uuid4

source = Path(__file__).resolve().parents[1]
home = Path.home()
discovery = home / ".agents" / "skills"
target = discovery / "orchestrate-agents"
legacy = discovery / "task-router"
backup = home / ".local" / "state" / "orchestrate-agents" / "backups" / (
    datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ") + "-" + uuid4().hex
)
discovery.mkdir(parents=True, exist_ok=True)
changed = []


def preserve(path: Path) -> None:
    """Move one existing discovery entry without modifying its contents."""
    if path.exists() or path.is_symlink():
        backup.mkdir(parents=True, mode=0o700, exist_ok=True)
        destination = backup / path.name
        path.rename(destination)
        changed.append(str(destination))


if not (target.is_symlink() and target.resolve() == source):
    preserve(target)
    target.symlink_to(source, target_is_directory=True)
preserve(legacy)
print(json.dumps({"active": str(target), "source": str(source), "preserved": changed}))
