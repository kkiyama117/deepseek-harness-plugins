/**
 * Shared vitest config. The linked harness-checkout client packages export
 * ./client subpaths pointing at built browser bundles (closure-factory
 * artifacts); unit tests need the node-importable sources, mirroring the
 * harness repo's own tsconfig paths (the dsh-client-* client wildcard).
 * React is unified on this workspace's copies: the test renderer's react-dom
 * resolves its react peer from this workspace's .pnpm store, so components
 * imported from the linked harness packages must use the same react instance.
 */
import { defineConfig } from 'vitest/config'

const HARNESS = '/data/softwares/deepseek-harness'
const REACT = '/data/softwares/deepseek-harness-plugins/node_modules/.pnpm/react@18.3.1/node_modules/react'

export default defineConfig({
  resolve: {
    alias: [
      {
        find: /^@deepseek-ai\/dsh-client-([a-z0-9-]+)\/client$/,
        replacement: HARNESS + '/packages/client/$1/src/client/index.ts',
      },
      {
        find: /^react\/jsx-runtime$/,
        replacement: REACT + '/jsx-runtime',
      },
      {
        find: /^react$/,
        replacement: REACT,
      },
    ],
  },
})
