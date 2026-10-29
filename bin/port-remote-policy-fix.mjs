/** Port the reviewed bootstrap/lifetime fix onto a pristine npm 0.4.6 copy. */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, writeFile, cp, mkdir, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import vm from 'node:vm';
const root=resolve(import.meta.dirname,'..');
const source='/home/kiyama/.dsh/profiles/web/node_modules/@linxin666/dsh-remote-web-ui';
const target=join(root,'compat/remote-web-ui-alpha2');
const version=JSON.parse(await readFile(join(source,'package.json'),'utf8')).version;
assert.equal(version,'0.4.6');
await mkdir(target);
await cp(source,target,{recursive:true,dereference:true,filter:path=>!path.split('/').includes('node_modules')||path.startsWith(source)&&!path.slice(source.length).split('/').includes('node_modules')});
const script=await readFile(join(root,'compat/dsh-remote-web-ui/local-fix/patch.mjs'),'utf8');
// The inspected constant contains only a map of literal replacement strings.
const literal=script.slice(script.indexOf('const patches = ')+16,script.indexOf('\n\nconst hash ='));
const patches=vm.runInNewContext('('+literal.replace(/;\s*$/,'')+')',Object.create(null),{timeout:1000});
delete patches['package.json'];
const before={};
async function inventory(dir,prefix=''){
 for(const entry of await readdir(dir,{withFileTypes:true})){
  const name=prefix+entry.name,path=join(dir,entry.name);
  if(entry.isDirectory())await inventory(path,name+'/');
  else if(entry.isFile())before[name]=createHash('sha256').update(await readFile(path)).digest('hex');
 }
}
await inventory(target);
const changed=new Map();
for(const [file,operations]of Object.entries(patches)){
 let text=await readFile(join(target,file),'utf8');
 for(const [old,next]of operations){assert.equal(text.split(old).length-1,1,`${file}: expected one literal match`);text=text.replace(old,next);}
 changed.set(file,text);
}
for(const [file,text]of changed)await writeFile(join(target,file),text);
const manifest=JSON.parse(await readFile(join(target,'package.json'),'utf8'));
manifest.version='0.4.6-local.1';
manifest.files.push('UPGRADE.json','local-fix');
await writeFile(join(target,'package.json'),JSON.stringify(manifest,null,2)+'\n');
await mkdir(join(target,'local-fix'));
for(const file of ['bootstrap-policy.test.mjs','remote-channel.test.mjs'])await cp(join(root,'compat/dsh-remote-web-ui/local-fix',file),join(target,'local-fix',file));
await writeFile(join(target,'local-fix/base-sha256.json'),JSON.stringify(before,null,2)+'\n');
await writeFile(join(target,'UPGRADE.json'),JSON.stringify({base:'@linxin666/dsh-remote-web-ui@0.4.6',version:manifest.version,changedFiles:[...changed.keys(),'package.json'],retainedFix:'0.4.4-local.2 bootstrap policy and retired-channel lifetime; authentication/gating code unchanged',verification:'pending'},null,2)+'\n');
console.log(JSON.stringify({target,changed:[...changed.keys()]}));
