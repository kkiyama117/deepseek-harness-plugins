# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Prepare version-scoped manifests in an isolated checkout; metadata acceptance is not a feature test."""
from pathlib import Path
import argparse,json
p=argparse.ArgumentParser(description=__doc__);p.add_argument('mapping',type=Path);p.add_argument('report',type=Path);args=p.parse_args()
root=Path(__file__).resolve().parent.parent
assert (root/'.git').is_file(),'Use an isolated worktree'
rows=[]
for item in json.loads(args.mapping.read_text()):
 file=root/item['path'];data=json.loads(file.read_text());old=data['version']
 assert old==item['version'],'Manifest changed or preparation already applied: '+item['path']
 if data['name']=='@kkiyama117/dsh-slack-intake':version='0.2.2-local.1'
 elif data['name']=='@local/dsh-request-acceptance-pilot':version='1.2.0'
 else:
  major,minor,patch=map(int,old.split('.'));version=f'{major}.{minor}.{patch+1}'
 data['version']=version
 for section in ['peerDependencies','dependencies']:
  for name in data.get(section,{}):
   if name.startswith('@deepseek-ai/dsh-'):data[section][name]='0.2.2-rc.1'
   elif name=='@deepseek-ai/cordis':data[section][name]='4.1.0'
   elif name=='@deepseek-ai/schemastery':data[section][name]='3.19.0'
 if 'dsh' in data.get('engines',{}):data['engines']['dsh']='0.2.2-rc.1'
 if data['name']=='@local/dsh-request-acceptance-pilot':data['dependencies']['@kkiyama117/dsh-goal-acceptance']=data['dependencies']['@kkiyama117/dsh-goal-acceptance'].replace('1.1.1.tgz','1.2.0.tgz')
 file.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n');rows.append({**item,'beforeVersion':old,'version':version,'status':'candidate-needs-acceptance'})
args.report.write_text(json.dumps(rows,indent=2)+'\n')
