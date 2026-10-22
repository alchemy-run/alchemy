#!/usr/bin/env bash
# Runs as root on an EC2 instance with KVM (nested virtualization): calls in
# Firecracker microVMs through blockd's daemon, with a local store. $1 is the
# daemon (blockd-host-<arch>), $2 a static blockd (the guest's init).
set -euo pipefail
blockd="$(realpath "$1")"; init="$(realpath "$2")"; shift 2
arch=$(uname -m)
store="local:/data/store"
work=/data/work
mkdir -p /data && rm -rf /data/* && mkdir -p "$work"
pass() { echo "PASS: $*"; }
fail() { echo "FAIL: $*"; tail -40 "$work/daemon.log" 2>/dev/null; for f in /data/state/vm-*/console.log; do [ -f "$f" ] && tail -30 "$f"; done; exit 1; }
field() { echo "$1" | grep -o "\"$2\":\"[^\"]*\"" | head -1 | sed -E 's/.*:"(.*)"/\1/'; }
snapshot_of() { "$blockd" history --store "$store" --head "$1" --limit 1; }
export BLOCKD_DAEMON_TOKEN=secret
address=127.0.0.1:7681
req() { "$blockd" request --daemon "$address" --path "$1" ${2:+--body "$2"}; }
wait_for() {
  local result
  for _ in $(seq 1 60); do
    result=$(req "/v1/calls/$1?wait=5000") || fail "waiting for $1: $result"
    echo "$result" | grep -q '"done":true' && { echo "$result"; return 0; }
  done
  fail "$1 never finished"
}
call() { wait_for "$(field "$(req /v1/calls "$1")" id)"; }

[ -c /dev/kvm ] || fail "no /dev/kvm: nested virtualization isn't on"
echo "{\"kvm\":true,\"kernel\":\"$(uname -r)\",\"cpus\":$(nproc)}"

# Firecracker and its CI guest kernel (6.1: overlayfs, vsock, ext4, fanotify).
curl -fsSL "https://github.com/firecracker-microvm/firecracker/releases/download/v1.17.0/firecracker-v1.17.0-$arch.tgz" | tar -xz -C /tmp
install -m 0755 "/tmp/release-v1.17.0-$arch/firecracker-v1.17.0-$arch" /usr/local/bin/firecracker
curl -fsSL "https://s3.amazonaws.com/spec.ccfc.min/firecracker-ci/v1.15/$arch/vmlinux-6.1.155" -o /data/vmlinux

"$blockd" daemon --listen "$address" --pidfile "$work/daemon.pid" --state /data/state --run /data/run \
  --init "$init" --firecracker /usr/local/bin/firecracker --kernel /data/vmlinux > "$work/daemon.log" 2>&1 &
for _ in $(seq 1 100); do [ -f "$work/daemon.pid" ] && break; sleep 0.05; done

# An image (busybox) and a workspace, each a volume.
img="$work/image"; mkdir -p "$img/bin" "$img/etc" "$img/workspace" "$img/tmp" "$img/root" "$img/proc" "$img/dev" "$img/sys"
cp /bin/busybox "$img/bin/busybox"
for applet in $("$img/bin/busybox" --list); do [ "$applet" = busybox ] || ln -sf busybox "$img/bin/$applet"; done
echo "a microVM's image" > "$img/etc/motd"
mkfs.ext4 -q -F -b 4096 -d "$img" "$work/image.img" 64M
"$blockd" import --store "$store" --head image --image "$work/image.img" >/dev/null
I=$(snapshot_of image)
root="$work/rootfs"; mkdir -p "$root/src"; echo a > "$root/src/a.ts"
mkfs.ext4 -q -F -b 4096 -d "$root" "$work/base.img" 64M
"$blockd" import --store "$store" --head base --image "$work/base.img" >/dev/null
S=$(snapshot_of base)
mode=$(modprobe ublk_drv 2>/dev/null && echo ublk || echo nbd)
common="\"store\":\"$store\",\"mode\":\"$mode\",\"isolation\":{\"runtime\":\"firecracker\",\"image\":\"$I\",\"path\":\"/workspace\"}"

# Warming the image makes the snapshot microVMs are restored from.
t=$(date +%s%N)
req /v1/images "{\"store\":\"$store\",\"image\":\"$I\",\"mode\":\"$mode\"}" >/dev/null || fail "warming the image"
echo "{\"step\":\"warm the image and snapshot a microVM\",\"ms\":$(( ($(date +%s%N) - t) / 1000000 ))}"

t=$(date +%s%N)
result=$(call "{$common,\"snapshot\":\"$S\",\"dir\":\"$work/ws\",\"patch\":\"patches/vm-1\",
  \"command\":\"cat /etc/motd; pwd; cat src/a.ts; echo new > new.txt; echo outside > /etc/outside; uname -r; exit 5\"}")
echo "{\"step\":\"a call in a microVM\",\"ms\":$(( ($(date +%s%N) - t) / 1000000 )),\"timings\":$(echo "$result" | grep -o '"timings":{[^}]*}' | sed 's/"timings"://')}"
echo "$result" | grep -q '"exitCode":5' || fail "the exit code: $result"
out=$(field "$result" stdout | base64 -d)
echo "$out" | head -3 | tr '\n' '|' | grep -q "a microVM's image|/workspace|a|" || fail "the microVM's stdout: $out"
echo "$out" | tail -1 | grep -q "^6.1" || fail "not the guest's kernel: $out"
echo "$result" | grep -q '"new.txt"' || fail "the patch: $result"
echo "$result" | grep -q '"outside"' && fail "the image's write reached the patch: $result"
pass "a call ran in a microVM on the image (guest kernel $(echo "$out" | tail -1)), and its patch has only the workspace's changes"

# The patch applies on the host's view, as any call's does.
"$blockd" fork --store "$store" --from base --to session >/dev/null
req /v1/heads "{\"store\":\"$store\",\"mode\":\"$mode\",\"head\":\"session\",\"dir\":\"$work/head\",\"flushEvery\":0}" >/dev/null
req /v1/heads/session/apply '{"patches":["patches/vm-1"]}' >/dev/null
[ "$(cat "$work/head/new.txt")" = new ] || fail "the microVM's patch didn't apply"
pass "the microVM's patch applies to the session's head"

# A process left running keeps the microVM, and later commits pick up what it writes.
started=$(req /v1/calls "{$common,\"snapshot\":\"$S\",\"dir\":\"$work/kept\",\"patch\":\"patches/vm-k1\",\"keep\":true,
  \"command\":\"(sh -c 'for i in 1 2 3 4; do echo line\$i >> out.log; sleep 0.25; done; sleep 300' > /dev/null 2>&1 &); echo marker > marker\"}")
id=$(field "$started" id)
first=$(wait_for "$id")
echo "$first" | grep -q '"kept":true' || fail "not kept: $first"
sleep 1.5
second=$(req "/v1/calls/$id/commit" "{\"patch\":\"patches/vm-k2\"}") || fail "commit: $second"
echo "$second" | grep -q '"out.log"' || fail "the kept microVM's commit: $second"
seen=$(wait_for "$(field "$(req "/v1/calls/$id/exec" '{"command":"cat marker"}')" id)")
[ "$(field "$seen" stdout | base64 -d)" = marker ] || fail "exec on the kept microVM: $seen"
req "/v1/calls/$id/detach" "{\"patch\":\"patches/vm-k3\"}" >/dev/null || fail "detach"
pgrep -x firecracker >/dev/null && fail "a microVM outlived its detach"
pass "a microVM call keeps what it left running, commits what it writes, and runs later commands beside it"

# A call that leaves nothing running isn't kept, even when it may be.
result=$(call "{$common,\"snapshot\":\"$S\",\"dir\":\"$work/nokeep\",\"keep\":true,\"command\":\"echo hi\"}")
echo "$result" | grep -q '"kept":true' && fail "a call with nothing left running was kept: $result"
pass "a call that leaves nothing running ends with its microVM"

# A VM restored from the host's snapshot has the host's time, not the snapshot's.
sleep 3
result=$(call "{$common,\"snapshot\":\"$S\",\"dir\":\"$work/clock\",\"command\":\"date +%s\"}")
guest=$(field "$result" stdout | base64 -d); host=$(date +%s)
[ $(( host - guest )) -le 2 ] && [ $(( guest - host )) -le 2 ] || fail "the microVM's clock is $guest, the host's $host"
pass "a restored microVM's clock is the host's"

# Calls at once.
t=$(date +%s%N)
pids=()
for i in 1 2 3 4; do req /v1/calls "{$common,\"snapshot\":\"$S\",\"dir\":\"$work/p$i\",\"command\":\"sleep 1\"}" > "$work/p$i.id" & pids+=($!); done
wait "${pids[@]}"
for i in 1 2 3 4; do wait_for "$(field "$(cat "$work/p$i.id")" id)" >/dev/null; done
echo "{\"step\":\"4 calls of 1 s at once\",\"ms\":$(( ($(date +%s%N) - t) / 1000000 ))}"

# Boot time, warm: five calls one after another.
for i in 1 2 3 4 5; do
  t=$(date +%s%N)
  result=$(call "{$common,\"snapshot\":\"$S\",\"dir\":\"$work/w$i\",\"command\":\"true\"}")
  echo "{\"step\":\"warm call $i\",\"ms\":$(( ($(date +%s%N) - t) / 1000000 )),\"timings\":$(echo "$result" | grep -o '"timings":{[^}]*}' | sed 's/"timings"://')}"
done
grep -E "restoring one failed|no template to restore" "$work/daemon.log" && fail "microVMs booted instead of restoring"
pass "every microVM was restored from the host's snapshot"
kill "$(cat "$work/daemon.pid")"
echo "ALL PASSED"
