/** Test-only resolution to the explicitly selected built host; never use the plugins root's stale peers. */
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.env.DSH_HOST_ROOT;
if (!root || !isAbsolute(root)) throw new Error('Set DSH_HOST_ROOT to the built DSH checkout for tests');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
const cordisVersions = { '0.1.6-alpha.1': '4.0.2', '0.2.1-alpha.1': '4.0.5-alpha.1', '0.2.1-alpha.2': '4.0.5-alpha.1', '0.2.1-rc.2': '4.0.5' };
if (!cordisVersions[version]) throw new Error(`Unreviewed host version: ${version}`);
const packages = {
  '@deepseek-ai/cordis': ['vendor/cordis', cordisVersions[version]],
  '@deepseek-ai/cordis-plugin-loader': ['vendor/loader', '1.0.6'],
  '@deepseek-ai/cordis-plugin-include': ['vendor/include', '1.0.10'],
  '@deepseek-ai/dsh-agent-preset-registry': ['packages/preset/agent-preset-registry', version],
  '@deepseek-ai/dsh-agent-loop': ['packages/core/agent-loop', version],
  '@deepseek-ai/dsh-agent-loop-testkit': ['packages/test-support/agent-loop-testkit', version],
  '@deepseek-ai/dsh-credentials': ['packages/credentials/credentials', version],
  '@deepseek-ai/dsh-llm': ['packages/llm/llm', version],
  '@deepseek-ai/dsh-session': ['packages/core/session', version],
  '@deepseek-ai/dsh-scope': ['packages/core/scope', version],
  '@deepseek-ai/dsh-session-query': ['packages/session-query/session-query', version],
  '@deepseek-ai/dsh-session-persistence-jsonl': ['packages/session/session-persistence-jsonl', version],
  '@deepseek-ai/dsh-subagent': ['packages/subagent/subagent', version],
  '@deepseek-ai/dsh-subagent-spawn-in-process': ['packages/subagent/subagent-spawn-in-process', version],
  '@deepseek-ai/dsh-tools': ['packages/core/tools', version],
};
const targets = new Map();
for (const [name, [path, version]] of Object.entries(packages)) {
  const manifest = JSON.parse(readFileSync(join(root, path, 'package.json'), 'utf8'));
  if (manifest.name !== name || manifest.version !== version) throw new Error(`Host identity mismatch: ${name}`);
  targets.set(name, pathToFileURL(join(root, path, manifest.main)).href);
}
registerHooks({
  resolve(specifier, context, nextResolve) {
    return nextResolve(targets.get(specifier) ?? specifier, context);
  },
});
