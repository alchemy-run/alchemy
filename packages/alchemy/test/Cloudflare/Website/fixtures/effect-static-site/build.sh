#!/bin/bash
# Deterministic build for the effectful StaticSite fixture: copy src/ -> dist/.
# dist/ is gitignored and removed by the Build resource's delete on destroy.
set -euo pipefail
rm -rf dist
mkdir -p dist
cp -R src/. dist/
