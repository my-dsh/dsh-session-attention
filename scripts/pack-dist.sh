#!/usr/bin/env bash
# Pack the built plugin into a flat single-package tree and push it to the
# `dist` branch, so a consumer can install straight from git:
#
#   dsh plugin --profile <name> add github:my-dsh/dsh-session-attention#dist
#
# pnpm installs a git-hosted dependency as ONE package: it prunes any
# node_modules/ inside the checkout (npm-pack rules) and resolves nested
# `file:` dependencies consumer-relatively, so the multi-package workspace
# layout cannot ship through a git branch. The dist branch is therefore a
# FLAT single package that merges the workspace packages:
#
#   package.json      the client package manifest (its name is the bundle's
#                     only loader row) plus the bundle manifest's
#                     `dsh.bundle` — one package is simultaneously the patch
#                     layer and the `dsh.client` declaration carrier
#   cordis.patch.yml  copied from bundle/ unchanged: its single row already
#                     names the client package, which under the flat layout
#                     is the dist root itself
#   lib/              the client build
#
# `pnpm run build` must have produced client/lib first. Requires a built
# deepseek-harness checkout beside this repository (see BUILD.md) because the
# build resolves @deepseek-ai/* through workspace overrides pointing at it.
set -euo pipefail

cd "$(dirname "$0")/.."
REPO_URL="$(git config --get remote.origin.url)"
BRANCH=dist
PACK=.dist-pack
BUNDLE=bundle
CLIENT=client

[ -f "$CLIENT/lib/index.js" ] && [ -f "$CLIENT/lib/client.js" ] \
  || { echo "pack-dist: $CLIENT/lib missing — run pnpm run build first" >&2; exit 1; }
[ -f "$BUNDLE/cordis.patch.yml" ] || { echo "pack-dist: $BUNDLE/cordis.patch.yml missing" >&2; exit 1; }

rm -rf "$PACK"
mkdir -p "$PACK"
cp -r "$CLIENT/lib" "$PACK/lib"
cp "$BUNDLE/cordis.patch.yml" "$PACK/cordis.patch.yml"

# Manifest: start from the client package (name, dsh.client, exports), then
# merge the bundle manifest's description, dsh.bundle, repository, license.
node - "$CLIENT/package.json" "$BUNDLE/package.json" "$PACK/package.json" <<'NODE'
const fs = require('fs')
const [clientPath, bundlePath, outPath] = process.argv.slice(2)
const client = JSON.parse(fs.readFileSync(clientPath, 'utf8'))
const bundle = JSON.parse(fs.readFileSync(bundlePath, 'utf8'))
if (bundle.dsh.bundle === undefined) throw new Error('pack-dist: bundle manifest declares no dsh.bundle')
for (const field of ['description', 'repository', 'license', 'type']) {
  if (bundle[field] !== undefined) client[field] = bundle[field]
}
client.dsh = { ...client.dsh, bundle: bundle.dsh.bundle }
client.publishConfig = { access: 'public' }
delete client.scripts
delete client.devDependencies
delete client.files
// The pack ships lib/ only; drop source-tree and internals exports.
delete client.exports['./src/*']
fs.writeFileSync(outPath, JSON.stringify(client, null, 2) + '\n')
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
