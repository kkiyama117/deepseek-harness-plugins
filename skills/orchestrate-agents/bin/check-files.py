#!/usr/bin/env python3
"""Check this skill's authored text and relative documentation references."""
import ast
import json
import re
from pathlib import Path

root = Path(__file__).resolve().parents[1]
files = sorted(p for p in root.rglob("*") if p.is_file() and p.suffix in {".md", ".mjs", ".json", ".py"})
for path in files:
    text = path.read_text(encoding="utf-8")
    assert text.endswith("\n") and not text.endswith("\n\n"), path
    assert all(line.rstrip() == line for line in text.splitlines()), path
    if path.suffix == ".json":
        json.loads(text)
    if path.suffix == ".py":
        ast.parse(text)
    if path.suffix == ".md":
        assert sum(line.startswith("```") for line in text.splitlines()) % 2 == 0, path
        for target in re.findall(r"\]\(([^)]+)\)", text):
            if "://" not in target:
                assert (path.parent / target.split("#")[0]).is_file(), (path, target)
print(f"PASS: {len(files)} UTF-8 source files; JSON/Python syntax, Markdown links/fences and whitespace.")
