# /// script
# requires-python = ">=3.11"
# dependencies = []
# ///
"""Record verified separation evidence through a private index, preserving the user's staged work."""
from pathlib import Path
import os,subprocess,hashlib,json,tempfile
root=Path(__file__).resolve().parent.parent;report=root/'reports/core-plugin-separation-20261027'
def git(*args,**kwargs):return subprocess.check_output(['git','-C',str(root),*args],**kwargs)
index=Path(git('rev-parse','--path-format=absolute','--git-path','index',text=True).strip())
before=hashlib.sha256(index.read_bytes()).hexdigest();base=git('rev-parse','maintenance/plugin-separation-20261027',text=True).strip()
names=['final-report.ja.md','completion.json','cleanup.json','final-preservation.json','final-installed-preservation.json','live-core-final.json','post-cleanup-core.json','live-providers-final.json','live-runtime-final.log','live-history-final.log','live-daily-final.log','adoption-receipt.json','adoption-runtime.log','external-regressions.log','types-pinned-schema.log','releases.json','test-ownership.json','final-inventory/compatibility.json']
files=['maintenance.json','bin/record-core-separation-result.py']+['reports/core-plugin-separation-20261027/'+name for name in names]
with tempfile.TemporaryDirectory(prefix='separation-record-',dir=report) as temporary:
 folder=Path(temporary);assert folder.resolve().parent==report.resolve()
 env={**os.environ,'GIT_INDEX_FILE':str(folder/'index')}
 git('read-tree',base,env=env);git('add','-f','--',*files,env=env)
 # Raw command logs retain producer whitespace; only authored code and records are whitespace-gated.
 git('diff','--cached','--check','--',*[file for file in files if not file.endswith('.log')],env=env)
 tree=git('write-tree',env=env,text=True).strip()
 commit=git('commit-tree',tree,'-p',base,'-m','docs(maintenance): record deployed and cleaned Core/plugin separation',env=env,text=True).strip()
 git('update-ref','refs/heads/maintenance/separation-completed-20261027',commit,'0'*40)
assert hashlib.sha256(index.read_bytes()).hexdigest()==before
(report/'record-commit.json').write_text(json.dumps({'commit':commit,'sourceCommit':base,'branch':'maintenance/separation-completed-20261027','liveIndexUnchanged':True,'rawLogsPreservedVerbatim':True},indent=2)+'\n')
print('Recorded:',commit,'live index preserved')
