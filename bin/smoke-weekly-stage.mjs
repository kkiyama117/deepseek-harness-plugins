/** Boot an isolated DSH profile, verify its actual browser, then await shutdown. */
import { spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { createRequire } from 'node:module';
const [targetArg,homeArg]=process.argv.slice(2);
if(!targetArg||!homeArg)throw new Error('Usage: node smoke-weekly-stage.mjs TARGET_DSH STAGE_HOME');
const target=resolve(targetArg),home=resolve(homeArg);
const {chromium}=createRequire(join(target,'apps/web/package.json'))('playwright');
const child=spawn(process.execPath,[join(target,'apps/cli/lib/bin.js'),'web','--port','0','--no-open'],{cwd:target,env:{...process.env,DSH_HOME:home,DSH_TELEMETRY_DISABLED:'1'},stdio:['ignore','pipe','pipe']});
let log='',exited=false,code;
const ended=new Promise(resolve=>child.once('exit',(exitCode)=>{exited=true;code=exitCode;resolve();}));
let timer,browser,page;
const errors=[];
try{
 const url=await new Promise((resolve,reject)=>{
  timer=setTimeout(()=>reject(new Error('Staged profile startup exceeded 70 seconds')),70000);
  const onData=chunk=>{log+=chunk.toString();const match=log.match(/http:\/\/127\.0\.0\.1:\d+\/\?token=[^\s\u001b]+/);if(match){clearTimeout(timer);resolve(match[0]);}};
  child.stdout.on('data',onData);child.stderr.on('data',onData);
  child.once('error',reject);child.once('exit',exit=>reject(new Error(`Staged Host exited before readiness: ${exit}`)));
 });
 browser=await chromium.launch({headless:true});
 page=await browser.newPage({viewport:{width:1440,height:1000}});
 page.on('pageerror',e=>errors.push(e.message));
 await page.addLocatorHandler(page.getByText('Preview Notice',{exact:true}),async()=>{await page.getByRole('button',{name:'Continue',exact:true}).click();});
 await page.goto(url,{waitUntil:'domcontentloaded',timeout:45000});
 await page.getByRole('button',{name:'Settings',exact:true}).waitFor({timeout:45000});
 await page.getByRole('button',{name:'Settings',exact:true}).click();
 await page.getByText('General',{exact:true}).first().waitFor({timeout:15000});
 await page.screenshot({path:join(home,'smoke.png'),fullPage:true});
 await writeFile(join(home,'smoke-body.txt'),await page.locator('body').innerText(),{mode:0o600});
 const result={origin:new URL(url).origin,settingsOpened:true,errors};
 await writeFile(join(home,'smoke.json'),JSON.stringify(result,null,2)+'\n',{mode:0o600});
 console.log(JSON.stringify(result));
 if(errors.length)throw new Error('Staged browser has runtime errors');
 if(/entr(?:y|ies) did not activate|incompatible with dsh/.test(log))throw new Error('Staged Host has inactive or incompatible plugins; inspect startup-redacted.log');
}catch(error){
 console.error(error.message);
 if(page&&!page.isClosed()) {
  await page.screenshot({path:join(home,'smoke-failure.png'),fullPage:true});
  await writeFile(join(home,'smoke-failure-body.txt'),await page.locator('body').innerText(),{mode:0o600});
 }
 await writeFile(join(home,'smoke-errors.json'),JSON.stringify(errors,null,2)+'\n',{mode:0o600});
 process.exitCode=1;
}finally{
 clearTimeout(timer);
 if(browser)await browser.close();
 if(!exited)child.kill('SIGTERM');
 const killer=setTimeout(()=>{if(!exited)child.kill('SIGKILL');},10000);
 await ended;clearTimeout(killer);
 await writeFile(join(home,'startup-private.log'),log,{mode:0o600});
 await writeFile(join(home,'startup-redacted.log'),log.replace(/([?&]token=)[^\s\u001b&]+/g,'$1[REDACTED]'),{mode:0o600});
 console.log(JSON.stringify({hostExit:code}));
}
