#!/bin/bash
# Minimal build for the StaticSite fixture: copy src/ -> dist/, then append a
# non-deterministic suffix to one file so the dist *content* hash drifts
# between runs even when input source files are unchanged. This reproduces
# the Astro/Vite "shuffled chunk hash" behaviour that originally caused
# Worker to be marked `~ updated` on every deploy.
set -euo pipefail
rm -rf dist
mkdir -p dist
cp -R src/. dist/
echo "<!-- build-nonce: $RANDOM-$(date +%s%N) -->" >> dist/index.html
