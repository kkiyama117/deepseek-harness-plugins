#!/usr/bin/env python3
"""Run the synthetic smoke using one explicit owner-only credential file, without sourcing shell code."""
import argparse
import os
from pathlib import Path
import re
import shlex
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument("--live", action="store_true", required=True)
parser.add_argument("--key-file", type=Path, required=True)
parser.add_argument("output", type=Path)
parser.add_argument("--model", choices=["typesafe/jev-1.13", "~typesafe/jev-latest"], default="typesafe/jev-1.13")
args = parser.parse_args()
path = args.key_file.expanduser()
if path.stat().st_mode & 0o077:
    raise SystemExit("Credential file must be owner-only")
assignments = re.findall(r"^\s*(?:export\s+)?OPENROUTER_API_KEY\s*=\s*(.*?)\s*$", path.read_text(), re.M)
if len(assignments) != 1:
    raise SystemExit("Expected exactly one OpenRouter key assignment")
try:
    values = shlex.split(assignments[0], comments=True, posix=True)
except ValueError:
    raise SystemExit("Invalid credential assignment quoting") from None
if len(values) != 1 or not re.fullmatch(r"[A-Za-z0-9_-]+", values[0]):
    raise SystemExit("OpenRouter key must be a literal value; shell execution is not used")
env = os.environ.copy()
env["OPENROUTER_API_KEY"] = values[0]
script = Path(__file__).resolve().with_name("smoke-openrouter.mjs")
result = subprocess.run(["node", str(script), "--live", str(args.output.expanduser().resolve()), args.model], env=env)
raise SystemExit(result.returncode)
