/** Verify the existing production listener and a restored conversation without model calls. */
import { execFileSync } from 'node:child_process';
import { readFile, readlink, mkdir, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { checkExistingSession, classifyResourceFailures, blockingBrowserErrors } from './check-upgrade-session.mjs';
const root='/data/softwares/deepseek-harness-upgrade-master';
const out='/data/softwares/deepseek-harness/.dsh-maintenance/cutover-20261013/verification';
await mkdir(out,{recursive:true,mode:0o700});
const pid=execFileSync('systemctl',['--user','show','dsh-web-managed.service','-p','MainPID','--value'],{encoding:'utf8'}).trim();
if(await readlink(`/proc/${pid}/cwd`)!==root)throw new Error('Unexpected production cwd');
const argv=(await readFile(`/proc/${pid}/cmdline`,'utf8')).split('\0');
if(argv[1]!==`${root}/apps/cli/lib/bin.js`)throw new Error('Unexpected production executable');
const version=execFileSync(argv[0],[argv[1],'--version'],{encoding:'utf8'}).trim();
if(version!=='0.2.1-alpha.2')throw new Error(`Unexpected version: ${version}`);
const head=execFileSync('git',['-C',root,'rev-parse','HEAD'],{encoding:'utf8'}).trim();
if(head!=='b5059f530faec33b8485da5f89b74b70d4f925a9')throw new Error('Unexpected production commit');
const journal=execFileSync('journalctl',['--user','-u','dsh-web-managed.service',`_PID=${pid}`,'--no-pager'],{encoding:'utf8'});
const match=journal.match(/http:\/\/127\.0\.0\.1:3080\/\?token=([^\s\u001b]+)/);
if(!match)throw new Error('Production authentication URL is missing');
if(/entr(?:y|ies) did not activate|incompatible with dsh/.test(journal))throw new Error('Production has inactive/incompatible plugins');
const {chromium}=createRequire(join(root,'apps/web/package.json'))('playwright');
const browser=await chromium.launch({headless:true});
const results=[];
let page;
try{
 for(const origin of ['http://127.0.0.1:3080','https://boiled.colobus-powan.ts.net']){
  page=await browser.newPage({viewport:{width:1440,height:1000}});
  const errors=[],responses=[];
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text());});
  page.on('response',response=>{if(response.status()>=400){const url=new URL(response.url());url.searchParams.delete('token');responses.push({url:url.href,status:response.status()});}});
  await page.addLocatorHandler(page.getByText('Preview Notice',{exact:true}),async()=>{await page.getByRole('button',{name:'Continue',exact:true}).click();});
  await page.goto(`${origin}/?token=${match[1]}`,{waitUntil:'domcontentloaded',timeout:45000});
  await page.getByRole('button',{name:'Settings',exact:true}).waitFor({timeout:45000});
  await page.getByRole('button',{name:'Settings',exact:true}).click();
  await page.getByText('General',{exact:true}).first().waitFor({timeout:15000});
  const session=await checkExistingSession(page);
  const resources=await classifyResourceFailures(responses,'/home/kiyama/.dsh-recovery-20261005',origin);
  const record={origin,settingsOpened:true,session,errors:blockingBrowserErrors(errors,resources),resources};
  results.push(record);
  await page.screenshot({path:join(out,origin.startsWith('https')?'https.png':'local.png'),fullPage:true});
  await page.close();page=undefined;
 }
 await writeFile(join(out,'result.json'),JSON.stringify({pid,version,head,results},null,2)+'\n',{mode:0o600});
 if(results.some(row=>row.errors.length||row.resources.blocking.length))throw new Error('Blocking production GUI errors; inspect result.json');
 console.log(JSON.stringify({pid,version,head,origins:results.map(r=>r.origin),restoredTextAndImage:true,blockingErrors:0}));
}catch(error){
 if(page&&!page.isClosed()){
  await page.screenshot({path:join(out,'failure.png'),fullPage:true});
  await writeFile(join(out,'failure-body.txt'),await page.locator('body').innerText(),{mode:0o600});
 }
 await writeFile(join(out,'failure.json'),JSON.stringify({message:error.message,results},null,2)+'\n',{mode:0o600});
 throw error;
}finally{await browser.close();}
