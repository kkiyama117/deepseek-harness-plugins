/** Explicit target-runtime resolution for maintained external package regressions. */
import { createRequire } from 'node:module';
import { resolve, join, isAbsolute } from 'node:path';
const target = process.env.DSH_TEST_TARGET;
if (!target || !isAbsolute(target)) throw new Error('DSH_TEST_TARGET must name the exact DSH checkout under test');
const root = resolve(import.meta.dirname, '..');
const ts = createRequire(join(target, 'package.json'))('typescript');
const parsed = ts.readConfigFile(join(target, 'tsconfig.base.json'), ts.sys.readFile);
if (parsed.error) throw new Error(ts.flattenDiagnosticMessageText(parsed.error.messageText, '\n'));
const aliases = Object.entries(parsed.config.compilerOptions.paths).map(([name, paths]) => ({
  find: new RegExp('^' + name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace('\\*', '(.*)') + '$'),
  replacement: resolve(target, paths[0].replace('*', '$1')),
})).sort((a,b) => b.find.source.length - a.find.source.length);
aliases.push({find:/^@test-target\/(.*)$/,replacement:join(target,'$1')});
aliases.push({find:/^zod$/,replacement:createRequire(join(target,'package.json')).resolve('zod')});
aliases.push({find:/^@earendil-works\/pi-ai$/,replacement:join(target,'packages/llm/llm-pi-ai/node_modules/@earendil-works/pi-ai/dist/index.js')});
export default {
  root,
  resolve: {alias:aliases},
  plugins: [{name:'target-standard-decorators',enforce:'pre',transform(code,id){
    const file=id.split('?',1)[0];
    if(!/\.[cm]?tsx?$/.test(file)||!/^\s*@[A-Za-z_$][\w$]*/m.test(code))return;
    return ts.transpileModule(code,{fileName:file,compilerOptions:{target:ts.ScriptTarget.ES2024,module:ts.ModuleKind.ESNext,jsx:file.endsWith('x')?ts.JsxEmit.ReactJSX:undefined}}).outputText;
  }}],
  test:{
    include:['tests/upgrade/*.spec.ts','plugins/dsh-goal-acceptance/tests/*.spec.ts'],pool:'forks',maxWorkers:2,
    execArgv:process.allowedNodeEnvironmentFlags.has('--webstorage')?['--no-webstorage']:[],
    setupFiles:[join(target,'scripts/test-proxy-environment.ts'),join(target,'scripts/test-dom-environment.ts')],
    testTimeout:15000,hookTimeout:15000,
    server:{deps:{inline:[/deepseek-harness-plugins/]}},
  },
};
