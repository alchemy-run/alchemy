#!/usr/bin/env bash
# Runs as root in a privileged container. $1 is the blockd binary; $2.. are
# the filesystems to test.
set -euo pipefail
blockd="$1"; shift
store="local:/data/store"
work=/data/work
rm -rf /data && mkdir -p "$work"
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; exit 1; }
control() { "$blockd" control --socket "$1" --request "$2"; }
snapshot_of() { "$blockd" history --store "$store" --head "$1" --limit 1; }
mount_head() { # head dir socket cache
  rm -f "$3"
  "$blockd" mount --store "$store" --head "$1" --mode loop --dir "$2" --control "$3" --cache "$4" \
    --flush-every 0 > "$work/mounted.json" 2> "$work/mount.log" &
  for _ in $(seq 1 300); do [ -S "$3" ] && grep -q mounted "$work/mounted.json" && return 0; sleep 0.1; done
  cat "$work/mount.log"; fail "$1 never mounted"
}
has() { echo "$1" | grep -q "\"$2\"" || fail "$3: expected $2 in $1"; }
lacks() { echo "$1" | grep -q "\"$2\"" && fail "$3: didn't expect $2 in $1"; return 0; }

base_image() { # fs image
  local root="$work/rootfs-$1"
  rm -rf "$root" && mkdir -p "$root/src" "$root/dir/keep"
  echo base > "$root/motd"
  echo a > "$root/src/a.ts"; echo b > "$root/src/b.ts"; echo c > "$root/src/c.ts"
  echo x > "$root/dir/keep/x"
  head -c 8388608 /dev/urandom > "$root/big.db"
  case "$1" in
    ext4) mkfs.ext4 -q -F -b 4096 -d "$root" "$2" 512M ;;
    btrfs)
      local layout="$work/layout-btrfs"
      rm -rf "$layout" && mkdir -p "$layout/.alchemy" && cp -a "$root" "$layout/data"
      truncate -s 512M "$2"
      mkfs.btrfs -q -f --rootdir "$layout" --subvol default:data "$2" >/dev/null ;;
  esac
}

for fs in "$@"; do
  img="$work/base-$fs.img"
  base_image "$fs" "$img"
  "$blockd" import --store "$store" --head "base-$fs" --image "$img" >/dev/null
  S=$(snapshot_of "base-$fs")

  # A command on an ephemeral fork: its patch, and a process it left running.
  result="$work/call-$fs.json"
  command='echo changed >> src/a.ts; mv src/b.ts src/renamed.ts; rm src/c.ts; mkdir new; echo n > new/x
    dd if=/dev/urandom of=big.db bs=4096 count=1 seek=100 conv=notrunc status=none
    sha256sum big.db > /data/work/expected-big
    chmod 600 motd; ln -s motd link; rm -r dir
    (setsid sleep 300 < /dev/null > /dev/null 2>&1 &)
    echo out; echo err >&2; exit 3'
  out=$("$blockd" call --store "$store" --snapshot "$S" --cache "$work/cache-call-$fs" \
    --dir "$work/ws-$fs" --work "$work/call-work-$fs" --mode loop --log "$work/call-$fs.log" \
    --patch "patches/$fs-1" --result "$result" --command "$command" 2> "$work/call-$fs.err") \
    || { cat "$work/call-$fs.log" "$work/call-$fs.err"; fail "$fs: blockd call"; }
  [ "$out" = out ] || fail "$fs: the command's stdout was $out"
  grep -q '^err$' "$work/call-$fs.err" || fail "$fs: the command's stderr"
  json=$(cat "$result")
  echo "$json" | grep -q '"exitCode":3' || fail "$fs: exit code in $json"
  echo "$json" | grep -q 'sleep 300' || fail "$fs: the survivor in $json"
  pgrep -f "sleep 300" >/dev/null && fail "$fs: a survivor outlived its call"
  for path in src/a.ts src/b.ts src/renamed.ts src/c.ts new big.db motd link dir; do has "$json" "$path" "$fs call"; done
  lacks "$json" "src/x" "$fs call"
  bytes=$(echo "$json" | sed -E 's/.*"bytes":([0-9]+).*/\1/')
  if [ "$fs" = btrfs ]; then
    [ "$bytes" -lt 1048576 ] || fail "btrfs: a 4 KiB write to an 8 MiB file sent $bytes bytes"
  fi
  [ -e "$work/ws-$fs" ] && mountpoint -q "$work/ws-$fs" && fail "$fs: the call stayed mounted"
  pass "$fs: a call on an ephemeral fork made a patch ($bytes bytes) and stopped what it left running"

  # A mounted head: its own changes are checkpointed, the patch applies.
  head="session-$fs"; dir="$work/mnt-$fs"; sock="$work/$fs.sock"
  "$blockd" fork --store "$store" --from "base-$fs" --to "$head" >/dev/null
  mount_head "$head" "$dir" "$sock" "$work/cache-head-$fs"
  echo mine > "$dir/headfile"
  sync -f "$dir"
  sleep 0.3
  checkpoint=$(control "$sock" '{"op":"checkpoint"}')
  has "$checkpoint" headfile "$fs checkpoint"
  applied=$(control "$sock" "{\"op\":\"apply\",\"patches\":[\"patches/$fs-1\"]}") || fail "$fs: apply: $applied"
  lacks "$applied" headfile "$fs apply's checkpoint"
  [ "$(cat "$dir/src/a.ts")" = "$(printf 'a\nchanged')" ] || fail "$fs: src/a.ts is $(cat "$dir/src/a.ts")"
  [ "$(cat "$dir/src/renamed.ts")" = b ] || fail "$fs: the rename"
  [ ! -e "$dir/src/b.ts" ] && [ ! -e "$dir/src/c.ts" ] && [ ! -e "$dir/dir" ] || fail "$fs: the deletes"
  [ "$(cat "$dir/new/x")" = n ] || fail "$fs: the new directory"
  (cd "$dir" && sha256sum -c /data/work/expected-big >/dev/null) || fail "$fs: big.db's 4 KiB write"
  [ "$(stat -c %a "$dir/motd")" = 600 ] || fail "$fs: chmod"
  [ "$(readlink "$dir/link")" = motd ] || fail "$fs: the symlink"
  [ "$(cat "$dir/headfile")" = mine ] || fail "$fs: the head's own file"
  sleep 0.3
  after=$(control "$sock" '{"op":"checkpoint"}')
  for path in src/a.ts new big.db; do lacks "$after" "$path" "$fs: the patch's own writes"; done
  echo later > "$dir/later"
  sync -f "$dir"; sleep 0.3
  detached=$(control "$sock" '{"op":"detach"}')
  has "$detached" later "$fs detach"
  wait
  pass "$fs: a head checkpoints its own changes, applies a patch, and doesn't report the patch's writes"

  # Two snapshots nobody tracked: a diff.
  T=$(snapshot_of "$head")
  diffed=$("$blockd" diff --store "$store" --from "$S" --to "$T" --cache "$work/cache-d1-$fs" \
    --cache-to "$work/cache-d2-$fs" --work "$work/diff-$fs" --mode loop --patch-file "$work/diff-$fs.patch" 2>"$work/diff-$fs.log") \
    || { cat "$work/diff-$fs.log"; fail "$fs: blockd diff"; }
  for path in src/a.ts src/renamed.ts src/c.ts headfile later new; do has "$diffed" "$path" "$fs diff"; done
  lacks "$diffed" '"src"' "$fs diff"
  copy="$work/copy-$fs"; rm -rf "$copy"; cp -a "$work/rootfs-$fs" "$copy"
  "$blockd" apply --dir "$copy" --patch-file "$work/diff-$fs.patch" >/dev/null
  [ "$(cat "$copy/later")" = later ] && [ "$(cat "$copy/src/renamed.ts")" = b ] || fail "$fs: applying the diff"
  pass "$fs: a diff of two snapshots applies to a copy of the first"
done
echo "ALL PASSED"
