#!/usr/bin/env bash
# Runs as root on an EC2 instance: what a forked call and a landed patch
# cost through `blockd daemon`, with the cache on local NVMe and the store in
# S3 in the same region. $1 is the blockd binary; $2 the S3 bucket; $3.. the
# filesystems. Prints one JSON line per measurement.
set -euo pipefail
blockd="$(realpath "$1")"; bucket="$2"; shift 2
store="s3://$bucket/volumes"
nvme=$(lsblk -dpno NAME,MODEL | grep -i "instance storage" | head -1 | cut -d' ' -f1 || true)
work=/data
if [ -n "$nvme" ] && ! mountpoint -q /data; then
  mkfs.ext4 -q -F "$nvme" && mkdir -p /data && mount "$nvme" /data
fi
rm -rf /data/* && mkdir -p /data/work
cache_disk=$( [ -n "$nvme" ] && echo "instance NVMe $nvme" || echo "EBS" )
export BLOCKD_DAEMON_TOKEN=bench RUST_BACKTRACE=1
trap 'echo "--- daemon log"; tail -40 /data/daemon.log; dmesg | tail -15' ERR
address=127.0.0.1:7681
req() { "$blockd" request --daemon "$address" --path "$1" ${2:+--body "$2"}; }
field() { echo "$1" | grep -o "\"$2\":\"[^\"]*\"" | head -1 | sed -E 's/.*:"(.*)"/\1/'; }
now() { date +%s%N; }
ms() { echo $(( ($(now) - $1) / 1000000 )); }
call() { # body → the finished result
  local id result
  id=$(field "$(req /v1/calls "$1")" id)
  for _ in $(seq 1 120); do
    result=$(req "/v1/calls/$id?wait=5000")
    echo "$result" | grep -q '"done":true' && { echo "$result"; return 0; }
  done
  echo "call $id never finished" >&2; exit 1
}
timings() { echo "$1" | grep -o '"timings":{[^}]*}' | head -1 | sed 's/"timings"://'; }

"$blockd" daemon --listen "$address" --pidfile /data/daemon.pid --state /data/state --run /data/run \
  > /data/daemon.log 2>&1 &
for _ in $(seq 1 100); do [ -f /data/daemon.pid ] && break; sleep 0.05; done
mode=$(modprobe ublk_drv 2>/dev/null && echo ublk || echo nbd)
echo "{\"cache\":\"$cache_disk\",\"mode\":\"$mode\",\"kernel\":\"$(uname -r)\"}"

base_image() { # fs image: a repository's worth of small files and one big one
  local root=/data/work/rootfs
  rm -rf "$root" && mkdir -p "$root/src"
  for d in $(seq 1 100); do
    mkdir -p "$root/node_modules/pkg$d"
    for f in $(seq 1 100); do echo "module.exports = $d * $f;" > "$root/node_modules/pkg$d/f$f.js"; done
  done
  for f in $(seq 1 200); do echo "export const v$f = $f;" > "$root/src/m$f.ts"; done
  head -c 67108864 /dev/urandom > "$root/data.db"
  case "$1" in
    ext4) mkfs.ext4 -q -F -b 4096 -d "$root" "$2" 1G ;;
    btrfs)
      # Data in the default subvolume `data` (older btrfs-progs have no `mkfs --subvol`).
      local top=/data/work/top
      truncate -s 1G "$2"
      mkfs.btrfs -q -f -s 4096 "$2" >/dev/null
      mkdir -p "$top" && mount -o loop "$2" "$top"
      btrfs -q subvolume create "$top/data" && mkdir "$top/.alchemy"
      cp -a "$root/." "$top/data/"
      btrfs subvolume set-default "$top/data"
      umount "$top" ;;
  esac
}

for fs in "$@"; do
  img=/data/work/base-$fs.img
  base_image "$fs" "$img"
  t=$(now); "$blockd" import --store "$store" --head "base-$fs" --image "$img" >/dev/null
  echo "{\"fs\":\"$fs\",\"import_ms\":$(ms "$t")}"
  "$blockd" fork --store "$store" --from "base-$fs" --to "session-$fs" >/dev/null
  common="\"store\":\"$store\",\"mode\":\"$mode\""
  head="session-$fs"; dir=/data/work/head-$fs
  t=$(now); mounted=$(req /v1/heads "{$common,\"head\":\"$head\",\"dir\":\"$dir\",\"flushEvery\":0}")
  echo "{\"fs\":\"$fs\",\"step\":\"mount head (cold cache)\",\"ms\":$(ms "$t"),\"timings\":$(timings "$mounted")}"
  t=$(now); find "$dir" -type f -exec cat {} + > /dev/null
  echo "{\"fs\":\"$fs\",\"step\":\"read the whole tree once\",\"ms\":$(ms "$t")}"

  # One command at a time: snapshot the head, run on a fork, land the patch.
  for i in 1 2 3 4 5 6; do
    t=$(now); snap=$(field "$(req "/v1/heads/$head/snapshot" "{\"freeze\":\"$dir\"}")" snapshot)
    snapshot_ms=$(ms "$t")
    t=$(now)
    result=$(call "{$common,\"snapshot\":\"$snap\",\"dir\":\"/data/work/call-$fs\",\"patch\":\"patches/$fs-$i\",
      \"command\":\"echo $i > src/new$i.ts && cat src/m1.ts node_modules/pkg1/f1.js > /dev/null\"}")
    call_ms=$(ms "$t")
    t=$(now); applied=$(req "/v1/heads/$head/apply" "{\"patches\":[\"patches/$fs-$i\"]}")
    apply_ms=$(ms "$t")
    echo "{\"fs\":\"$fs\",\"step\":\"command $i\",\"snapshot_ms\":$snapshot_ms,\"call_ms\":$call_ms,\"apply_ms\":$apply_ms,\"call\":$(timings "$result"),\"apply\":$(timings "$applied")}"
  done

  # Four 2-second commands at once, landed together.
  t=$(now); snap=$(field "$(req "/v1/heads/$head/snapshot" "{\"freeze\":\"$dir\"}")" snapshot)
  pids=()
  for i in 1 2 3 4; do
    (call "{$common,\"snapshot\":\"$snap\",\"dir\":\"/data/work/fan-$fs-$i\",\"patch\":\"patches/$fs-fan-$i\",
      \"command\":\"sleep 2; echo $i > fan$i.txt\"}" > "/data/work/fan-$fs-$i.json") &
    pids+=($!)
  done
  wait "${pids[@]}"
  ran=$(ms "$t")
  applied=$(req "/v1/heads/$head/apply" "{\"patches\":[\"patches/$fs-fan-1\",\"patches/$fs-fan-2\",\"patches/$fs-fan-3\",\"patches/$fs-fan-4\"]}")
  landed=$(req "/v1/heads/$head/snapshot" "{\"freeze\":\"$dir\"}")
  echo "{\"fs\":\"$fs\",\"step\":\"4 x 2 s at once, landed and snapshotted\",\"ms\":$(ms "$t"),\"run_ms\":$ran,\"apply\":$(timings "$applied"),\"snapshot\":$(timings "$landed")}"
  for i in 1 2 3 4; do echo "{\"fs\":\"$fs\",\"step\":\"fan-out call $i\",\"call\":$(timings "$(cat "/data/work/fan-$fs-$i.json")")}"; done

  # fsync on the mounted head.
  t=$(now)
  for i in $(seq 1 20); do echo "$i" > "$dir/sync.txt"; sync "$dir/sync.txt"; done
  echo "{\"fs\":\"$fs\",\"step\":\"20 fsyncs on the head\",\"ms\":$(ms "$t")}"
  req "/v1/heads/$head/detach" '{}' >/dev/null
done
kill "$(cat /data/daemon.pid)"
