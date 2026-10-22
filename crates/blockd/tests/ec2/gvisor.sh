#!/usr/bin/env bash
# Runs as root on an EC2 instance: what gVisor (runsc, Systrap) costs coding
# workloads on a head blockd mounts, against the same work on the bare host.
# $1 is the blockd binary; $2 the S3 bucket; $3.. the filesystems. Prints one
# JSON line per workload.
set -euo pipefail
blockd="$(realpath "$1")"; bucket="$2"; shift 2
store="s3://$bucket/volumes"
nvme=$(lsblk -dpno NAME,MODEL | grep -i "instance storage" | head -1 | cut -d' ' -f1 || true)
if [ -n "$nvme" ] && ! mountpoint -q /data; then
  mkfs.ext4 -q -F "$nvme" && mkdir -p /data && mount "$nvme" /data
fi
mkdir -p /data && rm -rf /data/* && mkdir -p /data/work
export BLOCKD_DAEMON_TOKEN=bench RUST_BACKTRACE=1
trap 'echo "--- daemon log"; tail -40 /data/daemon.log' ERR
address=127.0.0.1:7681
req() { "$blockd" request --daemon "$address" --path "$1" ${2:+--body "$2"}; }
now() { date +%s%N; }
ms() { echo $(( ($(now) - $1) / 1000000 )); }

curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \
  > /etc/apt/sources.list.d/gvisor.list
apt-get update -qq && apt-get install -y -qq runsc > /dev/null
# A container the way the service runs one: the image as a read-only root (the
# host's own here), the session's mounted volume bind-mounted at /work, written
# through to the host, no network.
mkdir -p /data/runsc-logs
sandboxed() { # dir script
  local bundle id="w$RANDOM$RANDOM"
  bundle=$(mktemp -d /data/bundle-XXXX)
  (cd "$bundle" && runsc spec >/dev/null)
  python3 - "$bundle/config.json" "$1" "$2" <<'PY'
import json, sys
path, work, script = sys.argv[1:]
config = json.load(open(path))
config["root"] = {"path": "/", "readonly": True}
config["process"]["args"] = ["/bin/sh", "-c", script]
config["process"]["cwd"] = "/work"
config["process"]["terminal"] = False
config["process"]["env"] = ["PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin", "HOME=/work"]
config["mounts"] += [
    {"destination": "/work", "type": "bind", "source": work, "options": ["rbind", "rw"]},
    {"destination": "/data/work/tree", "type": "bind", "source": work + "/../tree", "options": ["rbind", "ro"]},
    {"destination": "/data/work/files.py", "type": "bind", "source": "/data/work/files.py", "options": ["bind", "ro"]},
    {"destination": "/tmp", "type": "tmpfs", "source": "tmpfs", "options": ["nosuid", "nodev"]},
]
config["linux"].pop("namespaces", None)
config["linux"]["namespaces"] = [{"type": t} for t in ["pid", "ipc", "uts", "mount", "network"]]
json.dump(config, open(path, "w"))
PY
  local status=0
  # GVISOR_FLAGS: more runsc flags, e.g. --file-access-mounts=exclusive.
  runsc --network=none --overlay2=none --ignore-cgroups --debug-log=/data/runsc-logs/ ${GVISOR_FLAGS:-} \
    run --bundle "$bundle" "$id" || status=$?
  runsc delete --force "$id" >/dev/null 2>&1 || true
  rm -rf "$bundle"
  return $status
}
echo "{\"flags\":\"${GVISOR_FLAGS:-}\",\"runsc\":\"$(runsc --version | head -1)\",\"kernel\":\"$(uname -r)\",\"cpus\":$(nproc)}"

"$blockd" daemon --listen "$address" --pidfile /data/daemon.pid --state /data/state --run /data/run \
  > /data/daemon.log 2>&1 &
for _ in $(seq 1 100); do [ -f /data/daemon.pid ] && break; sleep 0.05; done
mode=$(modprobe ublk_drv 2>/dev/null && echo ublk || echo nbd)

base_image() { # fs image: a repository's worth of small files
  local root=/data/work/rootfs
  rm -rf "$root" && mkdir -p "$root/src"
  for d in $(seq 1 100); do
    mkdir -p "$root/node_modules/pkg$d"
    for f in $(seq 1 100); do echo "module.exports = $d * $f;" > "$root/node_modules/pkg$d/f$f.js"; done
  done
  for f in $(seq 1 200); do echo "export const v$f = $f;" > "$root/src/m$f.ts"; done
  case "$1" in
    ext4) mkfs.ext4 -q -F -b 4096 -d "$root" "$2" 1G ;;
    btrfs)
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

cat > /data/work/files.py <<'EOF'
import os, sys
n, sync = int(sys.argv[1]), sys.argv[2] == "fsync"
os.makedirs("gen", exist_ok=True)
for i in range(n):
    with open(f"gen/f{i}.txt", "w") as f:
        f.write("x" * 200)
        if sync:
            f.flush(); os.fsync(f.fileno())
EOF

# name script: run in $dir/<where>, on the host and in gVisor, each on its own copy.
workloads=(
  "start a sandbox|true"
  "copy 10,000 files|cp -a /data/work/tree/src /data/work/tree/node_modules ."
  "git add and commit 10,000 files|git init -q && git add -A && git -c user.email=a@b -c user.name=a commit -qm init"
  "git status|git status --porcelain | wc -l"
  "grep -r|grep -rc 'module.exports' node_modules | wc -l"
  "find and read every file|find . -path ./.git -prune -o -type f -print0 | xargs -0 cat > /dev/null"
  "tar and gzip the tree|tar czf /tmp/tree.tgz --exclude=.git . && rm /tmp/tree.tgz"
  "write 5,000 small files|python3 /data/work/files.py 5000 nosync"
  "200 writes with fsync|python3 /data/work/files.py 200 fsync"
  "delete them|rm -rf gen"
  "sh -c 100 times|for i in \$(seq 1 100); do sh -c true; done"
)

for fs in "$@"; do
  img=/data/work/base-$fs.img
  base_image "$fs" "$img"
  "$blockd" import --store "$store" --head "base-$fs" --image "$img" >/dev/null
  "$blockd" fork --store "$store" --from "base-$fs" --to "session-$fs" >/dev/null
  dir=/data/work/head-$fs
  req /v1/heads "{\"store\":\"$store\",\"mode\":\"$mode\",\"head\":\"session-$fs\",\"dir\":\"$dir\",\"flushEvery\":5}" >/dev/null
  # The base's files, read once so neither side pays for the cold cache.
  mkdir -p "$dir/tree" && mv "$dir/src" "$dir/node_modules" "$dir/tree/"
  ln -sfn "$dir/tree" /data/work/tree
  find "$dir/tree" -type f -exec cat {} + > /dev/null
  mkdir -p "$dir/host" "$dir/gvisor"
  for workload in "${workloads[@]}"; do
    name="${workload%%|*}"; script="${workload#*|}"
    # A workload that fails says so and the rest still run.
    t=$(now)
    if out=$( (cd "$dir/host" && sh -c "$script") 2>&1 >/dev/null); then host_ms=$(ms "$t")
    else host_ms=null; echo "FAIL host: $name: $(echo "$out" | tail -5)"; fi
    t=$(now)
    if out=$(sandboxed "$dir/gvisor" "$script" 2>&1 >/dev/null); then gvisor_ms=$(ms "$t")
    else gvisor_ms=null; echo "FAIL gvisor: $name: $(echo "$out" | tail -5)"
      grep -h -iE "error|warn|fail" /data/runsc-logs/* 2>/dev/null | tail -8; fi
    landed=$(find "$dir/gvisor" -type f | wc -l); expected=$(find "$dir/host" -type f | wc -l)
    echo "{\"fs\":\"$fs\",\"workload\":\"$name\",\"host_ms\":$host_ms,\"gvisor_ms\":$gvisor_ms,\"files_host\":$expected,\"files_gvisor_on_volume\":$landed}"
  done
  # What gVisor wrote is on the volume, as the host sees it.
  [ -f "$dir/gvisor/.git/HEAD" ] && [ -d "$dir/gvisor/node_modules/pkg100" ] \
    && echo "{\"fs\":\"$fs\",\"check\":\"gVisor's writes are on the mounted volume\"}" \
    || echo "FAIL: gVisor's writes didn't reach the volume"
  req "/v1/heads/session-$fs/detach" '{}' >/dev/null
done
kill "$(cat /data/daemon.pid)"
