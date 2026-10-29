/** Stage deployment inputs in a new private home, with isolated persistence and no automation starts. */
import { readFile, writeFile, mkdir, cp } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { createRequire } from 'node:module';
const [targetArg, homeArg] = process.argv.slice(2);
if (!targetArg || !homeArg) throw new Error('Usage: node stage-weekly-upgrade.mjs TARGET_DSH NEW_HOME');
const target = resolve(targetArg), home = resolve(homeArg), live = '/home/kiyama/.dsh';
const plugins = resolve(import.meta.dirname, '..');
const require = createRequire(join(target, 'package.json'));
const yaml = require('js-yaml');
class Expression { constructor(text) { this.text = text; } }
const schema = yaml.JSON_SCHEMA.extend(new yaml.Type('tag:yaml.org,2002:js', { kind:'scalar', construct:text=>new Expression(text), instanceOf:Expression, represent:value=>value.text }));
const load = async p => yaml.load(await readFile(p,'utf8'),{schema});
const dump = v => yaml.dump(v,{schema,lineWidth:-1,noRefs:true});
await mkdir(home,{mode:0o700});
await mkdir(join(home,'profiles/web'),{recursive:true,mode:0o700});
const manifest=JSON.parse(await readFile(join(live,'profiles/web/package.json'),'utf8'));
const latest={'dshmarket':'1.66.19','dsh-better-sidebar':'0.25.0','@linxin666/dsh-client-ui-skill-explorer':'0.4.6','@linxin666/dsh-client-ui-web-ui-settings':'0.4.6','@linxin666/dsh-remote-web-ui':'0.4.6','@nonamelego/dsh-catppuccin':'0.6.1'};
Object.assign(manifest.dependencies,latest);
manifest.dependencies['@kkiyama117/dsh-slack-intake']=`link:${plugins}/compat/slack-intake-alpha2`;
manifest.dependencies['@deepseek-ai/dsh-web-search-exa']=`link:${target}/packages/web/web-search-exa`;
for (const [name,dir] of Object.entries({'@kkiyama117/dsh-workflow-results':'dsh-workflow-results','@kkiyama117/dsh-session-cleanup':'dsh-session-cleanup','@local/dsh-slack-digest':'compat/slack-digest-alpha2','@local/dsh-intake-knowledge-reader':'compat/intake-knowledge-alpha2'})) manifest.dependencies[name]=`link:${plugins}/${dir}`;
for (const name of ['@local/dsh-harness-improvement-launcher','@local/dsh-energy-followup']) {
 delete manifest.dependencies[name];
 manifest.dsh.profile.bundles=manifest.dsh.profile.bundles.filter(x=>x!==name);
}
for (const name of ['@kkiyama117/dsh-workflow-results','@kkiyama117/dsh-session-cleanup']) manifest.dsh.profile.bundles.push(name);
for (const id of ['cordis-kura','managed-cordis','managed-standard','ai-reference-store-next']) {
 const name=`@local/dsh-${id}-preset`;
 manifest.dependencies[name]=`link:${plugins}/presets/${id}`;
}
await writeFile(join(home,'profiles/web/package.json'),JSON.stringify(manifest,null,2)+'\n',{mode:0o600});
await writeFile(join(home,'profiles/web/cordis.yml'),'[]\n');
const patch=await load(join(live,'profiles/web/cordis.patch.yml'));
// Stage-only disabled integrations must not deliver messages, expose a remote tunnel or call Zotero.
for (const id of ['remote-web-ui','mcp-zotero','session-title-llm','harness-improvement-model-selection','energy-followup-once']) {
 if (['harness-improvement-model-selection','energy-followup-once'].includes(id)) continue;
 const row=patch.find(x=>x.id===id);if(row)row.disabled=true;else patch.push({id,disabled:true});
}
await writeFile(join(home,'profiles/web/cordis.patch.yml'),dump(patch),{mode:0o600});
// Never copy the home patch: it redirects all persistence into the live recovery tree.
await writeFile(join(home,'cordis.patch.yml'),'[]\n');
console.log(JSON.stringify({home,target,isolatedPersistence:true,liveConfigurationChanged:false}));
