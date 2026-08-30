#!/usr/bin/env bash
# Pack the built plugin into a single-root installable tree and push it to the
# `dist` branch, so a consumer can install straight from git:
#
#   dsh plugin --profile <name> add github:my-dsh/<repo>#dist
#
# Layout written to .dist-pack/:
#   package.json      the bundle manifest; sibling workspace deps dropped
#   cordis.patch.yml  copied from bundle/ (the dsh.bundle.patch target)
#   node_modules/<scope>/<sibling-name>/
#                     every non-bundle workspace package, preinstalled as a
#                     plain directory with its manifest and built lib/
#
# The nested node_modules is the load-bearing trick: pnpm resolves `file:`
# dependencies of a packed (tarball/git) dependency relative to the CONSUMER
# directory, so sibling `file:./host` specs break on install, while a packed
# `node_modules/` subtree survives verbatim and keeps every patch-row module
# specifier resolvable from the bundle package itself.
#
# `pnpm run build` must have produced bundle/lib and every sibling's lib
# first. Requires a built deepseek-harness checkout beside this repository
# (see BUILD.md) because the build resolves @deepseek-ai/* through workspace
# overrides pointing at it.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_URL="$(git config --get remote.origin.url)"
BRANCH=dist
PACK=.dist-pack
BUNDLE=bundle

[ -f "$BUNDLE/lib/index.js" ] || { echo "pack-dist: $BUNDLE/lib/index.js missing — run pnpm run build first" >&2; exit 1; }

# Siblings are the workspace directories other than the bundle that carry a
# built lib/ — host-only, client-only, or both, depending on the plugin.
SIBLINGS=()
for dir in */; do
  dir="${dir%/}"
  [ "$dir" = "$BUNDLE" ] && continue
  [ "$dir" = node_modules ] && continue
  [ -f "$dir/package.json" ] && [ -f "$dir/lib/index.js" ] && SIBLINGS+=("$dir")
done
[ ${#SIBLINGS[@]} -gt 0 ] || { echo "pack-dist: no sibling package with a built lib/ found" >&2; exit 1; }

rm -rf "$PACK"
mkdir -p "$PACK"
cp "$BUNDLE/package.json" "$PACK/package.json"
cp "$BUNDLE/cordis.patch.yml" "$PACK/cordis.patch.yml"
for dir in "${SIBLINGS[@]}"; do
  name="$(node -p "require('./$dir/package.json').name")"
  target="$PACK/node_modules/$name"
  mkdir -p "$(dirname "$target")"
  cp -r "$dir" "$target"
  rm -rf "$target/node_modules"
done
# The manifest rewrite drops the sibling workspace deps — the packages are now
# shipped inside node_modules; every remaining dep field stays as declared.
node - "$PACK/package.json" "${SIBLINGS[*]}" <<'NODE'
const fs = require('fs')
const siblings = new Set(process.argv[3].split(' '))
const manifest = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'))
for (const field of ['dependencies', 'peerDependencies', 'devDependencies']) {
  const deps = manifest[field]
  if (deps === undefined) continue
  for (const dir of siblings) {
    const name = JSON.parse(fs.readFileSync(`${dir}/package.json`, 'utf8')).name
    delete deps[name]
  }
  if (Object.keys(deps).length === 0) delete manifest[field]
}
fs.writeFileSync(process.argv[2], JSON.stringify(manifest, null, 2) + '\n')
NODE
find "$PACK" -name '*.map' -delete

# Stage the pack as an orphan branch — dist never carries repo history.
cd "$PACK"
git init -q
git checkout -q -b "$BRANCH"
git add -A
git -c user.name=pack-dist -c user.email=pack-dist@local commit -q -m "dist: packed from $(git -C .. rev-parse --short HEAD)"
git remote add origin "$REPO_URL"
git push -q --force origin "$BRANCH"
cd ..
rm -rf "$PACK"
echo "pack-dist: pushed $BRANCH to $REPO_URL"
