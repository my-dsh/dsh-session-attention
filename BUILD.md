# BUILD.md — dsh-session-attention

## Repository layout

```
client/   @deepseek-ai/dsh-client-ui-session-attention — browser overlay plugin (shell.overlay)
bundle/   @deepseek-ai/dsh-session-attention — profile bundle (cordis.patch.yml)
```

## Prerequisites

- Node `^22.19 || >=24`, pnpm 11.
- A built [deepseek-harness](https://github.com/my-dsh/deepseek-harness) checkout at
  `../deepseek-harness` (sibling directory). The workspace overrides in
  `pnpm-workspace.yaml` pin every `@deepseek-ai/*` dependency to that checkout's
  built `lib/` outputs, so no DSH package needs to be published to npm.

## Build

```sh
pnpm install          # resolves @deepseek-ai/* through ../deepseek-harness links
pnpm run build        # tsc -b (host + client faces) then tsdown host + client faces
```

Outputs:

| Artifact | Consumer |
| --- | --- |
| `client/lib/types/**` | tsc declarations; tsdown bundles from them |
| `client/lib/index.js`, `client/lib/invariant.js` | Node-half loader entries (empty apply + invariant companion) |
| `client/lib/client.js` | Browser bundle (`window.__ModuleLoader__.load` closure; CSS inlined) |
| `bundle/lib/index.js`, `bundle/lib/invariant.js` | Bundle package Node half |
| `bundle/cordis.patch.yml` | The patch layer the profile composer reads |

## Install into a profile

From any directory:

```sh
pnpm dsh plugin --profile web add /home/wuz11/code/github/dsh-session-attention/bundle
```

The CLI forwards `pnpm add` into the profile, then reconciles `dsh.profile.bundles`
from the installed package's `dsh.bundle.patch` manifest. The bundle declares
`@deepseek-ai/dsh-client-ui-session-attention` as a `workspace:*` dependency; at
profile boot the module-fallback healer links it and its own dependency closure
into the shared `~/.dsh/profiles/node_modules` tree, so no other manual install
step is needed.

Restart the running `dsh web` server afterwards and verify:

```sh
cd deepseek-harness && node --import tsx/esm apps/cli/src/bin.ts web --dump-config | grep session-attention
# expect: - id: ui-session-attention ... '@deepseek-ai/dsh-client-ui-session-attention'
```

The overlay renders in the web GUI top-right while a session awaits approval /
plan review / an answer, or after a background reply finishes unopened.

## Notes

- The Typert generator is not needed here: this plugin has no Remote service.
- `pnpm run sync` (scripts/sync-from-monorepo.sh, if present) refreshes sources
  from the monorepo copies; sources are byte-identical to
  `deepseek-harness/packages/{client/ui-session-attention,bundle/session-attention}`.
