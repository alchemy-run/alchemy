#!/usr/bin/env bash
# Check that every internal link in the given .md/.mdx files resolves to a built
# page. Run after `pnpm run build` in website/.
# Usage: check-links.sh website/src/content/docs/fly/*.mdx
set -euo pipefail
root="$(git rev-parse --show-toplevel)/website/dist"
[ -d "$root" ] || { echo "no website/dist — build first" >&2; exit 1; }
missing=0
for f in "$@"; do
  while read -r link; do
    target="${link%%#*}"
    target="${target%/}"
    [ -z "$target" ] && continue
    if [ ! -f "$root$target/index.html" ] && [ ! -f "$root$target" ]; then
      echo "$f: missing $link"
      missing=1
    fi
  done < <(grep -o '](/[^) ]*' "$f" | sed 's/^](//' | sort -u)
done
[ "$missing" = 0 ] && echo "all links resolve"
exit "$missing"
