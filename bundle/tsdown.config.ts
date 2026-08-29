import { defineConfig } from 'tsdown'

/**
 * The bundle package's substance is `cordis.patch.yml`; the Node half is the
 * trivial plugin shell the patch rows resolve through, mirroring the DSH
 * monorepo root workspace build for bundle packages.
 */
export default defineConfig({
  entry: ['lib/types/index.js', 'lib/types/invariant.js'],
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
