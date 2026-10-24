#!/usr/bin/env bash
# Runs as root in a privileged container. $1 is the blockd binary; $2.. are
# the filesystems to test.
set -euo pipefail
blockd="$1"; shift
store="local:/data/store"
work=/data/work
rm -rf /data && mkdir -p "$work"
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; cat "$work/daemon.log" 2>/dev/null | tail -30; exit 1; }
has() { echo "$1" | grep -q "\"$2\"" || fail "$3: expected $2 in $1"; }
lacks() { echo "$1" | grep -q "\"$2\"" && fail "$3: didn't expect $2 in $1"; return 0; }
field() { echo "$1" | grep -o "\"$2\":\"[^\"]*\"" | head -1 | sed -E 's/.*:"(.*)"/\1/'; }
snapshot_of() { "$blockd" history --store "$store" --head "$1" --limit 1; }

export BLOCKD_DAEMON_TOKEN=secret-token
address=127.0.0.1:7681
req() { "$blockd" request --daemon "$address" --path "$1" ${2:+--body "$2"}; }
# A call: start it, then wait for its result.
call() { # body
  local started id result
  started=$(req /v1/calls "$1") || fail "starting a call: $started"
  id=$(field "$started" id)
  for _ in $(seq 1 60); do
    result=$(req "/v1/calls/$id?wait=5000") || fail "waiting for $id: $result"
    echo "$result" | grep -q '"done":true' && { echo "$result"; return 0; }
  done
  fail "call $id never finished"
}

# The store's credentials never reach a command.
export AWS_SECRET_ACCESS_KEY=store-secret
"$blockd" daemon --listen "$address" --socket "$work/daemon.sock" --pidfile "$work/daemon.pid" \
  --state "$work/state" --run "$work/run" > "$work/daemon.log" 2>&1 &
for _ in $(seq 1 100); do [ -f "$work/daemon.pid" ] && break; sleep 0.05; done
[ -f "$work/daemon.pid" ] || fail "the daemon never started"
unset AWS_SECRET_ACCESS_KEY

denied=$(BLOCKD_DAEMON_TOKEN=wrong "$blockd" request --daemon "$address" --path /v1/status) \
  && fail "a wrong token was let in: $denied"
status=$("$blockd" request --daemon "$work/daemon.sock" --path /v1/status) || fail "status over the socket"
has "$status" uptimeMs "status"
pass "the daemon answers on TCP and its socket, and refuses a wrong token"

base_image() { # fs image
  local root="$work/rootfs-$1"
  rm -rf "$root" && mkdir -p "$root/src"
  echo a > "$root/src/a.ts"; echo b > "$root/src/b.ts"
  head -c 4194304 /dev/urandom > "$root/big.db"
  case "$1" in
    ext4) mkfs.ext4 -q -F -b 4096 -d "$root" "$2" 256M ;;
    btrfs)
      local layout="$work/layout-btrfs"
      rm -rf "$layout" && mkdir -p "$layout/.alchemy" && cp -a "$root" "$layout/data"
      truncate -s 256M "$2"
      mkfs.btrfs -q -f -s 4096 --rootdir "$layout" --subvol default:data "$2" >/dev/null ;;
  esac
}

for fs in "$@"; do
  img="$work/base-$fs.img"
  base_image "$fs" "$img"
  "$blockd" import --store "$store" --head "base-$fs" --image "$img" >/dev/null
  S=$(snapshot_of "base-$fs")
  common="\"store\":\"$store\",\"mode\":\"loop\""

  # A mounted head: its own writes are checkpointed.
  head="session-$fs"; dir="$work/mnt-$fs"
  "$blockd" fork --store "$store" --from "base-$fs" --to "$head" >/dev/null
  mounted=$(req /v1/heads "{$common,\"head\":\"$head\",\"dir\":\"$dir\",\"flushEvery\":0}") \
    || fail "$fs: mounting: $mounted"
  has "$mounted" timings "$fs mount"
  again=$(req /v1/heads "{$common,\"head\":\"$head\",\"dir\":\"$dir-2\"}") \
    && fail "$fs: a second mount of one head: $again"
  echo mine > "$dir/headfile"; sync -f "$dir"; sleep 0.3
  checkpoint=$(req "/v1/heads/$head/checkpoint" '{}') || fail "$fs: checkpoint: $checkpoint"
  has "$checkpoint" headfile "$fs checkpoint"
  snap=$(field "$(req "/v1/heads/$head/snapshot" "{\"freeze\":\"$dir\"}")" snapshot)
  pass "$fs: a head mounts over HTTP, once, and checkpoints its own writes"

  # Three calls at once on forks of the head's snapshot, each a patch.
  pids=()
  started=$(date +%s%N)
  for i in 1 2 3; do
    (call "{$common,\"snapshot\":\"$snap\",\"dir\":\"$work/ws-$fs-$i\",\"patch\":\"patches/$fs-$i\",
      \"command\":\"sleep 1; echo call$i > file$i; cat headfile; echo err$i >&2; env | grep -c '^AWS_' || true; exit $i\",
      \"env\":{\"MINE\":\"x\"}}" > "$work/result-$fs-$i") &
    pids+=($!)
  done
  wait "${pids[@]}" || true
  elapsed=$(( ($(date +%s%N) - started) / 1000000 ))
  [ "$elapsed" -lt 2900 ] || fail "$fs: three 1-second calls took ${elapsed} ms: not at once"
  for i in 1 2 3; do
    result=$(cat "$work/result-$fs-$i")
    echo "$result" | grep -q "\"exitCode\":$i" || fail "$fs: call $i's exit code: $result"
    has "$result" "file$i" "$fs call $i"
    has "$result" run "$fs call $i timings"
    out=$(field "$result" stdout | base64 -d)
    [ "$out" = "$(printf 'mine\n0')" ] || fail "$fs: call $i's stdout was $out (the head's file, and no AWS_ variables)"
    [ "$(field "$result" stderr | base64 -d)" = "err$i" ] || fail "$fs: call $i's stderr"
  done
  status=$(req /v1/status)
  echo "$status" | grep -qE '"calls":[0-9]+' || fail "$fs: the status counts calls: $status"
  pass "$fs: three calls ran at once (${elapsed} ms), each made a patch, and saw no store credentials"

  # A call forked from the mounted head as it is now: what it wrote and never
  # snapshotted, the fork sees; the call reports the head's snapshot taken as it forked.
  echo unsnapshotted > "$dir/dirty.txt"; sync -f "$dir"
  result=$(call "{$common,\"fork\":\"$head\",\"dir\":\"$work/fork-$fs\",\"command\":\"cat dirty.txt\"}")
  [ "$(field "$result" stdout | base64 -d)" = unsnapshotted ] || fail "$fs: a fork of the head didn't see its write: $result"
  forked_at=$(field "$result" snapshot)
  [ "$forked_at" = "$(snapshot_of "$head")" ] || fail "$fs: the fork's base $forked_at isn't the head's snapshot"
  pass "$fs: a call forks the mounted head as it is, with its snapshot uploaded meanwhile"

  # The head applies them; a detach reports what changed since.
  applied=$(req "/v1/heads/$head/apply" "{\"patches\":[\"patches/$fs-1\",\"patches/$fs-2\",\"patches/$fs-3\"]}") \
    || fail "$fs: apply: $applied"
  has "$applied" fetch "$fs apply timings"
  for i in 1 2 3; do [ "$(cat "$dir/file$i")" = "call$i" ] || fail "$fs: file$i after apply"; done
  echo later > "$dir/later"; sync -f "$dir"; sleep 0.3
  detached=$(req "/v1/heads/$head/detach" '{}') || fail "$fs: detach: $detached"
  has "$detached" later "$fs detach"
  lacks "$detached" file1 "$fs detach"
  mountpoint -q "$dir" && fail "$fs: the head stayed mounted"
  req "/v1/heads/$head/status" '{}' >/dev/null && fail "$fs: a detached head still answers"
  pass "$fs: the head applied the calls' patches and detached"

  # A kept call: its process runs on, commits pick up what it writes.
  started=$(req /v1/calls "{$common,\"snapshot\":\"$S\",\"dir\":\"$work/host-$fs\",\"patch\":\"patches/$fs-h1\",\"keep\":true,
    \"command\":\"(setsid sh -c 'for i in 1 2 3 4; do echo line\$i >> out.log; sleep 0.25; done; sleep 600' < /dev/null > /dev/null 2>&1 &); echo started > marker\"}")
  id=$(field "$started" id)
  first=$(req "/v1/calls/$id?wait=30000")
  echo "$first" | grep -q '"kept":true' || fail "$fs: not kept: $first"
  sleep 1.5
  second=$(req "/v1/calls/$id/commit" "{\"patch\":\"patches/$fs-h2\"}") || fail "$fs: commit: $second"
  has "$second" out.log "$fs kept commit"
  lacks "$second" marker "$fs kept commit"
  last=$(req "/v1/calls/$id/detach" "{\"patch\":\"patches/$fs-h3\"}") || fail "$fs: detach: $last"
  pgrep -f "sleep 600" >/dev/null && fail "$fs: a kept process outlived its detach"
  mountpoint -q "$work/host-$fs" && fail "$fs: a kept call stayed mounted"
  pass "$fs: a kept call's process ran on and its commits picked up what it wrote"

  # A diff of two snapshots.
  T=$(snapshot_of "$head")
  diffed=$(req /v1/diffs "{$common,\"from\":\"$S\",\"to\":\"$T\",\"patch\":\"patches/$fs-diff\"}") \
    || fail "$fs: diff: $diffed"
  for path in headfile later file1 file2 file3; do has "$diffed" "$path" "$fs diff"; done
  pass "$fs: a diff of two snapshots"

  # A second round of calls reuses the caches the first left.
  result=$(call "{$common,\"snapshot\":\"$S\",\"dir\":\"$work/ws-$fs-again\",\"command\":\"cat big.db > /dev/null\"}")
  echo "$result" | grep -q '"exitCode":0' || fail "$fs: a read of big.db: $result"
  pass "$fs: $(echo "$result" | sed -E 's/.*"timings":(\{[^}]*\}).*/timings \1/')"
done

kill "$(cat "$work/daemon.pid")"
echo "ALL PASSED"
