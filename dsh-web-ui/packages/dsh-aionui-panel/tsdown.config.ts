/**
 * Standalone build config for the dsh-aionui-panel plugin.
 *
 * Uses a vendored copy of the repo's shared client-bundle preset
 * (scripts/tsdown.client.ts): node-half lib/ plus the browser bundle
 * lib/client.js.
 */
import { clientBundle } from './scripts/tsdown.client.ts'

export default clientBundle('@dsh-local/dsh-aionui-panel', ['src/index.ts'], {
  libExternal: [
    '@deepseek-ai/dsh-client-locale',
    '@deepseek-ai/dsh-client-runtime',
    '@deepseek-ai/dsh-client-ui-conversation',
    '@deepseek-ai/dsh-client-ui-settings',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-host-webserver',
    '@deepseek-ai/dsh-settings',
    '@deepseek-ai/dsh-subprocess',
    '@deepseek-ai/dsh-system-prompt',
    '@deepseek-ai/dsh-workspace',
    'schemastery',
  ],
})
