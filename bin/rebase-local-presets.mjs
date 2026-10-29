/** Three-way rebase local preset declarations onto the selected official presets. */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const target=resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node rebase-local-presets.mjs TARGET_DSH');
const root=resolve(import.meta.dirname,'..');
const yaml=createRequire(join(target,'package.json'))('js-yaml');
class Expression { constructor(text){this.text=text;} }
const schema=yaml.JSON_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js',{kind:'scalar',construct:text=>new Expression(text),instanceOf:Expression,represent:value=>value.text}));
const parse=text=>yaml.load(text,{schema});
const same=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
function merge(base,local,next){
 if(same(base,local))return next;
 if(Array.isArray(base)&&Array.isArray(local)&&Array.isArray(next)&&[...base,...local,...next].every(x=>x&&typeof x.id==='string')){
  const result=next.filter(x=>!base.some(b=>b.id===x.id)||local.some(l=>l.id===x.id)).map(x=>{
   const b=base.find(b=>b.id===x.id),l=local.find(l=>l.id===x.id);
   return l&&b?merge(b,l,x):x;
  });
  for(const l of local){const b=base.find(x=>x.id===l.id);if(!next.some(x=>x.id===l.id)&&(!b||!same(l,b)))result.push(l);}
  return result;
 }
 if(base&&local&&next&&typeof base==='object'&&typeof local==='object'&&typeof next==='object'&&!Array.isArray(base)&&!(base instanceof Expression)){
  const result={...next};
  for(const key of Object.keys(base))if(!Object.hasOwn(local,key))delete result[key];
  for(const [key,value]of Object.entries(local))if(!same(base[key],value))result[key]=Object.hasOwn(base,key)&&Object.hasOwn(next,key)?merge(base[key],value,next[key]):value;
  return result;
 }
 return local;
}
function normalize(value){
 if(!value||typeof value!=='object')return;
 if(value.name==='@deepseek-ai/dsh-persona'&&value.config?.suffix==='Your working directory is {{cwd}}.')delete value.config.suffix;
 if(value.name==='@deepseek-ai/dsh-tool-subagent'&&value.config){delete value.config.backgroundMode;delete value.config.enableRunInBackground;}
 if(value.name==='@deepseek-ai/dsh-tool-workflow')value.name='@kkiyama117/dsh-workflow-results';
 for(const child of Object.values(value))normalize(child);
}
for(const id of ['cordis-kura','managed-cordis','managed-standard','ai-reference-store-next']){
 const kind=id.includes('cordis')?'cordis':'standard';
 const path=`packages/bundle/web-app/presets/${kind}.patch.yml`;
 const old=parse(execFileSync('git',['-C',target,'show',`5badb15009:${path}`],{encoding:'utf8'}))[0].insert[0];
 const local=parse(await readFile(`/home/kiyama/.dsh/.agent-presets/${id}/cordis.patch.yml`,'utf8'))[0].insert[0];
 const next=parse(await readFile(join(target,path),'utf8'))[0].insert[0];
 const row=merge(old,local,next);normalize(row);
 row.config.plugins=row.config.plugins.filter(plugin=>plugin.name!=='@kkiyama117/dsh-prompt-compact');
 if(id==='cordis-kura')row.config.description='Cordis coding tools with shared Kura memory and official explicit-request workflow guidance.';
 // Keep the target's plan-mode guidance; it fixes approval semantics.
 const find=(rows,id)=>rows.flatMap(r=>[r,...(r.group?findAll(r.config):[])]).find(r=>r.id===id);
 const findAll=rows=>rows.flatMap(r=>[r,...(r.group?findAll(r.config):[])]);
 const planning=find(row.config.plugins,'plan-mode'),canonical=find(next.config.plugins,'plan-mode');
 if(planning&&canonical)planning.config=canonical.config;
 const dir=join(root,'presets',id);await mkdir(dir,{recursive:true});
 await writeFile(join(dir,'cordis.patch.yml'),yaml.dump([{insert:[row]}],{schema,lineWidth:-1,noRefs:true}));
 const manifest=JSON.parse(await readFile(`/home/kiyama/.dsh/.agent-presets/${id}/package.json`,'utf8'));
 manifest.version='1.1.0';manifest.description=`${row.config.name??id}: local changes rebased on official DSH 0.2.1-alpha.2`;
 manifest.peerDependencies={'@deepseek-ai/dsh-agent-preset':'0.2.1-alpha.2'};
 await writeFile(join(dir,'package.json'),JSON.stringify(manifest,null,2)+'\n');
 await writeFile(join(dir,'UPSTREAM.json'),JSON.stringify({base:'5badb15009ae1756c3afe0ae0cef1faafc290ccc',target:'d743267388641bc76f17c45ce8b4c231aed1d32c',template:path,method:'three-way local changes; removed cwd/backgroundMode; current plan guidance; independent workflow package'},null,2)+'\n');
 console.log(id);
}
