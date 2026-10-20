#!/usr/bin/env bash
# Runs in an unprivileged container. $1 is the blockd binary.
set -euo pipefail
blockd="$1"
store="local:/tmp/data/store"
work=/tmp/data/work
rm -rf /tmp/data && mkdir -p "$work"
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; exit 1; }
run() { # head cache command
  "$blockd" run --store "$store" --head "$1" --cache "$2" --dir "$work/dir" --command "$3"
}
fsck() {
  "$blockd" export --store "$store" --head "$1" --image "$work/check.img" >/dev/null
  e2fsck -fn "$work/check.img" >/dev/null 2>&1 || fail "e2fsck on $1"
  rm -f "$work/check.img"
}

mount -t tmpfs none /mnt 2>/dev/null && fail "this container should not be able to mount"
[ -e /dev/fuse ] && fail "this container should not have /dev/fuse"
pass "no mount rights, no FUSE"

mkdir -p "$work/rootfs/etc" "$work/rootfs/app"
echo "hello from the base image" > "$work/rootfs/etc/motd"
for i in $(seq 1 100); do echo "module $i" > "$work/rootfs/app/m$i.js"; done
mkfs.ext4 -q -F -d "$work/rootfs" "$work/base.img" 256M
"$blockd" import --store "$store" --head base --image "$work/base.img" >/dev/null
"$blockd" fork --store "$store" --from base --to session >/dev/null

run session "$work/cache0" '[ "$(cat etc/motd)" = "hello from the base image" ] && mkdir -p work && for i in $(seq 1 200); do echo "file $i" > work/f$i.txt; done && head -c 8388608 /dev/urandom > work/big.bin && sha256sum work/big.bin | cut -d" " -f1 > /tmp/sha && rm app/m1.js && mv app/m2.js app/renamed.js' \
  || fail "first run"
sha=$(cat /tmp/sha)
fsck session
pass "a run sees the base, writes 200 files and 8 MiB, deletes and renames; e2fsck is clean"

run session "$work/cache0" "[ \"\$(sha256sum work/big.bin | cut -d' ' -f1)\" = $sha ] && [ \"\$(cat work/f200.txt)\" = 'file 200' ] && [ ! -e app/m1.js ] && [ -e app/renamed.js ]" \
  || fail "second run doesn't see the first run's writes"
pass "the next run sees every write"

"$blockd" fork --store "$store" --from session --to try-1 >/dev/null
run session "$work/cache0" 'echo later > work/later.txt' || fail "third run"
run try-1 "$work/cache1" '[ ! -e work/later.txt ] && [ -e work/f1.txt ]' || fail "the fork saw a later write"
pass "a fork is isolated"

set +e; run session "$work/cache0" 'echo partial > work/partial.txt; exit 3'; code=$?; set -e
[ "$code" = 3 ] || fail "the command's exit code ($code)"
run session "$work/cache0" '[ "$(cat work/partial.txt)" = partial ]' || fail "writes of a failing command"
pass "a failing command's exit code is passed through, and its writes are kept"

before=$("$blockd" history --store "$store" --head session | wc -l)
run session "$work/cache0" 'true'
after=$("$blockd" history --store "$store" --head session | wc -l)
echo "history: $before -> $after snapshots after a no-op run"
fsck session
echo "ALL PASSED"
