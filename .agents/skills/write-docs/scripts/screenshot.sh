#!/usr/bin/env bash
# Screenshot a docs page from the running dev server (pnpm exec astro dev in website/).
# Usage: screenshot.sh /aws/what-is-aws/ /tmp/what-is-aws.png [width] [height]
# Headless Chrome never exits on its own against the dev server (the HMR socket
# stays open), so it gets a virtual time budget and is killed after 25s.
set -euo pipefail
path="${1:?path like /aws/what-is-aws/}"
out="${2:?output png}"
width="${3:-1300}"
height="${4:-1000}"
chrome="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
command -v google-chrome >/dev/null 2>&1 && chrome="$(command -v google-chrome)"
curl -sf -o /dev/null "http://localhost:4321${path}" || {
  echo "dev server not answering on :4321 — run 'pnpm exec astro dev' in website/" >&2
  exit 1
}
"$chrome" --headless=new --disable-gpu --hide-scrollbars --virtual-time-budget=6000 \
  --window-size="${width},${height}" --screenshot="$out" "http://localhost:4321${path}" >/dev/null 2>&1 &
pid=$!
sleep 25
kill "$pid" 2>/dev/null || true
ls -la "$out"
