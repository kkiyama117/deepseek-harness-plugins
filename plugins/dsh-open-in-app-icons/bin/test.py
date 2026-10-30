# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Run icon-route regressions against a source or unpacked release and the selected DSH checkout."""
import argparse
import os
from pathlib import Path
import subprocess

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--core', type=Path, default=Path('/data/softwares/deepseek-harness'))
parser.add_argument('--package', type=Path, default=Path(__file__).resolve().parent.parent)
args = parser.parse_args()
core = args.core.resolve()
package = args.package.resolve()
loader = subprocess.check_output([
    'node', '--input-type=module', '-e',
    "import {createRequire} from 'node:module'; process.stdout.write(createRequire(process.argv[1]).resolve('tsx/esm'));",
    str(core / 'package.json'),
], text=True)
env = {**os.environ, 'DSH_ICONS_CORE': str(core), 'DSH_ICONS_PACKAGE': str(package)}
result = subprocess.run([
    'node', '--import', loader, '--test',
    str(Path(__file__).resolve().parent.parent / 'tests' / 'routes.test.mjs'),
], env=env, cwd=core)
raise SystemExit(result.returncode)
