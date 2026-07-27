#!/usr/bin/env bash
# Symlink this folder into every editor extensions directory found on the
# machine, so the grammar loads without packaging a .vsix.
set -euo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
name="alchemy-vscode"
linked=0

for dir in \
  "$HOME/.cursor/extensions" \
  "$HOME/.vscode/extensions" \
  "$HOME/.vscode-insiders/extensions" \
  "$HOME/.cursor-server/extensions"; do
  [ -d "$dir" ] || continue
  target="$dir/$name"
  if [ -e "$target" ] && [ ! -L "$target" ]; then
    echo "refusing to replace $target (not a symlink)" >&2
    exit 1
  fi
  rm -f "$target"
  ln -s "$root" "$target"
  echo "linked $target -> $root"
  linked=1
done

if [ "$linked" -eq 0 ]; then
  echo "no editor extensions directory found (~/.cursor/extensions, ~/.vscode/extensions)" >&2
  exit 1
fi

echo "run 'Developer: Reload Window' to pick up the grammar"
