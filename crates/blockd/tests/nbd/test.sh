#!/usr/bin/env bash
# Runs inside a privileged Linux container. $1 is the blockd binary.
set -euo pipefail
blockd="$1"
store="local:/data/store"
work=/data/work
rm -rf /data && mkdir -p "$work"
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; exit 1; }

# wait for the control socket, and send one request
control() { "$blockd" control --socket "$1" --request "$2"; }
wait_for() { for _ in $(seq 1 100); do [ -S "$1" ] && return 0; sleep 0.1; done; fail "no socket $1"; }

attach() { # head nbd cache socket
  "$blockd" attach --store "$store" --head "$1" --nbd "$2" --cache "$3" --control "$4" &
  wait_for "$4"
}
detach() { control "$1" '{"op":"detach"}' >/dev/null; wait; }

# 1. a base image: ext4 with a small tree, imported into the store
mkdir -p "$work/rootfs/etc" "$work/rootfs/app"
echo "hello from the base image" > "$work/rootfs/etc/motd"
for i in $(seq 1 200); do echo "module $i" > "$work/rootfs/app/m$i.js"; done
mkfs.ext4 -q -F -d "$work/rootfs" -L base "$work/base.img" 1G
base=$("$blockd" import --store "$store" --head base --image "$work/base.img")
stored=$(du -sb /data/store/blobs | cut -f1)
[ "$stored" -lt $((64 * 1024 * 1024)) ] || fail "the base stored $stored bytes for a 1 GiB image"
pass "imported a 1 GiB image as $stored bytes ($base)"

# 2. a session is a fork of the base
"$blockd" fork --store "$store" --from base --to session >/dev/null
attach session /dev/nbd0 "$work/cache0" /tmp/ctl0
mkdir -p /mnt/s && mount /dev/nbd0 /mnt/s
[ "$(cat /mnt/s/etc/motd)" = "hello from the base image" ] || fail "base contents"
[ "$(ls /mnt/s/app | wc -l)" = 200 ] || fail "base tree"
pass "the session mounts with the base's files"

# 3. write: small files, a large file, a delete, a rename
mkdir /mnt/s/work
for i in $(seq 1 500); do echo "file $i" > "/mnt/s/work/f$i.txt"; done
dd if=/dev/urandom of=/mnt/s/work/big.bin bs=1M count=48 status=none
sha=$(sha256sum /mnt/s/work/big.bin | cut -d' ' -f1)
rm /mnt/s/app/m1.js && mv /mnt/s/app/m2.js /mnt/s/app/renamed.js
sync
pass "wrote 500 files, 48 MiB, a delete and a rename"

# 4. fork while mounted: freeze, flush, branch, thaw
reply=$(control /tmp/ctl0 '{"op":"fork","to":"try-1","freeze":"/mnt/s"}') || fail "fork: $reply"
echo "after the fork" > /mnt/s/work/later.txt && sync
pass "forked try-1 while mounted"

umount /mnt/s && detach /tmp/ctl0
pass "detached session"

# 5. another machine: a fresh cache attaches the session and sees everything
attach session /dev/nbd1 "$work/cache1" /tmp/ctl1
e2fsck -fn /dev/nbd1 >/dev/null 2>&1 || fail "e2fsck on the session"
mount /dev/nbd1 /mnt/s
[ "$(cat /mnt/s/work/f500.txt)" = "file 500" ] || fail "small files persisted"
[ "$(sha256sum /mnt/s/work/big.bin | cut -d' ' -f1)" = "$sha" ] || fail "big file persisted"
[ ! -e /mnt/s/app/m1.js ] && [ -e /mnt/s/app/renamed.js ] || fail "delete and rename persisted"
[ "$(cat /mnt/s/work/later.txt)" = "after the fork" ] || fail "post-fork write persisted"
umount /mnt/s && detach /tmp/ctl1
pass "a fresh cache sees every write, and e2fsck is clean"

# 6. the fork has everything up to the fork, and nothing after
attach try-1 /dev/nbd2 "$work/cache2" /tmp/ctl2
e2fsck -fn /dev/nbd2 >/dev/null 2>&1 || fail "e2fsck on the fork"
mount /dev/nbd2 /mnt/s
[ "$(sha256sum /mnt/s/work/big.bin | cut -d' ' -f1)" = "$sha" ] || fail "fork has the big file"
[ ! -e /mnt/s/work/later.txt ] || fail "fork must not see writes after it"
umount /mnt/s && detach /tmp/ctl2
pass "the fork is frozen at the fork point, and e2fsck is clean"

# 7. the base never changed
attach base /dev/nbd3 "$work/cache3" /tmp/ctl3
mount -o ro /dev/nbd3 /mnt/s
[ ! -e /mnt/s/work ] && [ -e /mnt/s/app/m1.js ] || fail "base untouched"
umount /mnt/s && detach /tmp/ctl3
pass "the base is untouched"

echo "heads:"; "$blockd" heads --store "$store"
echo "session history: $("$blockd" history --store "$store" --head session | wc -l) snapshots"
echo "ALL PASSED"
