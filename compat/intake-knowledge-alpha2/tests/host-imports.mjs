// Test-only package resolution against the exact built Host; no package install.
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
const root = process.env.DSH_HOST_ROOT;
if (!root || !isAbsolute(root)) throw new Error('Set DSH_HOST_ROOT to the built DSH checkout');
const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
if (version !== '0.2.1-rc.3') throw new Error(`Unreviewed host version: ${version}`);
const packages = {
  '@deepseek-ai/cordis': ['vendor/cordis', '4.0.5'],
  '@deepseek-ai/dsh-tool-executor-native': ['packages/core/tool-executor-native', version],
  '@deepseek-ai/dsh-tool-testkit': ['packages/test-support/tool-testkit', version],
  '@deepseek-ai/dsh-tools': ['packages/core/tools', version],
  '@deepseek-ai/dsh-system-prompt': ['packages/core/system-prompt', version],
  '@deepseek-ai/dsh-scope': ['packages/core/scope', version],
  '@deepseek-ai/dsh-agent-loop': ['packages/core/agent-loop', version],
  '@deepseek-ai/dsh-agent-loop-testkit': ['packages/test-support/agent-loop-testkit', version],
  '@deepseek-ai/dsh-llm': ['packages/llm/llm', version],
  '@deepseek-ai/dsh-session': ['packages/core/session', version],
};
const targets = new Map();
for (const [name, [path, expected]] of Object.entries(packages)) {
  const manifest = JSON.parse(readFileSync(join(root, path, 'package.json'), 'utf8'));
  if (manifest.name !== name || manifest.version !== expected) throw new Error(`Host identity mismatch: ${name}`);
  targets.set(name, pathToFileURL(join(root, path, manifest.main)).href);
}
registerHooks({ resolve(specifier, context, nextResolve) { return nextResolve(targets.get(specifier) ?? specifier, context); } });
