#!/usr/bin/env bash
# Runs as root in a privileged container. $1 is the blockd binary (the
# daemon), $2 a static blockd (containers' init); $3.. are the runtimes.
set -euo pipefail
blockd="$1"; init="$2"; shift 2
store="local:/data/store"
work=/data/work
rm -rf /data && mkdir -p "$work"
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; tail -30 "$work/daemon.log" 2>/dev/null; exit 1; }
has() { echo "$1" | grep -q "\"$2\"" || fail "$3: expected $2 in $1"; }
lacks() { echo "$1" | grep -q "\"$2\"" && fail "$3: didn't expect $2 in $1"; return 0; }
field() { echo "$1" | grep -o "\"$2\":\"[^\"]*\"" | head -1 | sed -E 's/.*:"(.*)"/\1/'; }
snapshot_of() { "$blockd" history --store "$store" --head "$1" --limit 1; }
export BLOCKD_DAEMON_TOKEN=secret
address=127.0.0.1:7681
req() { "$blockd" request --daemon "$address" --path "$1" ${2:+--body "$2"}; }
wait_for() { # id → the finished result
  local result
  for _ in $(seq 1 60); do
    result=$(req "/v1/calls/$1?wait=5000") || fail "waiting for $1: $result"
    echo "$result" | grep -q '"done":true' && { echo "$result"; return 0; }
  done
  fail "$1 never finished"
}
call() { wait_for "$(field "$(req /v1/calls "$1")" id)"; }

start_daemon() {
  rm -f "$work/daemon.pid"
  "$blockd" daemon --listen "$address" --pidfile "$work/daemon.pid" --state "$work/state" \
    --run "$work/run" --init "$init" --trace-seconds 2 >> "$work/daemon.log" 2>&1 &
  for _ in $(seq 1 100); do [ -f "$work/daemon.pid" ] && break; sleep 0.05; done
  [ -f "$work/daemon.pid" ] || fail "the daemon never started"
}
start_daemon

# An image: busybox, imported as a volume of its own.
img="$work/image"
mkdir -p "$img/bin" "$img/etc" "$img/workspace" "$img/tmp" "$img/root" "$img/proc" "$img/dev" "$img/sys"
cp /bin/busybox "$img/bin/busybox"
for applet in $("$img/bin/busybox" --list); do [ "$applet" = busybox ] || ln -sf busybox "$img/bin/$applet"; done
echo "root:x:0:0:root:/root:/bin/sh" > "$img/etc/passwd"
echo "a busybox image" > "$img/etc/motd"
mkfs.ext4 -q -F -b 4096 -d "$img" "$work/image.img" 64M
"$blockd" import --store "$store" --head image --image "$work/image.img" >/dev/null
I=$(snapshot_of image)

# The workspace.
root="$work/rootfs"; mkdir -p "$root/src"; echo a > "$root/src/a.ts"
mkfs.ext4 -q -F -b 4096 -d "$root" "$work/base.img" 64M
"$blockd" import --store "$store" --head base --image "$work/base.img" >/dev/null
S=$(snapshot_of base)

for runtime in "$@"; do
  iso="\"isolation\":{\"runtime\":\"$runtime\",\"image\":\"$I\",\"path\":\"/workspace\",\"env\":{\"FROM_IMAGE\":\"yes\"}}"
  common="\"store\":\"$store\",\"mode\":\"loop\",$iso"

  # A call in a container: the image's files, the workspace at its path, its patch.
  result=$(call "{$common,\"snapshot\":\"$S\",\"dir\":\"$work/ws-$runtime\",\"patch\":\"patches/$runtime-1\",
    \"command\":\"cat /etc/motd; pwd; cat src/a.ts; echo new > new.txt; echo outside > /etc/outside; echo \$FROM_IMAGE \$MINE; exit 7\",
    \"env\":{\"MINE\":\"mine\"}}")
  echo "$result" | grep -q '"exitCode":7' || fail "$runtime: exit code: $result"
  out=$(field "$result" stdout | base64 -d)
  [ "$out" = "$(printf 'a busybox image\n/workspace\na\nyes mine')" ] || fail "$runtime: stdout was $out"
  has "$result" new.txt "$runtime call"
  lacks "$result" outside "$runtime call"
  has "$result" container "$runtime call timings"
  pass "$runtime: a call ran in a container on the image, with the workspace at /workspace, and its patch has only the workspace's changes"

  # Something left running is stopped and reported, unless the call keeps it.
  result=$(call "{$common,\"snapshot\":\"$S\",\"dir\":\"$work/ws-$runtime\",
    \"command\":\"(sleep 300 > /dev/null 2>&1 &); echo started\"}")
  # (gVisor reports a process by its name, runc by its command line.)
  echo "$result" | grep -qE '"command":"sleep( 300)?"' || fail "$runtime: the survivor in $result"
  echo "$result" | grep -q '"kept":false' || fail "$runtime: kept without keep: $result"
  started=$(req /v1/calls "{$common,\"snapshot\":\"$S\",\"dir\":\"$work/host-$runtime\",\"patch\":\"patches/$runtime-h1\",\"keep\":true,
    \"command\":\"(sh -c 'for i in 1 2 3 4; do echo line\$i >> out.log; sleep 0.25; done; sleep 300' > /dev/null 2>&1 &); echo marker > marker\"}")
  id=$(field "$started" id)
  first=$(wait_for "$id")
  echo "$first" | grep -q '"kept":true' || fail "$runtime: not kept: $first"
  sleep 1.5
  second=$(req "/v1/calls/$id/commit" "{\"patch\":\"patches/$runtime-h2\"}") || fail "$runtime: commit: $second"
  has "$second" out.log "$runtime kept commit"
  lacks "$second" marker "$runtime kept commit"
  # A later command runs beside what the call left running, on its fork.
  seen=$(wait_for "$(field "$(req "/v1/calls/$id/exec" '{"command":"cat marker; ls out.log"}')" id)")
  [ "$(field "$seen" stdout | base64 -d)" = "$(printf 'marker\nout.log')" ] || fail "$runtime: exec on the kept call: $seen"
  req "/v1/calls/$id/detach" "{\"patch\":\"patches/$runtime-h3\"}" >/dev/null || fail "$runtime: detach"
  pgrep -f "sleep 300" >/dev/null && fail "$runtime: a kept process outlived its detach"
  pass "$runtime: what a call leaves running is stopped, or kept with its container and committed as it writes"

  # A head whose commands run in its container.
  head="session-$runtime"; dir="$work/head-$runtime"
  "$blockd" fork --store "$store" --from base --to "$head" >/dev/null
  req /v1/heads "{$common,\"head\":\"$head\",\"dir\":\"$dir\",\"flushEvery\":0}" >/dev/null || fail "$runtime: mount"
  ran=$(wait_for "$(field "$(req "/v1/heads/$head/exec" '{"command":"pwd; echo from-head > head.txt; cat /etc/motd"}')" id)")
  [ "$(field "$ran" stdout | base64 -d)" = "$(printf '/workspace\na busybox image')" ] || fail "$runtime: head exec: $ran"
  [ "$(cat "$dir/head.txt")" = from-head ] || fail "$runtime: the head's file isn't on its mount"
  # A background process: its output by offset, then killed.
  spawned=$(req "/v1/heads/$head/spawn" '{"command":"echo one; sleep 0.3; echo two; sleep 300"}')
  sid=$(field "$spawned" id)
  sleep 1
  read1=$(req "/v1/spawns/$sid?stream=out&offset=0")
  [ "$(field "$read1" data | base64 -d)" = "$(printf 'one\ntwo')" ] || fail "$runtime: spawn output: $read1"
  echo "$read1" | grep -q '"exitCode":null' || fail "$runtime: the spawn ended early: $read1"
  req "/v1/spawns/$sid/kill" '{"signal":9}' >/dev/null
  sleep 0.5
  req "/v1/spawns/$sid?stream=out&offset=8" | grep -q '"exitCode":[0-9]' || fail "$runtime: the spawn wasn't killed"
  req "/v1/heads/$head/detach" '{}' >/dev/null || fail "$runtime: head detach"
  pass "$runtime: a head's commands run in its container, on its mount"
done

# The store's heads through the daemon.
common="\"store\":\"$store\""
req /v1/store/fork "{$common,\"from\":\"base\",\"to\":\"forked\"}" >/dev/null || fail "store fork"
[ "$(field "$(req /v1/store/head "{$common,\"head\":\"forked\"}")" snapshot)" = "$S" ] || fail "store head"
req /v1/store/history "{$common,\"head\":\"forked\",\"limit\":5}" | grep -q "$S" || fail "store history"
req /v1/store/drop "{$common,\"head\":\"forked\"}" >/dev/null || fail "store drop"
req /v1/store/head "{$common,\"head\":\"forked\"}" | grep -q '"snapshot":null' || fail "a dropped head is still there"
pass "the store's heads fork, read, list their history and drop through the daemon"

status=$(req /v1/status)
echo "$status" | grep -q '"images":1' || fail "the image was mounted more than once: $status"
pass "one image mount served every container"

# Calls at once on one snapshot, each on its own cache file: what one fetched,
# the others read from the machine's chunk cache.
pids=()
for i in 1 2 3; do
  (call "{\"store\":\"$store\",\"mode\":\"loop\",\"snapshot\":\"$S\",\"dir\":\"$work/chunk-$i\",\"command\":\"cat src/a.ts > /dev/null\"}" > /dev/null) &
  pids+=($!)
done
wait "${pids[@]}"
hits=$(req /v1/status | sed -E 's/.*"chunks":\{"hits":([0-9]+).*/\1/')
[ "$hits" -gt 0 ] || fail "no chunk was shared between devices: $(req /v1/status)"
pass "devices on one machine share the extents any of them fetched ($hits hits)"

# An image's first start is traced; the next machine to mount it fetches the trace ahead.
sleep 3
ls /data/store/blobs/traces/ 2>/dev/null | grep -q "$I" || fail "the image's trace wasn't saved"
kill "$(cat "$work/daemon.pid")"; sleep 1
# The killed daemon's mounts are stale: away with them, and its cache.
for m in $(grep -o " $work/state[^ ]*" /proc/mounts | sort -r); do umount -l "$m" 2>/dev/null || true; done
losetup -D 2>/dev/null || true
rm -rf "$work/state" || true
start_daemon
warm=$(req /v1/images "{\"store\":\"$store\",\"mode\":\"loop\",\"image\":\"$I\"}") || fail "warming the image: $warm"
echo "$warm" | grep -q '"prefetching":true' || fail "the image wasn't prefetched from its trace: $warm"
pass "an image's first start is traced, and a later mount fetches the trace ahead"
kill "$(cat "$work/daemon.pid")"
echo "ALL PASSED"
