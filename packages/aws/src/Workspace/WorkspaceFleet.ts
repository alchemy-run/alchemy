/**
 * The hosts of an `AWS.Workspace`: a launch template running the workspace
 * service (`WorkspaceServer.ts`) on every instance, with what it needs
 * installed at boot.
 *
 * NOT exported from `index.ts`.
 */
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import { LaunchTemplate } from "../AutoScaling/LaunchTemplate.ts";
import * as AWSBindings from "../AWSBindings.ts";
import { HOST_CONFIG, HOST_TOKEN, serveWorkspace, type HostConfig } from "./WorkspaceServer.ts";

/**
 * What a host installs at boot: blockd's tools, the container runtimes,
 * the kernel's ublk and NBD modules, and instance NVMe (if it has any) as
 * the cache. blockd itself comes from the bucket when the service starts.
 */
export const hostUserData = `#!/bin/bash
export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y e2fsprogs btrfs-progs fuse3 runc gnupg curl "linux-modules-extra-$(uname -r)" \\
  || apt-get install -y e2fsprogs btrfs-progs fuse3 runc gnupg curl
curl -fsSL https://gvisor.dev/archive.key | gpg --dearmor -o /usr/share/keyrings/gvisor-archive-keyring.gpg
echo "deb [arch=$(dpkg --print-architecture) signed-by=/usr/share/keyrings/gvisor-archive-keyring.gpg] https://storage.googleapis.com/gvisor/releases release main" \\
  > /etc/apt/sources.list.d/gvisor.list
apt-get update -y && apt-get install -y runsc
modprobe ublk_drv || true
modprobe nbd nbds_max=64 || true
nvme=$(lsblk -dpno NAME,MODEL | grep -i "instance storage" | head -1 | cut -d' ' -f1)
if [ -n "$nvme" ] && ! mountpoint -q /var/cache/blockd; then
  mkfs.ext4 -q -F "$nvme" && mkdir -p /var/cache/blockd && mount "$nvme" /var/cache/blockd
fi
touch /run/alchemy-workspace-ready
`;

/**
 * The launch template, at deploy (with `deploy`, whose `config` resolves
 * then) and on a host (without: `config` is what deploy bound).
 */
export const hostTemplate = (
  config: HostConfig,
  deploy?: {
    readonly config: Output.Output<HostConfig>;
    readonly main: string;
    readonly token: unknown;
    readonly imageId: Input<string>;
    readonly instanceType: string;
    readonly securityGroupIds: ReadonlyArray<Input<string>>;
    readonly spot: boolean;
    /** The store's bucket ARN: the hosts read and write it. */
    readonly bucketArn: Input<string>;
  },
) =>
  LaunchTemplate<any>()(
    `${config.id}Host`,
    {
      main: deploy?.main ?? "",
      imageId: deploy?.imageId ?? "",
      instanceType: deploy?.instanceType ?? "",
      securityGroupIds: (deploy?.securityGroupIds ?? []) as never,
      associatePublicIpAddress: true,
      port: config.port,
      spot: deploy?.spot ?? false,
      userData: hostUserData,
      env: deploy
        ? {
            [HOST_CONFIG]: Output.map(deploy.config, (resolved) => JSON.stringify(resolved)),
            [HOST_TOKEN]: deploy.token,
          }
        : {},
    } as never,
    Effect.gen(function* () {
      const bind = yield* AWSBindings.Bind;
      if (!globalThis.__ALCHEMY_RUNTIME__ && deploy) {
        // blockd reads and writes the store as the instance's role.
        yield* bind`AWS.Workspace.Store(${config.id})`({
          policyStatements: [
            {
              Effect: "Allow",
              Action: [
                "s3:GetObject",
                "s3:PutObject",
                "s3:DeleteObject",
                "s3:AbortMultipartUpload",
              ],
              Resource: [Output.interpolate`${deploy.bucketArn}/*` as never],
            },
            {
              Effect: "Allow",
              Action: ["s3:ListBucket"],
              Resource: [deploy.bucketArn as never],
            },
          ],
        });
      }
      return yield* serveWorkspace(config);
    }),
  );
