/** Check historical text and an image through the authenticated, ordinary GUI without sending a prompt. */
import { readFile, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
const root='/data/softwares/deepseek-harness';
const fixture=JSON.parse(await readFile('/home/kiyama/.dsh-upgrade-stage-20261005/session-acceptance.json','utf8'));
const pid=execFileSync('systemctl',['--user','show','dsh-web-managed.service','-p','MainPID','--value'],{encoding:'utf8'}).trim();
const journal=execFileSync('journalctl',['--user','-u','dsh-web-managed.service',`_PID=${pid}`,'--no-pager'],{encoding:'utf8',maxBuffer:32*1024*1024});
const token=journal.match(/http:\/\/127\.0\.0\.1:3080\/\?token=([^\s\u001b]+)/)?.[1];assert(token);
const {chromium}=createRequire(root+'/apps/web/package.json')('playwright');
const browser=await chromium.launch({headless:true});
const errors=[];
try {
 const page=await browser.newPage();page.on('pageerror',e=>errors.push(e.message));
 await page.goto(`http://127.0.0.1:3080/?token=${token}`,{waitUntil:'domcontentloaded',timeout:45000});
 await page.getByRole('button',{name:/^(Search sessions|セッションを検索)$/}).click({timeout:30000});
 await page.getByPlaceholder(/^(Search session names|セッション名を検索)$/).fill(fixture.title);
 await page.getByText(fixture.title,{exact:true}).first().click({timeout:30000});
 await page.getByText(fixture.tailText,{exact:false}).first().waitFor({timeout:30000});
 for(let batch=0;batch<20;batch++){
  const earlier=page.getByRole('button',{name:/^(Load earlier|以前を読み込む)$/});
  if(!await earlier.isVisible()) break;
  const before=(await page.locator('[data-chat-flow]').first().innerText()).length;
  await earlier.click();
  await page.waitForFunction(length=>{const flow=document.querySelector('[data-chat-flow]');return flow.innerText.length>length&&!Array.from(flow.querySelectorAll('button')).some(b=>/Loading|読み込み/.test(b.textContent));},before,{timeout:30000});
 }
 await page.getByText(fixture.text,{exact:false}).first().waitFor({timeout:30000});
 const turn=page.locator(`button[data-turn-process="${fixture.imageTurn}"][aria-expanded="false"]`);if(await turn.isVisible()) await turn.click();
 const groups=page.locator(`[data-step-process][data-chat-turn="${fixture.imageTurn}"] > div:first-child button[aria-expanded="false"]:visible`);
 const count=await groups.count();for(let i=0;i<count;i++) await groups.first().click();
 await page.locator('[data-tool="read_image"]').filter({hasText:fixture.image.attachment.name}).first().getByText(/^(Read image|画像を読み取り)$/).click();
 await page.waitForFunction(name=>Array.from(document.images).some(i=>i.alt===name&&i.complete&&i.naturalWidth>0),fixture.image.attachment.name,{timeout:15000});
 assert.deepEqual(errors,[]);
 const result={sessionId:fixture.id,persistedTextVisible:true,persistedImageLoaded:true,pageErrors:errors,modelPromptsSent:0};
 await writeFile('/data/softwares/deepseek-harness-plugins/reports/upgrade-20261026-master/existing-data-verification.json',JSON.stringify(result,null,2)+'\n');
 console.log(JSON.stringify(result));
} catch(error){console.error(String(error.message).replace(/([?&]token=)[^\s"'&]+/g,'$1[REDACTED]'));process.exitCode=1;}
finally{await browser.close();}
