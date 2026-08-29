import { defineConfig } from 'tsdown'

/**
 * Standalone workspace build, mirroring the DSH monorepo root config: the
 * Host face has no node-half packages (the client package's node half is
 * emitted by its own clientBundle preset during the Client face), the Client
 * face lets the client package's `clientBundle` preset emit its Node loader
 * entry plus the browser artifact.
 */
export default defineConfig(({ env }) => {
  const client = env?.DSH_BUILD_FACE === 'client'
  return {
    workspace: ['client', 'bundle'],
    entry: client ? '' : ['lib/types/{index,invariant}.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
  }
})
