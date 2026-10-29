import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { Context } from '@deepseek-ai/cordis';
import { executeModelToolFixture } from '@deepseek-ai/dsh-tool-testkit';
import { createScope, bindScopeParent } from '@deepseek-ai/dsh-scope';
import AgentLoop from '@deepseek-ai/dsh-agent-loop';
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit';
import { LlmAdapter, ToolCallId } from '@deepseek-ai/dsh-llm';
import { SessionId } from '@deepseek-ai/dsh-session';
import * as plugin from '../index.mjs';

class NoNetworkModel extends LlmAdapter {
  calls = 0;
  async resolveModel(provider, model) { return { provider, id: model, name: model }; }
  async * stream() { this.calls++; throw new Error('Unexpected model request'); }
}

export async function setupRuntime(t, config, { ownTools = [] } = {}) {
  const ctx = new Context();
  t.after(() => ctx.fiber.dispose());
  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } });
  await ctx.plugin(AgentLoop, { agents: [] });
  const adapter = new NoNetworkModel();
  ctx.llm.registerAdapter(['fixture'], adapter);
  const forbidden = { reviews: 0, executions: 0 };
  ctx.on('tools/pre-execute', async (exec, next) => { if (ownTools.includes(exec.name)) forbidden.reviews++; return next(); });
  ctx.tools.register({ name: 'dangerous_write', description: 'Must be invisible to the trial', parameters: {},
    output: { schema: { type: 'string' }, render: (_a,v) => [{type:'text',text:v}] },
    execute: async () => { throw new Error('Write should never execute'); } });
  const key = {};
  let standing;
  await ctx.plugin(Object.assign(inner => { standing = createScope(inner, key); }, { inject: ['tools', 'systemPrompt'] }));
  await standing.ctx.plugin(plugin, config);
  const handle = await ctx.agentLoop.createAgent(ctx, {
    sessionId: SessionId('intake-fixture-' + Math.random().toString(36).slice(2)),
    agentOptions: { provider: 'fixture', model: 'no-network' },
    setup(agentCtx, agent) {
      bindScopeParent(agent, key);
      for (const name of ownTools) agentCtx.tools.register({ name, description: 'Host-injected collaboration definition', parameters: {},
        output: { schema: { type: 'string' }, render: (_a,v) => [{type:'text',text:v}] },
        execute: async () => { forbidden.executions++; return 'must not execute'; } });
    },
  });
  t.after(() => handle.dispose());
  return { ctx, agent: handle.agent, adapter, standing, forbidden };
}

const noHits = {scope_id:'synthetic',scope_revision:1,notice:'reference only',hits:[],truncated:false};

test('Web compatibility rejects every injected Team tool before review or execution', async t => {
  const config={aistoreExecutable:'/trusted/aistore',storeRoot:'/private/store',scopeFile:'/private/scope',allowInertTeamTools:true};
  const {ctx,agent,adapter,forbidden}=await setupRuntime(t,config,{ownTools:plugin.inertTeamToolNames});
  assert.equal(ctx.tools.schemas(agent).length,11);
  for(const name of plugin.inertTeamToolNames){
    const v=await executeModelToolFixture(ctx, {callId:ToolCallId('denied-'+name),name,arguments:{},agent,signal:new AbortController().signal});
    assert.equal(v.isError,true);
    assert.ok(JSON.stringify(v.content).includes('INTAKE_READONLY_SESSION'));
  }
  assert.deepEqual(forbidden,{reviews:0,executions:0});
  assert.equal(adapter.calls,0);
});

test('Web compatibility still refuses an unknown local capability', async t => {
  await assert.rejects(setupRuntime(t,{aistoreExecutable:'/trusted/aistore',storeRoot:'/private/store',scopeFile:'/private/scope',allowInertTeamTools:true},{ownTools:['unexpected_write']}),/INTAKE_UNEXPECTED_SCOPED_TOOLS/);
});

test('real scoped registry exposes only two tools and enforces read limits', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'intake-runtime-test-'));
  t.after(async () => { assert.equal(resolve(dir),dir); assert.ok(dir.startsWith(join(tmpdir(),'intake-runtime-test-'))); await rm(dir,{recursive:true}); });
  const exe = join(dir,'aistore');
  await writeFile(exe, `#!${process.execPath}\nprocess.stdin.resume();process.stdin.on('end',()=>process.stdout.write(${JSON.stringify(JSON.stringify({protocol_version:1,result:{ok:true,value:noHits}}))}));`, {mode:0o700});
  const { ctx, agent, adapter } = await setupRuntime(t,{aistoreExecutable:exe,storeRoot:dir,scopeFile:join(dir,'scope.json')});
  assert.deepEqual(ctx.tools.schemas(agent).map(x=>x.name).sort(), ['intake_read','intake_search']);
  assert.equal(ctx.tools.get('dangerous_write',agent),undefined);
  assert.ok(ctx.tools.get('dangerous_write'));
  const call = (name, args, n) => executeModelToolFixture(ctx, {callId:ToolCallId('call-'+n),name,arguments:args,agent,signal:new AbortController().signal});
  for (let i=0;i<2;i++) {
    const v=await call('intake_search',{query:'memory'},i);
    assert.equal(v.isError,false,JSON.stringify(v));
    assert.deepEqual(v.value,noHits);
  }
  assert.equal((await call('intake_search',{query:'memory'},3)).isError,true);
  assert.equal((await call('dangerous_write',{},4)).isError,true);
  // A later global registration stays hidden by the allow mask.
  ctx.tools.register({name:'late_write',description:'late',parameters:{},output:{schema:{type:'string'},render:()=>[]},execute:async()=>{throw Error('must not run');}});
  assert.equal(ctx.tools.get('late_write',agent),undefined);
  assert.equal(adapter.calls,0);
  const toolSet=await ctx.tools.resolve({agent,modelSelection:agent.model.current(),signal:new AbortController().signal});
  t.after(()=>toolSet.dispose());
  const prompt=await ctx.systemPrompt.assemble({scope:agent,toolSet});
  assert.deepEqual([...toolSet.view(agent).keys()].sort(),['intake_read','intake_search']);
  assert.ok(prompt.sections.some(x=>x.text.includes('untrusted reference data')));
});

test('real Go CLI and real registry read only the approved synthetic scope', {skip: !process.env.INTAKE_KNOWLEDGE_FIXTURE}, async t => {
  const fixture=JSON.parse(await readFile(process.env.INTAKE_KNOWLEDGE_FIXTURE,'utf8'));
  assert.equal(fixture.synthetic,true);
  const config={aistoreExecutable:process.env.AISTORE_KNOWLEDGE_BINARY,storeRoot:fixture.storeRoot,scopeFile:fixture.scopeFile};
  const dbPath=join(fixture.storeRoot,'data/store.sqlite3');
  const before=await readFile(dbPath);
  const scopeBefore=await readFile(fixture.scopeFile);
  const {ctx,agent,adapter}=await setupRuntime(t,config);
  const invoke=(name,args,id)=>executeModelToolFixture(ctx, {callId:ToolCallId(id),name,arguments:args,agent,signal:new AbortController().signal});
  const found=await invoke('intake_search',{query:'counterfoil'},'actual-search');
  assert.equal(found.isError,false,JSON.stringify(found));
  assert.equal(found.value.hits.length,1);
  assert.equal(found.value.hits[0].identity,fixture.identity);
  assert.equal(found.value.hits[0].material_version,fixture.materialVersion);
  const miss=await invoke('intake_search',{query:'PRIVATE_RAW_BODY_ONLY PRIVATE_UNSHARED_ARTICLE PRIVATE_SLACK'},'actual-unshared');
  assert.equal(miss.isError,false,JSON.stringify(miss));
  assert.equal(miss.value.hits.length,0);
  const read=await invoke('intake_read',{identity:fixture.identity,material_version:fixture.materialVersion},'actual-read');
  assert.equal(read.isError,false,JSON.stringify(read));
  assert.ok(read.value.text.includes('counterfoil'));
  assert.equal(read.value.content_kind,'approved_article');
  assert.ok(!JSON.stringify(read).includes('PRIVATE_'));
  const forbidden=await invoke('intake_read',{identity:fixture.unsharedIdentity,material_version:fixture.materialVersion},'actual-forbidden');
  assert.equal(forbidden.isError,true);
  assert.deepEqual(await readFile(dbPath),before);
  assert.deepEqual(await readFile(fixture.scopeFile),scopeBefore);
  await assert.rejects(stat(fixture.stateHome),{code:'ENOENT'});
  assert.equal(adapter.calls,0);
});
