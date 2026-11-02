import * as Binding from "alchemy/Binding";
import type { Input } from "alchemy/Input";
import * as Output from "alchemy/Output";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import type { Share } from "./Share.ts";
import type { ShareExportPolicy } from "./ShareExportPolicy.ts";

/** NFS versions STACKIT File Storage serves. */
export type NfsVersion = "3" | "4.1" | "4.2";

export interface MountShareOptions {
  /**
   * The export policy the share uses: the same one as its `exportPolicyName`. The clients
   * in `cidrs` are added to its rules, and leave them again when this call goes away.
   */
  policy: ShareExportPolicy;
  /**
   * CIDR ranges of the machines mounting the share, such as `network.ipv4Prefixes`. The
   * pool's `ipAcl` has to cover them too: a policy only narrows it.
   */
  cidrs: Input<string[]>;
  /** Absolute directory to mount the share on, such as `/mnt/assets`. */
  mountPoint: string;
  /**
   * NFS version to mount with.
   * @default "4.1"
   */
  nfsVersion?: NfsVersion;
  /**
   * Only allow these clients read-only access, and mount it that way.
   * @default false
   */
  readOnly?: boolean;
  /**
   * Whether these clients have root access on the share.
   * @default true
   */
  superUser?: boolean;
}

/** How a machine mounts a share. */
export interface ShareMount {
  /**
   * A `#cloud-config` document for the `userData` of a `Stackit.IaaS.Server` on a
   * Debian-based image. It installs the NFS client, adds the share to `/etc/fstab`, sets
   * the NFSv4 ID domain STACKIT documents, mounts the share, and writes a line to the
   * server's console when it is mounted.
   */
  userData: Output.Output<string>;
  /** The `/etc/fstab` line, for an image or a `userData` you write yourself. */
  fstabEntry: Output.Output<string>;
}

/**
 * {@link MountShare} ran on a host that can't mount NFS: a `Stackit.Functions.Function`,
 * a Cloudflare Worker or anything else that runs code without a machine of its own.
 */
export class MountShareUnsupportedHost extends Data.TaggedError(
  "Stackit.FileStorage.MountShareUnsupportedHost",
)<{
  readonly host: string;
  readonly hostType: string;
  readonly message: string;
}> {}

const DEFAULT_NFS_VERSION: NfsVersion = "4.1";

/** What the fstab line and `mount` get. `nofail`: a share that's away must not stop a boot. */
const mountOptions = (nfsVersion: NfsVersion, readOnly: boolean) =>
  [`nfsvers=${nfsVersion}`, "_netdev", "nofail", ...(readOnly ? ["ro"] : [])].join(",");

/** A YAML double-quoted scalar: JSON strings are valid YAML. */
const yamlString = (value: string) => JSON.stringify(value);

const renderUserData = (mountPath: string, mountPoint: string, options: string) =>
  [
    "#cloud-config",
    "package_update: true",
    "packages:",
    "  - nfs-common",
    "mounts:",
    `  - [${yamlString(mountPath)}, ${yamlString(mountPoint)}, "nfs", ${yamlString(options)}, "0", "0"]`,
    "runcmd:",
    // STACKIT's docs ask for this ID domain, or files show up with the wrong owner.
    '  - ["sed", "-i", "s/^#\\\\?\\\\s*Domain\\\\s*=.*/Domain = stackit.cloud/", "/etc/idmapd.conf"]',
    '  - ["nfsidmap", "-c"]',
    `  - ["mkdir", "-p", ${yamlString(mountPoint)}]`,
    `  - ["mount", ${yamlString(mountPoint)}]`,
    `  - ["sh", "-c", ${yamlString(
      `mountpoint -q '${mountPoint.replaceAll("'", "'\\''")}' && echo 'alchemy: share mounted' > /dev/console`,
    )}]`,
    "",
  ].join("\n");

/**
 * Mount a {@link Share} on a machine you boot: add its CIDR ranges to the share's export
 * policy, and get the `userData` that mounts it on a `Stackit.IaaS.Server`. Unlike the
 * other File Storage bindings there is nothing to call at runtime: NFS is a mount, and the
 * machine's own files are the client.
 *
 * Call it in the stack, not inside a Function or Worker. A host that runs code without a
 * machine of its own can't mount NFS, so it fails with
 * `Stackit.FileStorage.MountShareUnsupportedHost` when it binds, rather than deploying
 * something that can never work. Mounting on SKE takes STACKIT's NFS CSI setup instead.
 *
 * The pool's `ipAcl` has to cover the same ranges, because a policy only narrows it. The
 * share's mount path is a private address, so the server needs a network that can reach
 * the pool.
 *
 * A server's `userData` replaces it when it changes, so a new `mountPoint`, `nfsVersion`
 * or `readOnly`, or a replaced share, replaces the server. The share's data stays where it
 * is unless the share itself is replaced. What the server keeps on its own disk doesn't.
 *
 * Access: none at runtime. At deploy, updating the policy takes the deployer's
 * `file-storage.share-export-policy.update`.
 *
 * ### Mounting on a Server
 * **Example:** A read-write share on a server
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 *
 * const network = yield* Stackit.IaaS.Network("Network", {
 *   ipv4: { prefix: "10.0.0.0/24" },
 * });
 * const pool = yield* Stackit.FileStorage.ResourcePool("Files", {
 *   availabilityZone: "eu01-1",
 *   performanceClass: "Standard",
 *   sizeGigabytes: 500,
 *   ipAcl: ["10.0.0.0/24"],
 * });
 * const policy = yield* Stackit.FileStorage.ShareExportPolicy("Clients", {});
 * const share = yield* Stackit.FileStorage.Share("Assets", {
 *   resourcePoolId: pool.resourcePoolId,
 *   spaceHardLimitGigabytes: 100,
 *   exportPolicyName: policy.name,
 * });
 * const mount = yield* Stackit.FileStorage.MountShare(share, {
 *   policy,
 *   cidrs: network.ipv4Prefixes,
 *   mountPoint: "/mnt/assets",
 * });
 * const server = yield* Stackit.IaaS.Server("App", {
 *   machineType: "g1.1",
 *   bootVolume: {
 *     size: 20,
 *     source: { type: "image", id: "1d2a2c8e-3b4f-4a6d-9c7e-5f8b0a1d2e3f" },
 *   },
 *   networking: { networkId: network.networkId },
 *   userData: mount.userData,
 * });
 * ```
 *
 * **Example:** Read-only, with your own `userData`
 * ```typescript
 * import * as Stackit from "@alchemy.run/stackit";
 * import * as Output from "alchemy/Output";
 *
 * const network = yield* Stackit.IaaS.Network("Network", {
 *   ipv4: { prefix: "10.0.0.0/24" },
 * });
 * const pool = yield* Stackit.FileStorage.ResourcePool("Files", {
 *   availabilityZone: "eu01-1",
 *   performanceClass: "Standard",
 *   sizeGigabytes: 500,
 *   ipAcl: ["10.0.0.0/24"],
 * });
 * const policy = yield* Stackit.FileStorage.ShareExportPolicy("Clients", {});
 * const share = yield* Stackit.FileStorage.Share("Assets", {
 *   resourcePoolId: pool.resourcePoolId,
 *   spaceHardLimitGigabytes: 100,
 *   exportPolicyName: policy.name,
 * });
 * const mount = yield* Stackit.FileStorage.MountShare(share, {
 *   policy,
 *   cidrs: network.ipv4Prefixes,
 *   mountPoint: "/mnt/assets",
 *   readOnly: true,
 *   superUser: false,
 * });
 * const server = yield* Stackit.IaaS.Server("App", {
 *   machineType: "g1.1",
 *   bootVolume: {
 *     size: 20,
 *     source: { type: "image", id: "1d2a2c8e-3b4f-4a6d-9c7e-5f8b0a1d2e3f" },
 *   },
 *   networking: { networkId: network.networkId },
 *   userData: Output.interpolate`#!/bin/sh
 * apt-get update && apt-get install -y nfs-common
 * mkdir -p /mnt/assets
 * echo '${mount.fstabEntry}' >> /etc/fstab
 * mount /mnt/assets
 * `,
 * });
 * ```
 *
 * @binding
 * @category FileStorage
 */
export const MountShare: (
  share: Share,
  options: MountShareOptions,
) => Effect.Effect<ShareMount, MountShareUnsupportedHost> = Effect.fn(
  "Stackit.FileStorage.MountShare",
)(function* (share: Share, options: MountShareOptions) {
  const host = yield* Binding.Host;
  if (host !== undefined) {
    return yield* new MountShareUnsupportedHost({
      host: host.LogicalId,
      hostType: host.Type,
      message: `${host.LogicalId} (${host.Type}) can't mount the NFS share ${share.LogicalId}. Mount it on a Stackit.IaaS.Server from the stack instead, or reach the data another way.`,
    });
  }
  const { policy, cidrs, mountPoint } = options;
  const readOnly = options.readOnly ?? false;
  const nfsOptions = mountOptions(options.nfsVersion ?? DEFAULT_NFS_VERSION, readOnly);

  yield* policy.bind`Stackit.FileStorage.MountShare(${share}, ${mountPoint}, ${cidrs})`({
    clients: [
      {
        ipAcl: cidrs,
        readOnly,
        ...(options.superUser !== undefined ? { superUser: options.superUser } : {}),
        description: `Mount of ${share.LogicalId} on ${mountPoint}`.slice(0, 255),
      },
    ],
  });

  const withPath = (render: (path: string) => string): Output.Output<string> =>
    Output.mapEffect((path: string | undefined) =>
      Effect.gen(function* () {
        if (path === undefined) {
          // A created share always has one; without it, no server could mount anything.
          return yield* Effect.die(`Share ${share.LogicalId} has no mount path`);
        }
        return render(path);
      }),
    )(share.mountPath);

  return {
    userData: withPath((path) => renderUserData(path, mountPoint, nfsOptions)),
    fstabEntry: withPath((path) => `${path} ${mountPoint} nfs ${nfsOptions} 0 0`),
  };
});
