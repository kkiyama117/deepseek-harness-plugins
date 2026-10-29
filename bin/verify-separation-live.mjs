/** Read live provider rows and verify the installed scoped policy; never change Sessions. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { readFile, writeFile } from 'node:fs/promises';
const root='/data/softwares/deepseek-harness';
const report=process.argv[2];
assert(report,'Provide a report output path');
const pid=execFileSync('systemctl',['--user','show','dsh-web-managed.service','-p','MainPID','--value'],{encoding:'utf8'}).trim();
const journal=execFileSync('journalctl',['--user','-u','dsh-web-managed.service',`_PID=${pid}`,'--no-pager'],{encoding:'utf8',maxBuffer:32*1024*1024});
const token=journal.match(/http:\/\/127\.0\.0\.1:3080\/\?token=([^\s\u001b]+)/)?.[1];
assert(token,'No authenticated GUI URL in the current process log');
const require=createRequire(root+'/apps/web/package.json');
const {chromium}=require('playwright');
const browser=await chromium.launch({headless:true});
try {
  const page=await browser.newPage();
  await page.goto(`http://127.0.0.1:3080/?token=${token}`,{waitUntil:'domcontentloaded'});
  const reply=await page.evaluate(async()=>{
    const method='pluginManager/listPlugins';
    return (await fetch('/api/'+method,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({type:'client-request',rpcId:crypto.randomUUID(),method,payload:{args:{}}})})).json();
  });
  assert.equal(reply.result?.ok,true);
  const rows=reply.result.value;
  const find=id=>{const row=rows.find(row=>row.entryId==='include:'+id);assert(row,`Missing ${id}`);return row;};
  for(const id of ['acceptance-goal-provider','acceptance-subagent-provider','request-acceptance-pilot'])assert.equal(find(id).fiberPhase,'active',id);
  for(const id of ['goal','subagent'])assert.notEqual(find(id).fiberPhase,'active',id);
  assert.equal(rows.filter(row=>['pending','failed'].includes(row.fiberPhase)).length,0);
  const profile='/home/kiyama/.dsh/profiles/web';
  const manifest=JSON.parse(await readFile(profile+'/package.json','utf8'));
  assert(!manifest.dsh.profile.bundles.includes('@kkiyama117/dsh-goal-acceptance'),'Standalone all-session policy must not be selected');
  const pkg=profile+'/node_modules/@local/dsh-request-acceptance-pilot';
  const pilot=JSON.parse(await readFile(pkg+'/package.json','utf8'));
  assert.equal(pilot.version,'1.1.0');assert(!pilot.dependencies['@deepseek-ai/dsh-goal-acceptance']);
  const yaml=require('js-yaml');const patch=yaml.load(await readFile(pkg+'/cordis.patch.yml','utf8'));
  const inserted=patch.flatMap(row=>row.insert??[]);
  const selected=inserted.find(row=>row.id==='request-acceptance-pilot').config.sessionIds;
  assert.deepEqual(selected,['session-2b468884-e9fe-46c5-8816-c8620c9e73c3']);
  assert.equal(inserted.find(row=>row.id==='acceptance-subagent-provider').config.maxDepth,2);
  const result={status:'passed',pid,pluginCount:rows.length,providers:['goal','subagent','acceptance-goal-provider','acceptance-subagent-provider','request-acceptance-pilot'].map(id=>({id,phase:find(id).fiberPhase,enabled:find(id).enabled})),pilotVersion:pilot.version,selectedSessionIds:selected,configuredMaxDepth:2,standaloneAllSessionBundleSelected:false};
  await writeFile(report,JSON.stringify(result,null,2)+'\n',{mode:0o600});console.log(JSON.stringify(result,null,2));
} catch(error){console.error(String(error.message).replace(/([?&]token=)[^\s"'&]+/g,'$1[REDACTED]'));process.exitCode=1;}
finally{await browser.close();}
