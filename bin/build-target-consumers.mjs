/** Strict target-runtime consumer check followed by ESM emission for the selected external packages. */
import {createRequire} from 'node:module';
import {readFileSync,readdirSync,writeFileSync,mkdirSync,existsSync} from 'node:fs';
import {resolve,join,dirname,isAbsolute} from 'node:path';
const [target,...directories]=process.argv.slice(2);
if(!target||!isAbsolute(target)||directories.length===0)throw Error('Usage: build-target-consumers.mjs ABSOLUTE_DSH PACKAGE...');
const ts=createRequire(join(target,'package.json'))('typescript');
const config=ts.readConfigFile(join(target,'tsconfig.base.json'),ts.sys.readFile);
if(config.error)throw Error(ts.flattenDiagnosticMessageText(config.error.messageText,'\n'));
const parsed=ts.parseJsonConfigFileContent(config.config,ts.sys,target);
const files=[];
for(const directory of directories){const root=resolve(directory);for(const file of readdirSync(join(root,'src'),{recursive:true})){if(file.endsWith('.ts')&&!file.endsWith('.d.ts'))files.push({source:join(root,'src',file),output:join(root,'lib',file.replace(/\.ts$/,'.js'))});}}
const paths={zod:[join(target,'node_modules/zod/index.d.ts')]};
function addManifest(directory){const file=join(directory,'package.json');if(!existsSync(file))return;const p=JSON.parse(readFileSync(file,'utf8'));if(p.types)paths[p.name]=[join(directory,p.types)];for(const [key,value] of Object.entries(p.exports??{})){const types=typeof value==='object'&&value!==null?value.types:undefined;if(typeof types==='string')paths[p.name+(key==='.'?'':key.slice(1))]=[join(directory,types)];}}
for(const group of readdirSync(join(target,'packages'),{withFileTypes:true}).filter(x=>x.isDirectory()))for(const entry of readdirSync(join(target,'packages',group.name),{withFileTypes:true}).filter(x=>x.isDirectory()))addManifest(join(target,'packages',group.name,entry.name));
for(const entry of readdirSync(join(target,'vendor'),{withFileTypes:true}).filter(x=>x.isDirectory()))addManifest(join(target,'vendor',entry.name));
addManifest(join(target,'packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai'));
const options={...parsed.options,strict:true,noEmit:true,incremental:false,composite:false,allowImportingTsExtensions:true,skipLibCheck:true,types:['node'],typeRoots:[join(target,'node_modules/@types')],paths};
const program=ts.createProgram({rootNames:files.map(x=>x.source),options});
const errors=ts.getPreEmitDiagnostics(program);
if(errors.length){console.error(ts.formatDiagnosticsWithColorAndContext(errors,{getCanonicalFileName:x=>x,getCurrentDirectory:()=>process.cwd(),getNewLine:()=> '\n'}));process.exit(1);}
for(const file of files){const result=ts.transpileModule(readFileSync(file.source,'utf8'),{fileName:file.source,reportDiagnostics:true,compilerOptions:{target:ts.ScriptTarget.ES2024,module:ts.ModuleKind.ESNext,rewriteRelativeImportExtensions:true}});if(result.diagnostics?.some(x=>x.category===ts.DiagnosticCategory.Error))throw Error('Emission failed: '+file.source);mkdirSync(dirname(file.output),{recursive:true});writeFileSync(file.output,result.outputText);}
console.log(JSON.stringify({status:'passed',strict:true,files:files.length,packages:directories}));
