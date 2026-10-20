#!/usr/bin/env bash
# Runs inside a container with /dev/fuse. $1 is the blockd binary.
set -euo pipefail
blockd="$1"
store="local:/data/store"
work=/data/work
rm -rf /data && mkdir -p "$work"
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; exit 1; }
control() { "$blockd" control --socket "$1" --request "$2"; }
wait_for() { for _ in $(seq 1 300); do [ -S "$1" ] && return 0; sleep 0.1; done; fail "no socket $1"; }
attach() { # head mountpoint cache socket
  "$blockd" attach --store "$store" --head "$1" --fuse "$2" --cache "$3" --control "$4" &
  wait_for "$4"
}
detach() { control "$1" '{"op":"detach"}' >/dev/null; wait; }
fsck() { # head
  "$blockd" export --store "$store" --head "$1" --image "$work/check.img" >/dev/null
  e2fsck -fn "$work/check.img" >/dev/null 2>&1 || fail "e2fsck on $1"
  rm -f "$work/check.img"
}

[ -e /dev/nbd0 ] && echo "note: block devices are visible, but this test doesn't use them"

mkdir -p "$work/rootfs/etc" "$work/rootfs/app"
echo "hello from the base image" > "$work/rootfs/etc/motd"
for i in $(seq 1 200); do echo "module $i" > "$work/rootfs/app/m$i.js"; done
mkfs.ext4 -q -F -d "$work/rootfs" "$work/base.img" 1G
"$blockd" import --store "$store" --head base --image "$work/base.img" >/dev/null
"$blockd" fork --store "$store" --from base --to session >/dev/null
pass "imported the base and forked a session"

attach session /mnt/s "$work/cache0" /tmp/ctl0
[ "$(cat /mnt/s/etc/motd)" = "hello from the base image" ] || fail "base contents over FUSE"
mkdir /mnt/s/work
for i in $(seq 1 300); do echo "file $i" > "/mnt/s/work/f$i.txt"; done
dd if=/dev/urandom of=/mnt/s/work/big.bin bs=1M count=24 status=none
sha=$(sha256sum /mnt/s/work/big.bin | cut -d' ' -f1)
rm /mnt/s/app/m1.js && mv /mnt/s/app/m2.js /mnt/s/app/renamed.js
sync -f /mnt/s
pass "wrote 300 files, 24 MiB, a delete and a rename through fuse2fs"

control /tmp/ctl0 '{"op":"fork","to":"try-1","freeze":"/mnt/s"}' >/dev/null || fail "fork over FUSE"
echo "after the fork" > /mnt/s/work/later.txt && sync -f /mnt/s
detach /tmp/ctl0
pass "forked try-1 and detached"

fsck session
fsck try-1
pass "e2fsck is clean on the session and the fork"

attach session /mnt/s "$work/cache1" /tmp/ctl1
[ "$(cat /mnt/s/work/f300.txt)" = "file 300" ] || fail "small files persisted"
[ "$(sha256sum /mnt/s/work/big.bin | cut -d' ' -f1)" = "$sha" ] || fail "big file persisted"
[ ! -e /mnt/s/app/m1.js ] && [ -e /mnt/s/app/renamed.js ] || fail "delete and rename persisted"
[ "$(cat /mnt/s/work/later.txt)" = "after the fork" ] || fail "post-fork write persisted"
detach /tmp/ctl1
pass "a fresh cache sees every write"

attach try-1 /mnt/f "$work/cache2" /tmp/ctl2
[ "$(sha256sum /mnt/f/work/big.bin | cut -d' ' -f1)" = "$sha" ] || fail "fork has the big file"
[ ! -e /mnt/f/work/later.txt ] || fail "fork must not see writes after it"
detach /tmp/ctl2
pass "the fork is frozen at the fork point"

echo "ALL PASSED"
