"""Restore the tested plugin migration after the readiness-probe rollback.

Every result must match the hashes recorded before the first cutover. This is
not a new migration or a rerun of tests against different source.
"""
import hashlib
import json
from pathlib import Path
import subprocess

ROOT = Path('/data/softwares/deepseek-harness-plugins')
BACKUP = Path('/data/backups/dsh-rc2-20261019-1232')
expected = json.loads((BACKUP / 'plugin-upgraded-file-hashes.json').read_text())
for relative in expected:
    current = (ROOT / relative).read_bytes()
    assert current == (BACKUP / 'plugins' / relative).read_bytes() or hashlib.sha256(current).hexdigest() == expected[relative], relative
subprocess.run(['python3', str(ROOT / 'bin/migrate-rc2-plugins.py'), '--apply'], check=True)


def replace(relative, old, new, count=1):
    path = ROOT / relative
    text = path.read_text()
    if hashlib.sha256(path.read_bytes()).hexdigest() == expected[relative]:
        return
    assert text.count(old) == count, (relative, text.count(old), count)
    path.write_text(text.replace(old, new))


base = 'compat/slack-intake-alpha2/'
replace(base+'native.mjs', "      toolFilter: { allow: [] },", "      agentPreset: 'aistore-native',")
replace(base+'tests/native.test.mjs', "  assert.deepEqual(nativeRequest.toolFilter, { allow: [] });", "  assert.equal(nativeRequest.agentPreset, 'aistore-native');\n  assert.equal(Object.hasOwn(nativeRequest, 'toolFilter'), false);")
replace(base+'tests/host-imports.mjs', "'0.2.1-alpha.2': '4.0.5-alpha.1'", "'0.2.1-alpha.2': '4.0.5-alpha.1', '0.2.1-rc.2': '4.0.5'")
replace(base+'tests/host-imports.mjs', "  '@deepseek-ai/cordis': ['vendor/cordis', cordisVersions[version]],", "  '@deepseek-ai/cordis': ['vendor/cordis', cordisVersions[version]],\n  '@deepseek-ai/cordis-plugin-loader': ['vendor/loader', '1.0.6'],\n  '@deepseek-ai/cordis-plugin-include': ['vendor/include', '1.0.10'],\n  '@deepseek-ai/dsh-agent-preset-registry': ['packages/preset/agent-preset-registry', version],")
replace(base+'tests/agent.test.mjs', "import JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';", "import * as JsonlPersistence from '@deepseek-ai/dsh-session-persistence-jsonl';\nimport Loader from '@deepseek-ai/cordis-plugin-loader';\nimport Include from '@deepseek-ai/cordis-plugin-include';\nimport AgentPresets from '@deepseek-ai/dsh-agent-preset-registry';\nimport * as nativeRestriction from '../../../dsh-aistore-native-preset/index.mjs';")
replace(base+'tests/agent.test.mjs', "  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } });", "  await ctx.plugin(Loader);\n  ctx.loader.builtins.include = Include;\n  ctx.loader.builtins.nativeRestriction = nativeRestriction;\n  await mountAgentLoopTestDependencies(ctx, { tools: { mode: 'native' } });\n  await ctx.plugin(AgentPresets, { default: 'aistore-native' });\n  const releasePreset = await ctx.agentPresets.register({ id: 'aistore-native', plugins: [\n    { id: 'restriction', name: 'cordis:nativeRestriction' },\n  ] });\n  t.after(releasePreset);")
replace(base+'tests/agent.test.mjs', "  assert.equal(adapter.requests[0].maxTokens, 4096);", "  assert.equal(adapter.requests[0].maxTokens, 4096);\n  assert.deepEqual(adapter.requests[0].tools.map(tool => tool.name), ['structured_output']);")
replace(base+'README.md', "The configured provider must support one-shot `agentOptions`, `outputSchema`, and `toolFilter`; the current in-process `spawn` provider supports all three. The tool must be invoked by the DSH Agent loop so `exec.agent` identifies the real parent Agent.", "The configured provider must support `agentOptions`, `outputSchema`, and `agentPreset`; the in-process `spawn` provider supports all three. Install `@local/dsh-aistore-native-preset` in every calling profile. The adapter selects its `aistore-native` preset, which excludes global tools and provides no task tools; the runtime adds only `structured_output`. A missing preset rejects creation instead of inheriting parent tools. The tool must be invoked by the DSH Agent loop so `exec.agent` identifies the real parent Agent.")
path = 'tests/upgrade/local-workflow-results.spec.ts'
replace(path, "    const parent = { id: session.id, options: {}, session } as unknown as Agent", "    const parent = { id: session.id, options: {}, session, ctx } as unknown as Agent", 2)
replace(path, "      expect(result.value).toEqual({ kind: 'background', jobId: 'workflow-1', runId: 'run-1' })\n      expect((result.content[0] as { text: string }).text)\n        .toContain('workflow \"audit\" started in the background as job workflow-1')", "      const { jobId } = result.value as { jobId: JobId }\n      expect(jobId).toMatch(/^workflow-[0-9a-f]{16}$/)\n      expect(result.value).toEqual({ kind: 'background', jobId, runId: 'run-1' })\n      expect((result.content[0] as { text: string }).text)\n        .toContain(`workflow \"audit\" started in the background as job ${jobId}`)")
replace(path, "jobs.get('workflow-1' as never, parent.id)", "jobs.get((result.value as { jobId: JobId }).jobId, parent.id)", 5)
replace(path, "arguments: { job_id: 'workflow-1' },", "arguments: { job_id: jobId },")
replace(path, "jobs.get('workflow-2' as never, parent.id)", "jobs.get((second.value as { jobId: JobId }).jobId, parent.id)", 2)
replace(path, "        'tool-workflow/run-start', 'tool-workflow/agent-start', 'tool-workflow/agent-end', 'tool-workflow/run-end',", "        'tool-workflow/run-start', 'job/registered', 'tool-workflow/agent-start', 'tool-workflow/agent-end', 'tool-workflow/run-end', 'job/settled',")
replace(path, "    it('a nested transport call mirrors the ring but records no session events, and a dispose failure still settles',", "    it('a nested transport call records job events without workflow events, and a dispose failure still settles',")
replace(path, "      expect(warn.mock.calls.map(args => String(args[0])).join('\\n')).toContain('dispose failed')\n      expect(session.snapshotEvents()).toEqual([])", "      expect(warn.mock.calls.map(args => String(args[0])).join('\\n')).toContain('dispose failed')\n      expect(session.snapshotEvents().map(event => event.type)).toEqual(['job/registered', 'job/settled'])")
for relative, digest in expected.items():
    content = (ROOT / relative).read_bytes()
    assert hashlib.sha256(content).hexdigest() == digest, relative
    saved = BACKUP / 'tested-rc2-plugin-files' / relative
    saved.parent.mkdir(parents=True, exist_ok=True)
    saved.write_bytes(content)
print('Restored and saved all 21 plugin files with exact tested hashes')
