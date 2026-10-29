// One explicitly authorized model trial in a fresh official headless process.
// Not a model-facing tool, not installed globally, and never auto-retried.
import { createHash, randomUUID } from 'node:crypto';
import { readFile, open, mkdir } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { createUserMessage } from '@deepseek-ai/dsh-llm';
export const name='intake-knowledge-one-question';
export const inject=['agents','agentPresets','tools','systemPrompt','sessions','llm'];
export const route=Object.freeze({provider:'ollama-cloud',model:'deepseek-v4.1-flash',reasoningEffort:'xhigh',maxTokens:4096});
const sha=text=>createHash('sha256').update(text).digest('hex');
const sameRoute=value=>Object.entries(route).every(([k,v])=>value[k]===v);

export function createLimiter(sessionId) {
  const requests=[];
  return {requests,admit(options){
    if(options.sessionId!==sessionId||options.purpose||!sameRoute(options)) throw new Error('PILOT_ROUTE_MISMATCH');
    if(requests.length>=4) throw new Error('PILOT_REQUEST_LIMIT');
    const serialized=JSON.stringify({system:options.system,messages:options.messages,tools:options.tools,toolHistory:options.toolHistory});
    // User explicitly removed the proposed input-byte cap. Measure, do not cap.
    requests.push({number:requests.length+1,provider:options.provider,model:options.model,effort:options.reasoningEffort,max_output_tokens:options.maxTokens,input_json_bytes:Buffer.byteLength(serialized),input_sha256:sha(serialized)});
  }};
}
async function saveNew(path,value) {
  const f=await open(path,'wx',0o600);
  try {await f.writeFile(typeof value==='string'?value:JSON.stringify(value,null,2)+'\n');await f.sync();}finally{await f.close();}
}

export async function runPilot(ctx,config,outerSignal) {
  if(!isAbsolute(config.packetPath)) throw new Error('PILOT_PACKET_REQUIRED');
  const packet=JSON.parse(await readFile(config.packetPath,'utf8'));
  if(packet.version!==1||packet.allow_unknown_cost_one_question!==true||packet.input_limit!==null||!isAbsolute(packet.outputDir)||
    !isAbsolute(packet.scopeFile)||typeof packet.question!=='string'||!packet.question.trim()||!packet.approvalId||packet.maxQuestions!==1) throw new Error('PILOT_AUTHORIZATION_REQUIRED');
  const scopeBytes=await readFile(packet.scopeFile);
  const scope=JSON.parse(scopeBytes);
  if(sha(scopeBytes)!==packet.scopeHash||!scope.approved_at||!scope.approval_id) throw new Error('PILOT_SCOPE_CHANGED');
  const resolved=await ctx.llm.resolveCallConfig(route);
  if(!sameRoute(resolved)) throw new Error('PILOT_ROUTE_MISMATCH');
  const retry=ctx.llm.providerRetryPolicy(route.provider);
  if(retry.mode!=='normal'||retry.maxRetries!==0) throw new Error('PILOT_RETRY_NOT_DISABLED');
  await mkdir(packet.outputDir,{recursive:true,mode:0o700});
  // Exclusive persistent start marker consumes this one trial even if a response is lost.
  const sessionId=randomUUID();
  await saveNew(join(packet.outputDir,'started.json'),{session_id:sessionId,approval_id:packet.approvalId,scope_hash:packet.scopeHash,question_hash:sha(packet.question),route,input_limit:null,max_requests:4,output_tokens_per_request:4096,deadline_seconds:300,reported_cost:null});
  const controller=new AbortController();
  const abort=()=>controller.abort('trial interrupted');
  outerSignal?.addEventListener('abort',abort,{once:true});
  if(outerSignal?.aborted) abort();
  const limiter=createLimiter(sessionId);
  let handle,record,offStream;
  let proposals=0;
  const timer=setTimeout(()=>{controller.abort('five-minute deadline');handle?.agent.cancel({kind:'hook',reason:'pilot deadline'});},300000);
  const cancel=()=>handle?.agent.cancel({kind:'parent'});
  controller.signal.addEventListener('abort',cancel,{once:true});
  try {
    offStream=ctx.on('llm/stream',async function* (options,next){limiter.admit(options);yield* next();},{prepend:true});
    handle=await ctx.agents.create({sessionId,meta:{cwd:config.cwd,agentPreset:config.presetId},agentOptions:route,signal:controller.signal,
      setup:async (agentCtx,agent)=>{
        await ctx.agentPresets.mount(agentCtx,config.presetId);
        agentCtx.on('agent/pre-step',async (_p,next)=>limiter.requests.length>=4||controller.signal.aborted?{kind:'reject'}:next());
        agentCtx.on('agent/request',async (_p,next)=>{const current=await next();proposals++;return {...current,...route};});
        agentCtx.tools.guard(()=>proposals>=4?'PILOT_FINAL_REQUEST: return the available answer without more tools.':undefined);
      }});
    const agent=handle.agent;
    if(ctx.tools.schemas(agent).map(x=>x.name).sort().join(',')!=='intake_read,intake_search') throw new Error('PILOT_TOOL_MISMATCH');
    agent.followup(createUserMessage({content:[{type:'text',text:packet.question}],source:{kind:'user'}}));
    await agent.whenIdle();
    if(!await ctx.sessions.flush(agent.session)) throw new Error('PILOT_SESSION_NOT_DURABLE');
    const events=agent.session.snapshotEvents();
    const assistants=events.filter(e=>e.type==='assistant/message');
    const headers=events.filter(e=>e.type==='request/header');
    if(headers.some(e=>!sameRoute(e.data.header.config))||assistants.some(e=>e.data.message.source.provider!==route.provider||e.data.message.source.model!==route.model)) throw new Error('PILOT_RECORDED_ROUTE_MISMATCH');
    const end=events.findLast(e=>e.type==='turn/end');
    const final=assistants.at(-1)?.data.message.content.filter(b=>b.type==='text').map(b=>b.text).join('\n')||'';
    const usages=assistants.map(e=>e.data.usage??null);
    record={status:end?.data.reason.kind==='completed'&&final&&!controller.signal.aborted?'answered':'incomplete',session_id:sessionId,route,
      approval_id:packet.approvalId,scope_hash:packet.scopeHash,requests:limiter.requests,request_proposals:proposals,
      assistant_completions:assistants.length,reported_token_usage:usages,reported_cost:null,input_limit:null,
      turn_end:end?.data.reason??null,tools:events.filter(e=>e.type==='tool/call').map(e=>({name:e.data.name,arguments:JSON.parse(e.data.arguments)})),
      tool_failures:events.filter(e=>e.type==='tool/result'&&e.data.message.isError).length,
      factual_accuracy_evaluated:false};
    await saveNew(join(packet.outputDir,'answer.md'),final+'\n');
  } catch(error) {
    record={status:'failed',session_id:sessionId,code:String(error.message).slice(0,200),requests:limiter.requests,reported_cost:null,input_limit:null};
  } finally {
    clearTimeout(timer);outerSignal?.removeEventListener('abort',abort);controller.signal.removeEventListener('abort',cancel);
    await handle?.dispose();offStream?.();
  }
  await saveNew(join(packet.outputDir,'result.json'),record);
  return record;
}

export function apply(ctx,config) {
  const ready=ctx.get('appReady'),exit=ctx.get('appExit');
  if(!ready||!exit) throw new Error('Official standalone lifecycle required');
  ctx.effect(()=>{
    const controller=new AbortController();let task=Promise.resolve();
    const off=ready.onReady(()=>{
      task=runPilot(ctx,config,controller.signal).then(result=>{
        process.stdout.write(JSON.stringify({status:result.status,session_id:result.session_id,model_requests:result.requests.length,reported_cost:null})+'\n');
        exit(result.status==='answered'?0:1);
      }).catch(error=>{process.stderr.write('PILOT_STOPPED_BEFORE_DISPATCH: '+error.message+'\n');exit(1);});
    });
    return async()=>{controller.abort();off();await task;};
  });
}
