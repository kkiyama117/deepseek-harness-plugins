# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Prepare candidate manifests in this isolated worktree; this does not establish runtime compatibility."""
from pathlib import Path
import argparse,json
p=argparse.ArgumentParser(description=__doc__);p.add_argument('--report',type=Path,required=True);args=p.parse_args()
root=Path(__file__).resolve().parent.parent
assert (root/'.git').is_file(),'This preparation requires an isolated worktree'
versions={'dsh-goal-acceptance':'1.1.1','dsh-workflow-results':'1.0.2','dsh-session-cleanup':'1.0.2','dsh-codex-transport-recovery':'1.0.2','dsh-request-acceptance-pilot':'1.1.1','compat/slack-intake-rc3':'0.2.1-local.4','compat/slack-digest-alpha2':'1.0.2-local.3','compat/intake-knowledge-alpha2':'1.0.4-local.3','presets/managed-standard':'1.2.1','presets/managed-cordis':'1.2.1','presets/cordis-kura':'1.2.1','presets/ai-reference-store-next':'1.2.1','dsh-aistore-native-preset':'1.0.2','dsh-inspector-origin':'1.0.2','dsh-open-in-app-icons':'1.0.3'}
rows=[]
for directory,version in versions.items():
 file=root/directory/'package.json';data=json.loads(file.read_text());data['version']=version
 for name,requirement in data.get('peerDependencies',{}).items():
  target='0.2.2-alpha.2' if name.startswith('@deepseek-ai/dsh-') else {'@deepseek-ai/cordis':'4.0.6-alpha.1','@deepseek-ai/schemastery':'3.18.6-alpha.1','@kkiyama117/dsh-slack-intake':'0.2.1-local.4'}.get(name)
  if target and target not in requirement.split(' || '):data['peerDependencies'][name]=requirement+' || '+target
 if data.get('engines',{}).get('dsh') and '0.2.2-alpha.2' not in data['engines']['dsh'].split(' || '):data['engines']['dsh']+=' || 0.2.2-alpha.2'
 if directory=='dsh-request-acceptance-pilot':data['dependencies']['@kkiyama117/dsh-goal-acceptance']='file:/data/softwares/deepseek-harness-plugins/releases/kkiyama117-dsh-goal-acceptance-1.1.1.tgz'
 file.write_text(json.dumps(data,ensure_ascii=False,indent=2)+'\n');rows.append({'directory':directory,'name':data['name'],'version':version,'status':'candidate-requires-validation'})
args.report.write_text(json.dumps(rows,indent=2)+'\n');print('Prepared candidate manifests:',len(rows))
