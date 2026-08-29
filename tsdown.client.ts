/**
 * Standalone client-bundle preset, inlined from the DSH monorepo's
 * `packages/client/tsdown.client.ts`. Emits the closure-factory artifact: the
 * bundle calls window.__ModuleLoader__.load({id, factory}) and resolves
 * externals through the injected require (loader module table — cordis DI
 * entities, no globals, no import map). CSS is compiled by lightningcss inside
 * the bundle. Drift from the upstream preset is a deliberate divergence.
 */
import { readFile } from 'node:fs/promises'
import { existsSync, readFileSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { basename, dirname, isAbsolute, relative, resolve as resolvePath, sep } from 'node:path'
import type { UserConfig } from 'tsdown'
import { transform } from 'lightningcss'

/** Module-table keys the web shell seeds: react, cordis, and static client libraries. */
const PLATFORM_MODULES = [
  'react', 'react/jsx-runtime', 'react-dom', 'react-dom/client', '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
] as const

/** Client-bundle specifiers whose factories the parser preloads before the shell starts. */
const PRELOADED_CLIENT_EXTERNALS: readonly string[] = []

/**
 * Contract layers and pure folds a client bundle may inline: browser-safe
 * values with no runtime identity to share (no Symbol/instanceof/singleton state).
 */
const INLINE_SAFE = /^(?:@deepseek-ai\/dsh-(?:file-reference|session|llm|tools|brand|util-crypto|util-workspace-path)(?:\/|$)|@deepseek-ai\/dsh-token-meter\/client$)/

/**
 * Vendored framework libraries: rescoped into @deepseek-ai, so the purity gate
 * would otherwise read them as plugin packages. They carry no cross-plugin
 * runtime identity to share.
 */
const VENDORED_LIBRARY = /^@deepseek-ai\/(cosmokit|schemastery)(\/|$)/

/** Generated descriptor/codec contribution with no shared runtime identity. */
const GENERATED_REMOTE = /^@deepseek-ai\/dsh-[a-z0-9]+(?:-[a-z0-9]+)*\/remote$/

/** Build-face selector shared with the monorepo root build. */
type BuildFace = 'host' | 'client' | undefined

type BuildFaceConfig = (inlineConfig: Pick<UserConfig, 'env'>) => UserConfig[]

function buildFace(value: unknown): BuildFace {
  if (value === undefined || value === 'host' || value === 'client') return value
  throw new Error(`tsdown: --env.DSH_BUILD_FACE must be host or client, received ${String(value)}`)
}

/** A workspace-mode placeholder that removes the package from a build face. */
const SKIP_WORKSPACE_BUILD: UserConfig = { entry: '' }

const REPOSITORY_ROOT = process.cwd()

/** Rebase a physical lib-relative source onto a browser URL that mirrors the package directories. */
function browserSourcePath(source: string, sourcemapPath: string): string {
  if (!source.startsWith('.')) return source
  const physicalSource = resolvePath(dirname(sourcemapPath), source)
  const repositoryPath = relative(REPOSITORY_ROOT, physicalSource).split(sep).join('/')
  return repositoryPath.startsWith('packages/') ? `../../../${repositoryPath}` : source
}

/**
 * Build the tsdown config for one UI plugin package: the node-half lib build
 * plus the browser client bundle. A package-level tsdown.config.ts REPLACES
 * the root workspace layout, so the lib half is restated here — dropping it
 * leaves the package without lib/index.js and the host Loader cannot import
 * its node half. The Client build consumes `lib/types` and chains those tsc
 * maps, with original source content, into the standalone plugin map.
 * @param id - plugin id (package name), stamped into the __ModuleLoader__.load
 * handoff and onto the injected style tags.
 * @param libEntry - node-half entries, spelled at the call site.
 * @returns ENV-selected tsdown config for the current build face.
 */
export function clientBundle(
  id: string,
  libEntry: readonly string[],
): BuildFaceConfig {
  const lib = clientLibraryConfig(id, libEntry)
  return ({ env }) => {
    const face = buildFace(env?.DSH_BUILD_FACE)
    const clientEntry = face === undefined ? 'src/client/index.ts' : 'lib/types/client/index.js'
    const client = clientConfig(id, clientEntry)
    const node = [lib]
    if (face === 'host') return [SKIP_WORKSPACE_BUILD]
    return [...node, client]
  }
}

/** The manifest fields the build faces read to state their own module edges. */
interface WorkspaceManifest {
  readonly name?: string
  /** Sections a real install materializes on disk next to the built package. */
  readonly dependencies?: Record<string, string>
  readonly peerDependencies?: Record<string, string>
  readonly optionalDependencies?: Record<string, string>
  readonly dsh?: { readonly client?: { readonly external?: unknown } }
}

const manifestCache = new Map<string, WorkspaceManifest>()
const productionExternalCache = new Map<string, readonly RegExp[]>()
const clientExternalCache = new Map<string, ReadonlySet<string>>()

/**
 * Read one package manifest by walking every package.json under the
 * standalone root (workspace members only — no node_modules).
 * @param id - package name, as spelled at the preset call site.
 * @returns the parsed manifest.
 * @throws {Error} when no workspace package declares that name.
 */
function workspaceManifest(id: string): WorkspaceManifest {
  const cached = manifestCache.get(id)
  if (cached !== undefined) return cached
  for (const name of ['host', 'client', 'bundle']) {
    const manifestPath = resolvePath(REPOSITORY_ROOT, name, 'package.json')
    if (!existsSync(manifestPath)) continue
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as WorkspaceManifest
    if (manifest.name !== id) continue
    manifestCache.set(id, manifest)
    return manifest
  }
  throw new Error(`tsdown: no workspace package declares the name ${id}`)
}

/**
 * External patterns for one package's Node half: its own production sections,
 * subpaths included.
 * @param id - package name, as spelled at the preset call site.
 * @returns one `^name(/|$)` pattern per production dependency, name-sorted.
 */
function productionExternals(id: string): readonly RegExp[] {
  const cached = productionExternalCache.get(id)
  if (cached !== undefined) return cached
  const manifest = workspaceManifest(id)
  const names = new Set([
    ...Object.keys(manifest.dependencies ?? {}),
    ...Object.keys(manifest.peerDependencies ?? {}),
    ...Object.keys(manifest.optionalDependencies ?? {}),
  ])
  const patterns = [...names].sort().map(name => new RegExp(`^${escapeSpecifier(name)}(/|$)`))
  productionExternalCache.set(id, patterns)
  return patterns
}

/**
 * Read an optional string-array manifest field.
 * @param subject - package name, used in diagnostics.
 * @param field - manifest field name, used in diagnostics.
 * @param value - the raw field value.
 * @returns the string array, or undefined when absent.
 * @throws {Error} when the value is present but not a string array.
 */
export function optionalStringArray(subject: string, field: string, value: unknown): string[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string')) {
    throw new Error(`client-modules: ${subject} ${field} must be a string array`)
  }
  return value as string[]
}

/**
 * Module-table specifiers one `dsh.client` declaration requests. Matching is
 * exact, never normalized: a package declares the specifier its own code
 * imports, and the loader keys static entries the same way.
 * @param subject - package name, used in diagnostics.
 * @param declaration - the package's `dsh.client` object.
 * @returns the requested specifiers, empty when the package declares none.
 * @throws {Error} when `external` is not a string array.
 */
export function requestedExternals(
  subject: string,
  declaration: { readonly external?: unknown },
): ReadonlySet<string> {
  return new Set(optionalStringArray(subject, 'dsh.client.external', declaration.external) ?? [])
}

/**
 * Module-table specifiers one package requests. The shell baseline is implicit
 * for every dynamic bundle; `dsh.client.external` only adds package-specific
 * dynamic rows or subpaths.
 * @param id - package name, as spelled at the preset call site.
 * @returns the baseline plus the package's explicit requests.
 */
function clientExternals(id: string): ReadonlySet<string> {
  const cached = clientExternalCache.get(id)
  if (cached !== undefined) return cached
  const externals = new Set([
    ...PLATFORM_MODULES,
    ...PRELOADED_CLIENT_EXTERNALS,
    ...requestedExternals(id, workspaceManifest(id).dsh?.client ?? {}),
  ])
  clientExternalCache.set(id, externals)
  return externals
}

/** Escape a package name for literal use inside a RegExp source. */
function escapeSpecifier(name: string): string {
  return name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Whether an import specifier names a package rather than a file next to its importer. */
function isBareSpecifier(specifier: string): boolean {
  return !specifier.startsWith('.') && !specifier.startsWith('\0') && !isAbsolute(specifier)
}

/** Whether an import specifier is the package a pattern names, or one of its subpaths. */
function matchesSpecifier(patterns: readonly RegExp[], specifier: string): boolean {
  return patterns.some(pattern => pattern.test(specifier))
}

function clientLibraryConfig(
  id: string,
  libEntry: readonly string[],
): UserConfig {
  const isProductionDependency = (specifier: string): boolean =>
    matchesSpecifier(productionExternals(id), specifier)
  return {
    name: id,
    entry: [...libEntry],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    fixedExtension: false,
    dts: false,
    clean: false,
    deps: {
      // The Node half runs from a real install: a production dependency is on
      // disk there and stays an import, everything else inlines.
      neverBundle: isProductionDependency,
      alwaysBundle: (specifier: string) => !isBuiltin(specifier) && !isProductionDependency(specifier),
    },
  }
}

function clientConfig(id: string, entry: string): UserConfig {
  const isRequested = (specifier: string): boolean => clientExternals(id).has(specifier)
  return {
    name: `${id}/client`,
    entry: { client: entry },
    outDir: 'lib',
    format: 'cjs',
    platform: 'browser',
    dts: false,
    sourcemap: true,
    clean: false,
    deps: {
      neverBundle: isRequested,
      // Anything NOT requested from the loader module table must inline.
      alwaysBundle: (specifier: string) => !isRequested(specifier),
    },
    inputOptions: {
      resolve: {
        conditionNames: [
          (process.env.NODE_ENV ?? 'production') === 'development' ? 'development' : 'production',
          'browser', 'import', 'module', 'default',
        ],
      },
    },
    define: {
      ...clientBuildEnvironmentDefines(process.env),
      'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
      'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
    },
    plugins: [{
      // Bundle purity gate (build-time mirror of the module-edge rules): the
      // baseline and package-specific requests stay external, inline-safe wire
      // layers inline, and every other @deepseek-ai value import is a build error.
      name: 'dsh-client-bundle-purity',
      resolveId(source: string) {
        if (!source.startsWith('@deepseek-ai/')) return null
        if (isRequested(source)) return null // requested module-table row: external wins
        if (VENDORED_LIBRARY.test(source)) return null // vendored library: inline, no shared identity
        if (INLINE_SAFE.test(source) || GENERATED_REMOTE.test(source)) return null // wire contribution: inline is the point
        throw new Error(
          `client bundle purity: "${source}" is not in the default client externals or ${id}'s dsh.client.external, an inline-safe wire layer, or a generated /remote contribution — `
          + 'cross-plugin value imports are forbidden; declare a non-default module request or collaborate through cordis services '
          + '(type-only imports are erased and never reach this gate)',
        )
      },
    }, tscSourceMapPlugin(), {
      name: 'dsh-css-modules-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.module.css')) return null
        const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
        return CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(CSS_VIRTUAL_PREFIX)) return null
        const fileId = virtualId.slice(CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        // The virtual id otherwise hides the physical stylesheet from Rolldown's watch graph.
        this.addWatchFile(fileId)
        const source = await readFile(fileId)
        const { code, exports: cssExports } = transform({
          filename: fileId,
          code: source,
          cssModules: { pattern: '[hash]_[local]' },
          minify: true,
        })
        const classMap: Record<string, string> = {}
        const exportEntries = Object.entries(cssExports ?? {})
          .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
        for (const [local, exp] of exportEntries) classMap[local] = exp.name
        return styleInjectionModule(id, fileId, code.toString(), classMap)
      },
    }, {
      name: 'dsh-css-text-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith(`.css${INLINE_CSS_QUERY}`)) return null
        const stylesheet = source.slice(0, -INLINE_CSS_QUERY.length)
        const abs = importer !== undefined ? sourceAssetPath(stylesheet, importer) : stylesheet
        return INLINE_CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(INLINE_CSS_VIRTUAL_PREFIX)) return null
        const fileId = virtualId.slice(INLINE_CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        this.addWatchFile(fileId)
        const source = await readFile(fileId)
        const { code } = transform({ filename: fileId, code: source, minify: true })
        return `export default ${JSON.stringify(code.toString())};`
      },
    }, {
      name: 'dsh-css-global-inline',
      resolveId(source: string, importer: string | undefined) {
        if (!source.endsWith('.css') || source.endsWith('.module.css')) return null
        const abs = importer !== undefined ? sourceAssetPath(source, importer) : source
        return GLOBAL_CSS_VIRTUAL_PREFIX + abs + CSS_VIRTUAL_SUFFIX
      },
      async load(virtualId: string) {
        if (!virtualId.startsWith(GLOBAL_CSS_VIRTUAL_PREFIX)) return null
        const fileId = virtualId.slice(GLOBAL_CSS_VIRTUAL_PREFIX.length, -CSS_VIRTUAL_SUFFIX.length)
        this.addWatchFile(fileId)
        const source = await readFile(fileId)
        const { code } = transform({ filename: fileId, code: source, minify: true })
        return styleInjectionModule(id, fileId, code.toString())
      },
    }],
    outputOptions: {
      entryFileNames: 'client.js',
      sourcemapExcludeSources: false,
      sourcemapPathTransform: browserSourcePath,
      banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {`,
      footer: 'return module.exports; } });',
      intro: 'var module = { exports: {} }; var exports = module.exports;',
    },
  }
}

/**
 * Build-time substitutions for public client build environment variables.
 * The empty `process.env` fallback makes an unset static property read
 * evaluate to `undefined` without providing a browser `process` global.
 * @param environment - environment inherited by the build process.
 * @returns deterministic tsdown `define` expressions.
 */
function clientBuildEnvironmentDefines(
  environment: NodeJS.ProcessEnv,
): Record<string, string> {
  const defines: Record<string, string> = { 'process.env': '{}' }
  for (const [name, value] of Object.entries(environment)) {
    if (name.startsWith('DSH_CLIENT_') && value !== undefined) {
      defines[`process.env.${name}`] = JSON.stringify(value)
    }
  }
  return defines
}

/** Emit one plugin-owned style injector and an optional CSS Modules export. */
function styleInjectionModule(
  id: string,
  fileId: string,
  css: string,
  classMap?: Readonly<Record<string, string>>,
): string {
  const source = [
    `const css = ${JSON.stringify(css)};`,
    `const tagId = ${JSON.stringify(`${id}/${basename(fileId)}`)};`,
    'if (typeof document !== \'undefined\' && document.querySelector(\'style[data-plugin-css=\' + JSON.stringify(tagId) + \']\') === null) {',
    '  const tag = document.createElement(\'style\');',
    `  tag.dataset.plugin = ${JSON.stringify(id)};`,
    '  tag.dataset.pluginCss = tagId;',
    '  tag.textContent = css;',
    '  document.head.appendChild(tag);',
    '}',
  ]
  source.push(classMap === undefined ? 'export {};' : `export default ${JSON.stringify(classMap)};`)
  return source.join('\n')
}

/** Chain tsc's emitted maps into any Client bundle that consumes `lib/types`. */
function tscSourceMapPlugin() {
  return {
    name: 'dsh-tsc-sourcemap',
    async load(id: string) {
      if (!id.includes(TYPES_MARKER) || !id.endsWith('.js') || !existsSync(`${id}.map`)) return null
      const code = await readFile(id, 'utf8')
      const mapPath = `${id}.map`
      const map = JSON.parse(await readFile(mapPath, 'utf8')) as {
        sourceRoot?: unknown
        sources?: unknown
        sourcesContent?: unknown
        [key: string]: unknown
      }
      if (!Array.isArray(map.sources) || map.sources.some(source => typeof source !== 'string')) {
        throw new Error(`client sourcemap: ${mapPath} has invalid sources`)
      }
      const sources = map.sources as string[]
      if (
        !Array.isArray(map.sourcesContent)
        || map.sourcesContent.length !== sources.length
        || map.sourcesContent.some(source => typeof source !== 'string')
      ) {
        const sourceRoot = typeof map.sourceRoot === 'string' ? map.sourceRoot : ''
        map.sourcesContent = await Promise.all(sources.map(async source =>
          await readFile(resolvePath(dirname(mapPath), sourceRoot, source), 'utf8')))
      }
      return { code: code.replace(SOURCEMAP_COMMENT, ''), map }
    },
  }
}

/** Path segment separating a package's tsc output from the sources it was emitted from. */
const TYPES_MARKER = `${sep}lib${sep}types${sep}`

/** Path segment a package's sources hang under. */
const SOURCE_MARKER = `${sep}src${sep}`

/** Trailing sourcemap reference tsc appends to every emitted module. */
const SOURCEMAP_COMMENT = /\n\/\/# sourceMappingURL=.*\s*$/

const CSS_VIRTUAL_PREFIX = '\0dsh-css:'
const GLOBAL_CSS_VIRTUAL_PREFIX = '\0dsh-global-css:'
const INLINE_CSS_VIRTUAL_PREFIX = '\0dsh-inline-css:'
const CSS_VIRTUAL_SUFFIX = '.mjs'
const INLINE_CSS_QUERY = '?inline'

/** Resolve an emitted JS asset import against its source-tree counterpart. */
function sourceAssetPath(source: string, importer: string): string {
  const emitted = resolvePath(dirname(importer), source)
  if (existsSync(emitted)) return emitted
  const boundary = emitted.indexOf(TYPES_MARKER)
  if (boundary < 0) return emitted
  return resolvePath(emitted.slice(0, boundary), 'src', emitted.slice(boundary + TYPES_MARKER.length))
}
