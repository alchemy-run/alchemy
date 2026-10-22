#!/usr/bin/env bash
# Measures blockd's daemon on a real EC2 host (tests/ec2/bench.sh): Ubuntu
# 24.04 on Graviton with instance NVMe for the cache, and a scratch S3 bucket
# in the same region for the store. Launches everything, measures, and tears
# it all down (instance, security group, key, bucket).
# Needs AWS credentials; AWS_REGION defaults to us-west-2, INSTANCE_TYPE to
# c6gd.medium (spot).
# Usage: crates/blockd/tests/ec2/daemon.sh [ext4 btrfs]
set -euo pipefail
repo="$(cd "$(dirname "$0")/../../../.." && pwd)"
region="${AWS_REGION:-us-west-2}"
# The cheapest Graviton with instance NVMe; t4g.small for an EBS-only cache.
type="${INSTANCE_TYPE:-c6gd.medium}"
name="blockd-bench-$(date +%s)"
filesystems=("$@")
[ ${#filesystems[@]} -eq 0 ] && filesystems=(ext4 btrfs)
work="$(mktemp -d)"
aws() { command aws --region "$region" "$@"; }

image="$("$repo/crates/blockd/tests/image.sh")"
docker run --rm -v "$repo":/work -w /work \
  -v blockd-cargo-registry:/usr/local/cargo/registry \
  -v blockd-target:/target -e CARGO_TARGET_DIR=/target \
  "$image" bash -c 'cargo build --release -p blockd && cp /target/release/blockd /work/target/blockd-linux-arm64'

instance="" sg="" bucket=""
cleanup() {
  [ -n "$instance" ] && aws ec2 terminate-instances --instance-ids "$instance" >/dev/null && \
    aws ec2 wait instance-terminated --instance-ids "$instance" || true
  [ -n "$sg" ] && aws ec2 delete-security-group --group-id "$sg" >/dev/null || true
  aws ec2 delete-key-pair --key-name "$name" >/dev/null || true
  [ -n "$bucket" ] && aws s3 rb "s3://$bucket" --force >/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

bucket="$name"
aws s3 mb "s3://$bucket" >/dev/null
aws ec2 create-key-pair --key-name "$name" --query KeyMaterial --output text > "$work/key.pem"
chmod 600 "$work/key.pem"
vpc=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
sg=$(aws ec2 create-security-group --group-name "$name" --description "blockd test" --vpc-id "$vpc" --query GroupId --output text)
ip=$(curl -s https://checkip.amazonaws.com)
aws ec2 authorize-security-group-ingress --group-id "$sg" --protocol tcp --port 22 --cidr "$ip/32" >/dev/null
ami=$(aws ssm get-parameter --name /aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id --query Parameter.Value --output text)
# A spot instance that terminates itself after 40 minutes whatever happens
# here: a run that dies before its cleanup can't leave it billing.
instance=$(aws ec2 run-instances --image-id "$ami" --instance-type "$type" --key-name "$name" \
  --security-group-ids "$sg" \
  --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=12,VolumeType=gp3,DeleteOnTermination=true}' \
  --instance-market-options 'MarketType=spot,SpotOptions={SpotInstanceType=one-time,InstanceInterruptionBehavior=terminate}' \
  --instance-initiated-shutdown-behavior terminate \
  --user-data "$(printf '#!/bin/sh\nshutdown -h +40\n')" \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$name}]" \
  --query 'Instances[0].InstanceId' --output text)
echo "instance $instance"
aws ec2 wait instance-running --instance-ids "$instance"
host=$(aws ec2 describe-instances --instance-ids "$instance" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
ssh_() { ssh -i "$work/key.pem" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "ubuntu@$host" "$@"; }
for _ in $(seq 1 60); do ssh_ true 2>/dev/null && break; sleep 5; done

scp -i "$work/key.pem" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
  "$repo/target/blockd-linux-arm64" "$repo/crates/blockd/tests/ec2/bench.sh" "ubuntu@$host:"
ssh_ 'sudo apt-get update -qq && sudo apt-get install -y -qq e2fsprogs btrfs-progs fuse3 >/dev/null
  sudo modprobe ublk_drv || (sudo apt-get install -y -qq "linux-modules-extra-$(uname -r)" >/dev/null && sudo modprobe ublk_drv)
  sudo modprobe nbd nbds_max=16'
# Short-lived credentials for the bucket, for this run only.
creds=$(command aws configure export-credentials --format env-no-export | tr '\n' ' ')
ssh_ "sudo env $creds AWS_REGION=$region timeout 1800 bash bench.sh ./blockd-linux-arm64 $bucket ${filesystems[*]}"
