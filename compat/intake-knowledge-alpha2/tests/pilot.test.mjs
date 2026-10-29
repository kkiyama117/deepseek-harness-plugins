import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp,writeFile,readFile,rm } from 'node:fs/promises';
import { join,resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { createLimiter,route,runPilot } from './pilot.mjs';

test('pilot fixes route/output and admits at most four requests without an input-byte cap',()=>{
  const limiter=createLimiter('one');
  const options={...route,sessionId:'one',messages:[{role:'user',content:[{type:'text',text:'x'.repeat(60000)}]}]};
  for(let i=0;i<4;i++) limiter.admit(options);
  assert.ok(limiter.requests[0].input_json_bytes>48*1024);
  assert.equal(limiter.requests.length,4);
  assert.throws(()=>limiter.admit(options),/PILOT_REQUEST_LIMIT/);
  for(const change of [{model:'fallback'},{provider:'other'},{maxTokens:4097},{reasoningEffort:'high'},{sessionId:'other'},{purpose:'session-title'}]) {
    assert.throws(()=>createLimiter('one').admit({...options,...change}),/PILOT_ROUTE_MISMATCH/);
  }
});

test('pilot consumes one persistent attempt and refuses replay after failure',async t=>{
  const dir=await mkdtemp(join(tmpdir(),'intake-pilot-test-'));
  t.after(async()=>{assert.equal(resolve(dir),dir);assert.ok(dir.startsWith(join(tmpdir(),'intake-pilot-test-')));await rm(dir,{recursive:true});});
  const scopeFile=join(dir,'scope.json');
  const bytes=JSON.stringify({approved_at:'2026-10-09T00:00:00Z',approval_id:'synthetic'});
  await writeFile(scopeFile,bytes,{mode:0o600});
  const packetPath=join(dir,'packet.json');
  await writeFile(packetPath,JSON.stringify({version:1,allow_unknown_cost_one_question:true,input_limit:null,outputDir:join(dir,'attempt'),scopeFile,
    scopeHash:createHash('sha256').update(bytes).digest('hex'),question:'Synthetic question',approvalId:'synthetic',maxQuestions:1}),{mode:0o600});
  let creates=0;
  const ctx={llm:{resolveCallConfig:async()=>route,providerRetryPolicy:()=>({mode:'normal',maxRetries:0})},on:()=>()=>{},agents:{create:async()=>{creates++;throw new Error('SYNTHETIC_START_FAILURE');}}};
  const got=await runPilot(ctx,{packetPath,cwd:dir,presetId:'synthetic'},new AbortController().signal);
  assert.equal(got.status,'failed');assert.equal(got.requests.length,0);assert.equal(creates,1);
  assert.equal(JSON.parse(await readFile(join(dir,'attempt','result.json'),'utf8')).code,'SYNTHETIC_START_FAILURE');
  await assert.rejects(runPilot(ctx,{packetPath,cwd:dir,presetId:'synthetic'},new AbortController().signal),{code:'EEXIST'});
  assert.equal(creates,1);
});
