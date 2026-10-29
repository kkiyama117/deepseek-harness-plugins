"""Copy only package sources into new alpha.2 compatibility directories.

Run with uv run. Refuses existing destinations; does not install a package.
"""
from pathlib import Path
import shutil
import json
root=Path(__file__).resolve().parent.parent
sources={
 'slack-intake-alpha2':root/'dsh-slack-intake',
 'slack-digest-alpha2':Path('/data/softwares/slack-intake/integrations/dsh-slack-digest'),
 'intake-knowledge-alpha2':Path('/home/kiyama/.dsh/profiles/web/node_modules/@local/dsh-intake-knowledge-reader'),
}
for name,source in sources.items():
 target=root/'compat'/name
 if target.exists():raise SystemExit(f'Refusing existing destination: {target}')
 shutil.copytree(source,target,ignore=shutil.ignore_patterns('node_modules','.git','__pycache__','*.tgz'))
 manifest=target/'package.json'
 value=json.loads(manifest.read_text())
 value['version']={'slack-intake-alpha2':'0.2.1-local.1','slack-digest-alpha2':'1.0.2-local.1','intake-knowledge-alpha2':'1.0.4-local.1'}[name]
 for key in value.get('peerDependencies',{}):
  if key.startswith('@deepseek-ai/dsh-'):value['peerDependencies'][key]='0.2.1-alpha.2'
 if name=='slack-digest-alpha2':
  value['dependencies']['@kkiyama117/dsh-slack-intake']='link:'+str(root/'compat/slack-intake-alpha2')
 manifest.write_text(json.dumps(value,ensure_ascii=False,indent=2)+'\n')
 (target/'UPGRADE.json').write_text(json.dumps({'source':str(source),'targetDsh':'0.2.1-alpha.2','status':'awaiting-tests'},indent=2)+'\n')
 print(target)
