// Official CLI mount check. No prompt, model request, source read, or Slack call.
import { randomUUID } from 'node:crypto';
import { open } from 'node:fs/promises';
export const name = 'intake-knowledge-mount-check';
export const inject = ['agents', 'agentPresets', 'tools', 'systemPrompt', 'sessions'];
export function apply(ctx, config) {
  const ready=ctx.get('appReady'), exit=ctx.get('appExit');
  if(!ready||!exit) throw new Error('Official standalone lifecycle is required');
  ctx.effect(()=>{
    const controller=new AbortController();
    let task=Promise.resolve();
    const off=ready.onReady(()=>{
      task=(async()=>{
        let handle;
        let record;
        try {
          const preset=await ctx.agentPresets.resolve(config.presetId);
          if(preset.broken) throw new Error('Preset activation failed: '+preset.broken);
          handle=await ctx.agents.create({sessionId:randomUUID(),meta:{cwd:config.cwd,agentPreset:config.presetId},
            agentOptions:{provider:'ollama-cloud',model:'deepseek-v4.1-flash',reasoningEffort:'xhigh',maxTokens:4096},
            signal:controller.signal,setup:async scope=>{await ctx.agentPresets.mount(scope,config.presetId);}});
          const agent=handle.agent;
          const tools=ctx.tools.schemas(agent).map(x=>x.name).sort();
          if(tools.join(',')!=='intake_read,intake_search') throw new Error('Unexpected tools: '+tools.join(','));
          const prompt=await ctx.systemPrompt.assemble({scope:agent});
          if(prompt.tools.map(x=>x.name).sort().join(',')!==tools.join(',')) throw new Error('Prompt schema differs');
          if(prompt.sections.length!==1 || !prompt.sections[0].text.includes('untrusted reference data') || !prompt.sections[0].text.includes('Answer in Japanese')) throw new Error('Read-only boundary prompt is missing');
          if(agent.session.snapshotEvents().some(x=>['request/context','assistant/message'].includes(x.type))) throw new Error('Unexpected model activity');
          await ctx.sessions.flush(agent.session);
          record={status:'checked',preset:config.presetId,tools,model_called:false,source_read:false,session_id:agent.id,
            tool_schema_json_bytes:Buffer.byteLength(JSON.stringify(prompt.tools)),
            prompt_section_characters:prompt.sections.reduce((n,x)=>n+x.text.length,0)};
        } finally { await handle?.dispose(); }
        const file=await open(config.reportPath,'wx',0o600);
        try {await file.writeFile(JSON.stringify(record,null,2)+'\n');await file.sync();} finally {await file.close();}
        process.stdout.write(JSON.stringify(record)+'\n');exit(0);
      })().catch(error=>{process.stderr.write('INTAKE_MOUNT_CHECK_FAILED: '+error.message+'\n');exit(1);});
    });
    return async()=>{controller.abort();off();await task;};
  });
}
