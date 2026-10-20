#!/usr/bin/env bash
# Runs as root in a container with /dev/fuse and loop devices. $1 is the
# blockd binary; $2.. are the modes to test.
set -euo pipefail
blockd="$1"; shift
store="local:/data/store"
work=/data/work
rm -rf /data && mkdir -p "$work"
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; exit 1; }
control() { "$blockd" control --socket "$1" --request "$2"; }
mount_head() { # head mode dir socket cache
  rm -f "$4"
  "$blockd" mount --store "$store" --head "$1" --mode "$2" --dir "$3" --control "$4" --cache "$5" \
    --flush-every 0 > "$work/mounted.json" &
  for _ in $(seq 1 300); do [ -S "$4" ] && grep -q mounted "$work/mounted.json" && return 0; sleep 0.1; done
  fail "$1 never mounted"
}
history_length() { "$blockd" history --store "$store" --head "$1" --limit 100 | wc -l; }
fsck() { # head
  "$blockd" export --store "$store" --head "$1" --image "$work/check.img" >/dev/null
  e2fsck -fn "$work/check.img" >/dev/null 2>&1 || fail "e2fsck on $1"
  rm -f "$work/check.img"
}

mkdir -p "$work/rootfs/etc"
echo base > "$work/rootfs/etc/motd"
mkfs.ext4 -q -F -b 4096 -d "$work/rootfs" "$work/base.img" 512M
"$blockd" import --store "$store" --head base --image "$work/base.img" >/dev/null

for mode in "$@"; do
  head="session-$mode"; dir="$work/mnt-$mode"; sock="$work/$mode.sock"; cache="$work/cache-$mode"
  "$blockd" fork --store "$store" --from base --to "$head" >/dev/null
  before=$(history_length "$head")

  # One mount, many commands, some at once.
  mount_head "$head" "$mode" "$dir" "$sock" "$cache"
  grep -q "\"mode\":\"$mode\"" "$work/mounted.json" || fail "$mode: mounted in $(cat "$work/mounted.json")"
  [ "$(cat "$dir/etc/motd")" = base ] || fail "$mode: base not visible"
  (cd "$dir" && head -c 8388608 /dev/urandom > a.bin) &
  (cd "$dir" && seq 1 100000 > b.txt) &
  wait %2 %3 2>/dev/null || true
  (cd "$dir" && sha256sum a.bin b.txt > sums)
  control "$sock" '{"op":"status"}' | grep -q '"ok":true' || fail "$mode: status"
  control "$sock" '{"op":"detach"}' | grep -q '"snapshot"' || fail "$mode: detach"
  wait
  [ "$(history_length "$head")" = $((before + 1)) ] || fail "$mode: one open should be one snapshot"
  pass "$mode: one mount served concurrent commands; detach made one snapshot"

  # Written and fsynced, then blockd dies: the next mount has it.
  mount_head "$head" "$mode" "$dir" "$sock" "$cache"
  (cd "$dir" && sha256sum -c sums >/dev/null) || fail "$mode: files from the last open"
  echo durable > "$dir/synced.txt"
  python3 - "$dir/synced.txt" <<'PY' 2>/dev/null || sync -f "$dir/synced.txt"
import os, sys
fd = os.open(sys.argv[1], os.O_RDONLY); os.fsync(fd); os.close(fd)
PY
  sync -f "$dir"   # the journal commit ext4 does on fsync of the directory entry
  status=$(control "$sock" '{"op":"status"}')
  echo "$status" | grep -q '"unjournaled_blocks":0' || fail "$mode: fsync left blocks unjournaled: $status"
  echo lost > "$dir/unsynced.txt"
  pkill -9 -f "blockd mount --store $store --head $head" || true
  wait || true
  umount -l "$dir" 2>/dev/null || true
  umount -l "$cache.disk" 2>/dev/null || true
  losetup -D 2>/dev/null || true

  mount_head "$head" "$mode" "$dir" "$sock" "$cache"
  [ "$(cat "$dir/synced.txt")" = durable ] || fail "$mode: an fsynced file was lost"
  (cd "$dir" && sha256sum -c sums >/dev/null) || fail "$mode: older files damaged by the crash"
  # A server a command left running holds the mount: detach still unmounts.
  (cd "$dir" && setsid sleep 600 < /dev/null > /dev/null 2>&1 &)
  sleep 0.2
  control "$sock" '{"op":"detach"}' | grep -q '"snapshot"' || fail "$mode: detach with a process in the mount"
  wait
  pgrep -f "sleep 600" >/dev/null && fail "$mode: the process in the mount outlived it"
  fsck "$head"
  pass "$mode: an fsynced write survived a killed blockd, a busy mount detached, and the disk checks clean"
done
echo "ALL PASSED"
