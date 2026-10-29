# /// script
# requires-python = ">=3.12"
# dependencies = []
# ///
"""Check the deployed DSH version and authenticated HTTPS page without printing tokens."""
import argparse
import http.cookiejar
from html import unescape
import json
import re
import subprocess
import urllib.request
from urllib.parse import urljoin
from pathlib import Path

parser = argparse.ArgumentParser()
parser.add_argument('--upstream', type=Path, required=True)
parser.add_argument('--version', required=True)
parser.add_argument('--commit', required=True)
args = parser.parse_args()
actual_commit = subprocess.check_output(['git', '-C', str(args.upstream), 'rev-parse', 'HEAD'], text=True).strip()
assert actual_commit == args.commit, actual_commit
unit = "dsh-web-managed.service"
subprocess.run(["systemctl", "--user", "is-active", "--quiet", unit], check=True)
pid = subprocess.check_output(
    ["systemctl", "--user", "show", unit, "-p", "MainPID", "--value"], text=True
).strip()
argv = Path(f"/proc/{pid}/cmdline").read_bytes().decode().split("\0")
cli = str(args.upstream / 'apps/cli/lib/bin.js')
assert argv[1] == cli, argv[:2]
version = subprocess.check_output([argv[0], cli, "--version"], text=True).strip()
assert version == args.version, version
log = subprocess.check_output(
    ["journalctl", "--user", "-u", unit, f"_PID={pid}", "--no-pager"], text=True
)
token = re.findall(r"http://127\.0\.0\.1:3080/\?token=(\S+)", log)[-1]
base = "https://boiled.colobus-powan.ts.net"
client = urllib.request.build_opener(
    urllib.request.ProxyHandler({}),
    urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()),
)
with client.open(f"{base}/?token={token}", timeout=15) as response:
    assert response.status == 200, response.status
with client.open(base + "/", timeout=15) as response:
    html = response.read().decode()
    assert response.status == 200 and "<html" in html
asset = unescape(re.search(r'<script[^>]+src="([^"]+)"', html)[1])
print(f"Checking client asset: {asset}", flush=True)
with client.open(urljoin(base + "/", asset), timeout=15) as response:
    assert response.status == 200 and len(response.read()) > 0
print(json.dumps({"service": "active", "pid": int(pid), "version": version,
                  "https_auth": 200, "page": 200, "javascript": 200}))
