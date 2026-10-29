import assert from 'node:assert/strict';
import {test} from 'node:test';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {Context} from '@deepseek-ai/cordis';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import {mountAgentLoopTestDependencies} from '@deepseek-ai/dsh-agent-loop-testkit';
import {LlmAdapter,ToolCallId} from '@deepseek-ai/dsh-llm';
import {executeVerification,verificationPrompt} from '../verification-runtime.mjs';
import {buildJobResult} from '../slack-cards.mjs';
import {atomicJSON} from '../automation-client.mjs';

class ScopeAdapter extends LlmAdapter {
 calls=[];
 resolveModel(provider,model){return Promise.resolve({provider,id:model,name:model,reasoning:{efforts:[{id:'high',name:'High'}]}});}
 async *stream(options){
  this.calls.push(options);
  assert.deepEqual(options.tools.map(t=>t.name),['verification_result']);
  const attempts=[
   ['development_command',{command:'printf must-not-run'}],
   ['verification_result',{summary:'このアプリにないので不要',outcome:'not-applicable',verified:false,artifacts:[]}],
   ['verification_result',{summary:'根拠なしの検証済み',outcome:'research-only',verified:true,artifacts:[]}],
   ['verification_result',{summary:'長'.repeat(801),outcome:'research-only',verified:false,artifacts:[]}],
   ['verification_result',{summary:'要点：ローカルLLMによる並列処理の紹介。\n役立つ場面：開発作業の自動化。\n未確認：速度と費用は未実証。\n次の一手：DSH運用で試したいか、用途と対象を決める。',outcome:'needs-target',verified:false,artifacts:[]}],
  ];
  const [name,args]=attempts[this.calls.length-1];
  const id=ToolCallId('scope-'+this.calls.length);
  yield{type:'block-start',index:0,blockType:'tool-call'};
  yield{type:'block-end',index:0,block:{type:'tool-call',id,name,arguments:JSON.stringify(args)}};
  yield{type:'finish',reason:{kind:'tool-calls'}};
 }
}

test('unspecified use case cannot execute commands, reject applicability, claim verification or dump long logs',async t=>{
 const directory=await mkdtemp(join(tmpdir(),'slack-scope-'));
 const ctx=new Context();
 t.after(async()=>{await ctx.fiber.dispose();await rm(directory,{recursive:true,force:true});});
 await mountAgentLoopTestDependencies(ctx,{tools:{mode:'native'}});await ctx.plugin(AgentLoop,{agents:[]});
 const adapter=new ScopeAdapter();ctx.llm.registerAdapter(['fixture'],adapter);
 ctx.on('session/flush',s=>atomicJSON(join(directory,'session.json'),s.snapshotEvents()));
 const runtime={agents:ctx.agents,sessions:ctx.sessions,agentPresets:{async mount(){}}};
 const config={targetRoot:directory,artifactsRoot:join(directory,'artifacts'),presetId:'fixture',route:{provider:'fixture',model:'fixed',reasoningEffort:'high',maxTokens:1024},jobTimeoutSeconds:10,maxModelSteps:6};
 const job={job_id:'scope',session_id:randomUUID(),target:directory,workflow:'development-verification',input_hash:'a'.repeat(64),reference:{identity:'url:https://example.test'}};
 const material={status:'available',text:'投稿者はdotsでローカルLLMを並列利用できると主張している。',content_hash:'b'.repeat(64),scope:'coordinator-approved-public-standalone-article',truncated:false};
 const result=await executeVerification(runtime,config,job,new AbortController().signal,{material});
 assert.equal(result.status,'succeeded');assert.equal(result.verified,false);assert.equal(adapter.calls.length,5);
 assert.match(result.result,/^検証対象の指定が必要です/);
 const record=JSON.parse(await readFile(result.artifacts.at(-1),'utf8'));
 assert.deepEqual(record.commands,[]);assert.equal(record.file_reads,0);assert.equal(record.result.outcome,'needs-target');
 assert.equal(ctx.agents.list().length,0);
 const card=buildJobResult({...result,session_id:job.session_id});
 assert.match(card.blocks[0].text.text,/用途の確認が必要/);assert.doesNotMatch(card.text,/検証未完|証拠：|このアプリにないので不要/);
});

test('project experiment requires an explicit intended use before any model or filesystem work',async()=>{
 await assert.rejects(executeVerification({}, {verificationPurpose:'project-experiment'}, {},new AbortController().signal),e=>e.code==='INTENDED_USE_REQUIRED');
});

test('article prompt does not use the worker directory as the adoption target',()=>{
 const prompt=verificationPrompt({target:'/unrelated/intake-app'},{text:'公開資料'});
 assert.doesNotMatch(prompt,/\/unrelated\/intake-app/);
 assert.match(prompt,/作業ディレクトリは実行上の都合/);
 assert.match(prompt,/恒久的な禁止方針/);
});
