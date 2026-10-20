#!/usr/bin/env bash
# blockd exec in every mode this container allows: one command at a time
# against one head, each run seeing the last. $1 is the blockd binary;
# $2.. are the modes to run (auto first resolves to the best available).
set -euo pipefail
blockd="$1"; shift
store="local:/tmp/data/store"
work=/tmp/data/work
rm -rf /tmp/data && mkdir -p "$work"
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; exit 1; }
mkdir -p "$work/rootfs/etc"
echo base > "$work/rootfs/etc/motd"
mkfs.ext4 -q -F -b 4096 -d "$work/rootfs" "$work/base.img" 256M
"$blockd" import --store "$store" --head base --image "$work/base.img" >/dev/null
for mode in "$@"; do
  head="session-$mode"
  "$blockd" fork --store "$store" --from base --to "$head" >/dev/null
  ex() { "$blockd" exec --store "$store" --head "$head" --cache "$work/cache-$mode" --dir "$work/mnt-$mode" --mode "$mode" --command "$1"; }
  ex '[ "$(cat etc/motd)" = base ] && echo one > one.txt && head -c 4194304 /dev/urandom > blob.bin && sha256sum blob.bin > blob.sha' || fail "$mode: first exec"
  ex '[ "$(cat one.txt)" = one ] && sha256sum -c blob.sha >/dev/null && rm one.txt && echo two > two.txt' || fail "$mode: second exec"
  set +e; ex '[ ! -e one.txt ] && [ "$(cat two.txt)" = two ] && exit 7'; code=$?; set -e
  [ "$code" = 7 ] || fail "$mode: exit code $code"
  pass "$mode: three execs, each seeing the last; exit codes pass through"
done
echo "ALL PASSED"
