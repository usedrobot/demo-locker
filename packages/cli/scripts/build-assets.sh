#!/usr/bin/env bash
# Builds the prebuilt Cloudflare deployable shipped inside the npm tarball.
# Run from anywhere: bash packages/cli/scripts/build-assets.sh
#
# Output layout (packages/cli/assets), which is what the wizard's `copy` step
# unpacks into ./demo-locker next to the wrangler.jsonc it writes:
#   worker.js     the pre-bundled Worker (wrangler.jsonc `main`)
#   public/       web app + embed.js + openapi.json (wrangler.jsonc `assets`)
#   migrations/   D1 migration SQL (wrangler.jsonc `migrations_dir`)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
OUT="$ROOT/packages/cli/assets"

rm -rf "$OUT"
mkdir -p "$OUT/public" "$OUT/migrations"

# Worker bundle — pre-bundled so the user's machine never runs npm install.
# wrangler 4.80.0 emits index.js, index.js.map and a README.md into the outdir.
cd "$ROOT/packages/api"
npx wrangler deploy --dry-run --outdir "$OUT/.worker-build"
if [ ! -s "$OUT/.worker-build/index.js" ]; then
  echo "build-assets: wrangler did not emit index.js — outdir contains:" >&2
  ls -la "$OUT/.worker-build" >&2
  exit 1
fi
mv "$OUT/.worker-build/index.js" "$OUT/worker.js"
rm -rf "$OUT/.worker-build"

# The Worker runs on workerd, which has neither node:sqlite bindings nor the
# AWS SDK's Node transports. If either driver ends up in the bundle the deploy
# fails on the user's machine, so fail here instead.
if grep -q "better-sqlite3\|@aws-sdk" "$OUT/worker.js"; then
  echo "build-assets: Node-only driver bundled into worker.js:" >&2
  grep -o "better-sqlite3\|@aws-sdk" "$OUT/worker.js" | sort -u >&2
  exit 1
fi

# Web app, built same-origin: packages/web/src/lib/api.ts treats an empty
# VITE_API_URL as same-origin, so the app talks to the Worker serving it.
cd "$ROOT"
VITE_API_URL="" npm run build -w packages/web
cp -R "$ROOT/packages/web/dist/." "$OUT/public/"

# Player bundle and API description, served as assets.
npm run build -w packages/player
cp "$ROOT/packages/player/dist/embed.js" "$OUT/public/embed.js"
cp "$ROOT/docs/openapi.json" "$OUT/public/openapi.json"

# D1 migrations. Path matches drizzle.config.ts `out` and the migrations_dir
# in packages/api/wrangler.jsonc.
cp "$ROOT/packages/api/src/db/migrations/"*.sql "$OUT/migrations/"

echo "assets built:"
find "$OUT" -maxdepth 2 -type f | sed "s|$OUT|assets|"
