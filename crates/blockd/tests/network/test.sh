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
stdout() { field "$1" stdout | base64 -d; }

# "The outside": a namespace with a server at two addresses, one the host denies.
ip netns add outside
ip link add out-host type veth peer name out-peer
ip link set out-peer netns outside
ip addr add 192.168.77.1/24 dev out-host; ip addr add 192.168.78.1/24 dev out-host; ip link set out-host up
ip -n outside addr add 192.168.77.2/24 dev out-peer; ip -n outside addr add 192.168.78.2/24 dev out-peer
ip -n outside link set out-peer up; ip -n outside link set lo up
ip -n outside route add default via 192.168.77.1
mkdir -p "$work/www"; echo "from outside" > "$work/www/index.html"
ip netns exec outside busybox httpd -p 8000 -h "$work/www"
# And a server on the host itself, which commands mustn't reach.
mkdir -p "$work/hostwww"; echo "from the host" > "$work/hostwww/index.html"
busybox httpd -p 8001 -h "$work/hostwww"

"$blockd" daemon --listen "$address" --pidfile "$work/daemon.pid" --state "$work/state" --run "$work/run" \
  --init "$init" --egress-deny 192.168.78.0/24 > "$work/daemon.log" 2>&1 &
for _ in $(seq 1 100); do [ -f "$work/daemon.pid" ] && break; sleep 0.05; done

img="$work/image"
mkdir -p "$img/bin" "$img/etc" "$img/workspace" "$img/tmp" "$img/root" "$img/proc" "$img/dev" "$img/sys"
cp /bin/busybox "$img/bin/busybox"
for applet in $("$img/bin/busybox" --list); do [ "$applet" = busybox ] || ln -sf busybox "$img/bin/$applet"; done
mkfs.ext4 -q -F -b 4096 -d "$img" "$work/image.img" 64M
"$blockd" import --store "$store" --head image --image "$work/image.img" >/dev/null
I=$(snapshot_of image)
mkdir -p "$work/rootfs"; echo a > "$work/rootfs/a.txt"
mkfs.ext4 -q -F -b 4096 -d "$work/rootfs" "$work/base.img" 64M
"$blockd" import --store "$store" --head base --image "$work/base.img" >/dev/null
S=$(snapshot_of base)

fetch() { echo "wget -q -T 2 -O- http://$1/ 2>/dev/null || echo unreachable"; }
for runtime in "$@"; do
  iso() { echo "\"isolation\":{\"runtime\":\"$runtime\",\"image\":\"$I\",\"path\":\"/workspace\",\"hostNetwork\":false${1:-}}"; }
  common="\"store\":\"$store\",\"mode\":\"loop\",\"snapshot\":\"$S\""

  result=$(call "{$common,$(iso),\"dir\":\"$work/a-$runtime\",\"command\":\"ip -4 -o addr show eth0 | grep -o '10\\\\.200\\\\.[0-9.]*'; cat /etc/resolv.conf | head -1; $(fetch 192.168.77.2:8000); $(fetch 192.168.78.2:8000); $(fetch 10.200.0.1:8001); $(fetch 169.254.169.254)\"}")
  out=$(stdout "$result")
  echo "$out" | head -1 | grep -q "^10\.200\." || fail "$runtime: no address of its own: $out"
  echo "$out" | sed -n 2p | grep -q "^nameserver" || fail "$runtime: no resolver: $out"
  [ "$(echo "$out" | sed -n 3,6p | tr '\n' '|')" = "from outside|unreachable|unreachable|unreachable|" ] || fail "$runtime: egress: $out"
  pass "$runtime: a command has a network of its own: out through NAT, but not to what the host denies, the host itself, or the metadata service"

  result=$(call "{$common,$(iso ',"egress":["10.99.0.0/16"]'),\"dir\":\"$work/b-$runtime\",\"command\":\"$(fetch 192.168.77.2:8000)\"}")
  [ "$(stdout "$result")" = unreachable ] || fail "$runtime: the allowlist let it out: $(stdout "$result")"
  result=$(call "{$common,$(iso ',"egress":["192.168.77.0/24"]'),\"dir\":\"$work/c-$runtime\",\"command\":\"$(fetch 192.168.77.2:8000)\"}")
  [ "$(stdout "$result")" = "from outside" ] || fail "$runtime: the allowlist kept it in: $(stdout "$result")"
  iptables -S BLOCKD-EGRESS | grep -q -- "-s 10.200" && fail "$runtime: a finished call's rules stayed: $(iptables -S BLOCKD-EGRESS)"
  pass "$runtime: an allowlist narrows a command's egress, and its rules go with it"

  # A head's server: the host reaches it at the head's address; another command can't.
  head="session-$runtime"
  "$blockd" fork --store "$store" --from base --to "$head" >/dev/null
  mounted=$(req /v1/heads "{\"store\":\"$store\",\"mode\":\"loop\",$(iso),\"head\":\"$head\",\"dir\":\"$work/head-$runtime\",\"flushEvery\":0}") || fail "$runtime: mount: $mounted"
  at=$(field "$mounted" address); [ -n "$at" ] || fail "$runtime: the head's reply has no address: $mounted"
  sid=$(field "$(req "/v1/heads/$head/spawn" '{"command":"mkdir -p /tmp/w && echo from-the-head > /tmp/w/index.html && exec httpd -f -p 3000 -h /tmp/w"}')" id)
  for _ in $(seq 1 40); do wget -q -T 1 -O- "http://$at:3000/" 2>/dev/null | grep -q from-the-head && break; sleep 0.25; done
  [ "$(wget -q -T 2 -O- "http://$at:3000/")" = from-the-head ] || fail "$runtime: the host can't reach the head's server at $at"
  result=$(call "{$common,$(iso),\"dir\":\"$work/d-$runtime\",\"command\":\"$(fetch "$at:3000")\"}")
  [ "$(stdout "$result")" = unreachable ] || fail "$runtime: one command reached another's server"
  req "/v1/spawns/$sid/kill" '{}' >/dev/null || true
  req "/v1/heads/$head/detach" '{}' >/dev/null || fail "$runtime: detach"
  ip netns list | grep -q "^bd-" && fail "$runtime: a namespace outlived its container: $(ip netns list)"
  pass "$runtime: the host reaches a head's server at its address; other commands can't, and the namespace goes with it"
done
kill "$(cat "$work/daemon.pid")"
echo "ALL PASSED"
