"""Prepare the npm 0.25.0 sidebar for DSH's documented webStartup rename."""
import difflib
import json
from pathlib import Path
import shutil
import sys
source=Path(sys.argv[1]).resolve()
root=Path(__file__).resolve().parent.parent
out=root/'compat/better-sidebar-alpha2'
if out.exists():raise SystemExit(f'Refusing existing package: {out}')
shutil.copytree(source,out,ignore=shutil.ignore_patterns('node_modules','.git'))
manifest=json.loads((out/'package.json').read_text())
assert manifest['name']=='dsh-better-sidebar' and manifest['version']=='0.25.0'
manifest['version']='0.25.0-local.1'
(out/'package.json').write_text(json.dumps(manifest,ensure_ascii=False,indent=2)+'\n')
file=out/'lib/index.js'
old=file.read_text()
assert old.count('"webRuntime"')==1 and old.count('ctx.webRuntime.trustedHosts')==1
new=old.replace('"webRuntime"','"webStartup"').replace('ctx.webRuntime.trustedHosts','ctx.webStartup.trustedHosts')
file.write_text(new)
(out/'alpha2-compat.patch').write_text(''.join(difflib.unified_diff(old.splitlines(True),new.splitlines(True),fromfile='npm-0.25.0/lib/index.js',tofile='lib/index.js')))
(out/'UPGRADE.json').write_text(json.dumps({'source':'dsh-better-sidebar@0.25.0','target':'DSH 0.2.1-alpha.2','change':'Documented webRuntime -> webStartup injection and trustedHosts read; no authorization broadening.','verification':'pending full profile/browser smoke'},indent=2)+'\n')
print(out)
