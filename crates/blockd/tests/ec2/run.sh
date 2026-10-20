#!/usr/bin/env bash
# Runs the kernel-attach test (tests/nbd/test.sh) on a real EC2 VM, with ublk
# and with NBD: Ubuntu 24.04 on Graviton, where ublk_drv exists. Launches the
# instance, runs, and tears everything down (instance, security group, key).
# Needs AWS credentials; AWS_REGION defaults to us-west-2.
set -euo pipefail
repo="$(cd "$(dirname "$0")/../../../.." && pwd)"
region="${AWS_REGION:-us-west-2}"
name="blockd-test-$(date +%s)"
work="$(mktemp -d)"
aws() { command aws --region "$region" "$@"; }

image="$("$repo/crates/blockd/tests/image.sh")"
docker run --rm -v "$repo":/work -w /work \
  -v blockd-cargo-registry:/usr/local/cargo/registry \
  -v blockd-target:/target -e CARGO_TARGET_DIR=/target \
  "$image" bash -c 'cargo build --release -p blockd && cp /target/release/blockd /work/target/blockd-linux-arm64'

instance="" sg=""
cleanup() {
  [ -n "$instance" ] && aws ec2 terminate-instances --instance-ids "$instance" >/dev/null && \
    aws ec2 wait instance-terminated --instance-ids "$instance" || true
  [ -n "$sg" ] && aws ec2 delete-security-group --group-id "$sg" >/dev/null || true
  aws ec2 delete-key-pair --key-name "$name" >/dev/null || true
  rm -rf "$work"
}
trap cleanup EXIT

aws ec2 create-key-pair --key-name "$name" --query KeyMaterial --output text > "$work/key.pem"
chmod 600 "$work/key.pem"
vpc=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
sg=$(aws ec2 create-security-group --group-name "$name" --description "blockd test" --vpc-id "$vpc" --query GroupId --output text)
ip=$(curl -s https://checkip.amazonaws.com)
aws ec2 authorize-security-group-ingress --group-id "$sg" --protocol tcp --port 22 --cidr "$ip/32" >/dev/null
ami=$(aws ssm get-parameter --name /aws/service/canonical/ubuntu/server/24.04/stable/current/arm64/hvm/ebs-gp3/ami-id --query Parameter.Value --output text)
instance=$(aws ec2 run-instances --image-id "$ami" --instance-type t4g.medium --key-name "$name" \
  --security-group-ids "$sg" --block-device-mappings 'DeviceName=/dev/sda1,Ebs={VolumeSize=20,VolumeType=gp3}' \
  --tag-specifications "ResourceType=instance,Tags=[{Key=Name,Value=$name}]" \
  --query 'Instances[0].InstanceId' --output text)
echo "instance $instance"
aws ec2 wait instance-running --instance-ids "$instance"
host=$(aws ec2 describe-instances --instance-ids "$instance" --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
ssh_() { ssh -i "$work/key.pem" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR "ubuntu@$host" "$@"; }
for _ in $(seq 1 60); do ssh_ true 2>/dev/null && break; sleep 5; done

scp -i "$work/key.pem" -o StrictHostKeyChecking=no -o UserKnownHostsFile=/dev/null -o LogLevel=ERROR \
  "$repo/target/blockd-linux-arm64" "$repo/crates/blockd/tests/nbd/test.sh" "ubuntu@$host:"
ssh_ 'sudo apt-get update -qq && sudo apt-get install -y -qq e2fsprogs >/dev/null
  sudo modprobe ublk_drv || (sudo apt-get install -y -qq "linux-modules-extra-$(uname -r)" >/dev/null && sudo modprobe ublk_drv)
  sudo modprobe nbd nbds_max=16
  echo "kernel $(uname -r); ublk: $(ls /dev/ublk-control)"'
echo "=== ublk"
ssh_ 'sudo timeout 900 env MODE=ublk bash test.sh ./blockd-linux-arm64'
echo "=== nbd"
ssh_ 'sudo timeout 900 env MODE=nbd bash test.sh ./blockd-linux-arm64'
