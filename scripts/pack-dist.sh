#!/usr/bin/env bash
# Pack the built plugin into an installable single-root tarball and publish a
# 'dist' GitHub Release carrying it, so a consumer can install straight from a
# URL:
#
#   dsh plugin --profile <name> add \
#     https://github.com/my-dsh/dsh-session-attention/releases/download/dist/dsh-session-attention-dist.tgz
#
# A plain tarball install materializes bundled directories verbatim, so the
# pack ships the workspace as a root bundle plus every sibling workspace
# package preinstalled under node_modules:
#
#   package.json          the bundle manifest; sibling workspace deps replaced
#                         by the bundled directory presence
#   cordis.patch.yml       copied from bundle/ (the dsh.bundle.patch target)
#   node_modules/<scope>/<pkg>/
#                         the client package, preinstalled with manifest and
#                         built lib/
#
# The nested node_modules is the whole point: npm/pnpm keep it intact from a
# plain tarball, so the patch-row module specifier stays resolvable from the
# bundle package. (pnpm DOES strip it out of git-hosted branches — hence the
# tarball URL, never github:<repo>#ref.)
#
# Also pushes the same tree to the `dist` branch for source browsing.
#
# `pnpm run build` must have produced bundle/lib and the client's lib.
# Requires a built deepseek-harness checkout beside this repository (see
# BUILD.md) because the build resolves @deepseek-ai/* through workspace
# overrides pointing at it.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO="$(git config --get remote.origin.url)"
BRANCH=dist
PACK=.dist-pack
BUNDLE=bundle

[ -f "$BUNDLE/lib/index.js" ] || { echo "pack-dist: $BUNDLE/lib/index.js missing — run pnpm run build first" >&2; exit 1; }

# Siblings = workspace dirs (not bundle, not node_modules) carrying a built lib/.
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
# Drop the sibling workspace deps from the root manifest — the packages now
# live in the bundled node_modules; the root must not redeclare them as `file:`
# or `workspace:` refs, which pnpm would mis-resolve from the packed resource.
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

# 1) Push the tree to the `dist` branch for source browsing.
cd "$PACK"
git init -q
git checkout -q -b "$BRANCH"
git add -A
git -c user.name=pack-dist -c user.email=pack-dist@local commit -q -m "dist: packed from $(git -C .. rev-parse --short HEAD)"
git remote add origin "$REPO"
git push -q --force origin "$BRANCH"
cd ..

# 2) Publish the tarball as the `dist` release asset.
PKG="$(node -p "require('./bundle/package.json').name.split('/')[1]")"
TARBALL="/tmp/${PKG}-dist.tgz"
tar czf "$TARBALL" -C "$PACK" .
rm -rf "$PACK"
gh release delete "$BRANCH" --repo "$REPO" --yes >/dev/null 2>&1 || true
gh release create "$BRANCH" "$TARBALL" --repo "$REPO" --title "$BRANCH" \
  --notes "Installable: dsh plugin add https://github.com/$REPO/releases/download/dist/${PKG}-dist.tgz"
rm -f "$TARBALL"
echo "pack-dist: published $BRANCH release to $REPO"