// Verify live GUI compatibility: metadata and rejected calls only, no model prompt.
import {randomUUID} from 'node:crypto';
import {open,access} from 'node:fs/promises';
export const name='intake-knowledge-live-verify';
export const inject=['agents','agentPresets','tools','systemPrompt','sessions'];
const allowed=['intake_read','intake_search'];
const inert=['spawn_teammate','send_message','list_agents','wait_agent','interrupt_agent','team_task_create','team_task_list','team_task_get','team_task_update'];
export function apply(ctx,config){ctx.effect(()=>{
  const task=(async()=>{
    try{await access(config.reportPath);return;}catch(e){if(e.code!=='ENOENT')throw e;}
    let handle,record;
    try{
      handle=await ctx.agents.create({sessionId:randomUUID(),meta:{cwd:'/data/softwares/slack-intake',agentPreset:'intake-knowledge'},
        agentOptions:{provider:'ollama-cloud',model:'deepseek-v4.1-flash',reasoningEffort:'xhigh',maxTokens:4096},
        setup:async scope=>{await ctx.agentPresets.mount(scope,'intake-knowledge');scope.on('agent/pre-step',async()=>({kind:'reject'}));}});
      const agent=handle.agent;
      const visible=ctx.tools.schemas(agent).map(x=>x.name).sort();
      if(allowed.some(x=>!visible.includes(x))||visible.some(x=>![...allowed,...inert].includes(x)))throw new Error('LIVE_TOOL_SURFACE_MISMATCH');
      const prompt=await ctx.systemPrompt.assemble({scope:agent});
      if(prompt.sections.length!==1||!prompt.sections[0].text.includes('collaboration tools; they are disabled'))throw new Error('LIVE_BOUNDARY_MISSING');
      const rejected=[];
      for(const name of inert){
        if(!visible.includes(name))continue;
        const result=await ctx.tools.execute({callId:randomUUID(),name,arguments:{},agent,signal:AbortSignal.timeout(5000)});
        if(!result.isError||!JSON.stringify(result.content).includes('INTAKE_READONLY_SESSION'))throw new Error('COLLABORATION_CALL_NOT_REJECTED');
        rejected.push(name);
      }
      if(agent.session.snapshotEvents().some(e=>['request/context','assistant/message'].includes(e.type)))throw new Error('UNEXPECTED_MODEL_ACTIVITY');
      await ctx.sessions.flush(agent.session);
      record={status:'checked',host_pid:process.pid,preset:'intake-knowledge',session_id:agent.id,visible_tools:visible,enabled_tools:allowed,rejected_tools:rejected,
        model_called:false,tool_bodies_executed:false,boundary_characters:prompt.sections[0].text.length,context_names:prompt.contexts.map(x=>x.name)};
    }catch(e){record={status:'failed',error:String(e.message).slice(0,1200),host_pid:process.pid,model_called:false};}
    finally{await handle?.dispose();}
    const f=await open(config.reportPath,'wx',0o600);try{await f.writeFile(JSON.stringify(record,null,2)+'\n');await f.sync();}finally{await f.close();}
  })().catch(()=>{process.stderr.write('INTAKE_LIVE_VERIFY_FAILED\n');});
  return ()=>task;
});}
