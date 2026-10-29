#!/usr/bin/env -S uv run --script
"""Check the installed skill-center API through local and trusted-host requests."""
import http.client
import json
import re
import subprocess

log = subprocess.check_output(
    ["journalctl", "--user", "-u", "dsh-web-managed.service", "-n", "20", "--no-pager"],
    text=True,
)
token = re.findall(r"\?token=(\S+)", log)[-1]
conn = http.client.HTTPConnection("127.0.0.1", 3080, timeout=20)
for host in ["127.0.0.1:3080", "boiled.colobus-powan.ts.net"]:
    conn.request("GET", "/?token=" + token, headers={"Host": host})
    auth = conn.getresponse()
    cookie = "; ".join(v.split(";", 1)[0] for k, v in auth.getheaders() if k.lower() == "set-cookie")
    auth.read()
    assert auth.status == 303 and cookie, f"Authentication failed for {host}: {auth.status}"
    conn.request("GET", "/api/dsh-skill-explorer/list", headers={"Cookie": cookie, "Host": host})
    response = conn.getresponse()
    body = response.read().decode()
    print(host, response.status)
    if response.status == 200:
        payload = json.loads(body)
        print("skills:", sum(len(group["skills"]) for group in payload["groups"]))
    else:
        print(repr(body[:500]))
conn.close()
