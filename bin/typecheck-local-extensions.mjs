/** Type-check external consumers against one selected DSH build and its project declarations. */
import { createRequire } from 'node:module';
import { resolve, join } from 'node:path';
const target = resolve(process.argv[2] ?? '');
if (!process.argv[2]) throw new Error('Usage: node typecheck-local-extensions.mjs TARGET_DSH');
const root = resolve(import.meta.dirname, '..');
const ts = createRequire(join(target, 'package.json'))('typescript');
const path = join(target, 'tsconfig.base.json');
const raw = ts.readConfigFile(path, ts.sys.readFile);
if (raw.error) throw new Error(ts.flattenDiagnosticMessageText(raw.error.messageText, '\n'));
const parsed = ts.parseJsonConfigFileContent(raw.config, ts.sys, target);
const options = { ...parsed.options, noEmit: true, composite: false, incremental: false, rootDir: undefined, rewriteRelativeImportExtensions: false,
  typeRoots: [join(target, 'node_modules/@types')], types: ['node'], paths: { ...parsed.options.paths, '@test-target/*': [join(target, '*')] } };
const host = ts.createCompilerHost(options);
host.getCurrentDirectory = () => target;
host.resolveModuleNames = (names, containingFile) => names.map(name => {
  const found = ts.resolveModuleName(name, containingFile, options, host).resolvedModule;
  if (found || name.startsWith('.')) return found;
  return ts.resolveModuleName(name, join(target, 'consumer.ts'), options, host).resolvedModule
    ?? ts.resolveModuleName(name, join(target, 'packages/llm/llm-pi-ai/consumer.ts'), options, host).resolvedModule;
});
const hostConfig = ts.getParsedCommandLineOfConfigFile(join(target, 'tsconfig.host.json'), {}, { ...ts.sys, onUnRecoverableConfigFileDiagnostic: diagnostic => { throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')); } });
if (!hostConfig) throw new Error('Cannot parse target Host project references');
const program = ts.createProgram({ rootNames: [join(root, 'plugins/dsh-workflow-results/src/index.ts'), join(root, 'plugins/dsh-session-cleanup/src/index.ts'), join(root, 'plugins/dsh-goal-acceptance/src/index.ts'), join(root, 'plugins/dsh-goal-acceptance/tests/acceptance.spec.ts'), join(root, 'plugins/dsh-goal-acceptance/tests/composition.spec.ts')], options, host, projectReferences: hostConfig.projectReferences });
const diagnostics = ts.getPreEmitDiagnostics(program);
if (diagnostics.length) {
  console.error(ts.formatDiagnosticsWithColorAndContext(diagnostics, { getCanonicalFileName: x => x, getCurrentDirectory: () => root, getNewLine: () => '\n' }));
  process.exitCode = 1;
} else console.log('External workflow/session-cleanup/acceptance TypeScript passed against the selected target.');
