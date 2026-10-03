import * as fileshares from "@distilled.cloud/azure/fileshares";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createFileShareName } from "./FileShareNames.ts";

export type FileShareRedundancy = "Local" | "Zone";
export type FileShareRootSquash = "NoRootSquash" | "RootSquash" | "AllSquash";

export interface FileShareNfsProperties {
  /**
   * How root users on NFS clients are mapped on the share.
   * @default Azure's default (`NoRootSquash`)
   */
  rootSquash?: FileShareRootSquash;
  /**
   * Whether NFS clients must encrypt data in transit.
   * @default Azure's default
   */
  encryptionInTransitRequired?: "Enabled" | "Disabled";
}

export interface FileShareProps {
  /** Resource group the share is created in. Changing it replaces the share. */
  resourceGroup: string;
  /**
   * File share resource name: 3-63 lowercase letters, digits, and hyphens,
   * starting and ending with a letter or digit. If omitted, a unique name is
   * generated from the app, stage, and logical ID. Changing it replaces the
   * share.
   */
  name?: string;
  /**
   * Azure location of the share. Changing it replaces the share.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Name clients use when mounting the share. Changing it replaces the share.
   * @default the resource name
   */
  mountName?: string;
  /**
   * Redundancy of the share. Changing it replaces the share.
   * @default "Local"
   */
  redundancy?: FileShareRedundancy;
  /**
   * Provisioned storage size in GiB (32-262144). Billed regardless of the
   * used storage. Decreases are only allowed after
   * `provisionedStorageNextAllowedDowngrade` (about 24 hours after the
   * last increase); earlier decreases fail with an Azure error.
   * @default 32
   */
  provisionedStorageGiB?: number;
  /**
   * Provisioned IOPS. Subject to the same downgrade cooldown as storage.
   * @default Azure's recommendation for the provisioned storage
   */
  provisionedIOPerSec?: number;
  /**
   * Provisioned throughput in MiB/s. Subject to the same downgrade cooldown
   * as storage.
   * @default Azure's recommendation for the provisioned storage
   */
  provisionedThroughputMiBPerSec?: number;
  /** NFS protocol settings. */
  nfs?: FileShareNfsProperties;
  /**
   * Whether the public endpoint accepts traffic.
   * @default Azure's default (`Enabled`)
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * Subnet resource IDs allowed to reach the public endpoint when access is
   * restricted. The subnets need the `Microsoft.Storage` service endpoint.
   */
  allowedSubnets?: string[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface FileShare extends Resource<
  "Azure.FileShares.FileShare",
  FileShareProps,
  {
    /** Resource name of the share. */
    fileShareName: string;
    /** ARM resource ID of the share. */
    fileShareId: string;
    /** Resource group that holds the share. */
    resourceGroup: string;
    /** Location of the share. */
    location: string;
    /** Name clients use when mounting the share. */
    mountName: string;
    /** NFS endpoint host name, e.g. `{id}.file.core.windows.net`. */
    hostName: string | undefined;
    /** Media tier (`SSD`). */
    mediaTier: string;
    /** Redundancy (`Local` or `Zone`). */
    redundancy: string;
    /** File sharing protocol (`NFS`). */
    protocol: string;
    /** Provisioned storage in GiB. */
    provisionedStorageGiB: number | undefined;
    /** Provisioned IOPS. */
    provisionedIOPerSec: number | undefined;
    /** Provisioned throughput in MiB/s. */
    provisionedThroughputMiBPerSec: number | undefined;
    /** Burst IOPS included with the provisioned IOPS. */
    includedBurstIOPerSec: number | undefined;
    /** Maximum burst IOPS credits at the current provisioning level. */
    maxBurstIOPerSecCredits: number | undefined;
    /** When provisioned storage may next be reduced. */
    provisionedStorageNextAllowedDowngrade: string | undefined;
    /** When provisioned IOPS may next be reduced. */
    provisionedIOPerSecNextAllowedDowngrade: string | undefined;
    /** When provisioned throughput may next be reduced. */
    provisionedThroughputNextAllowedDowngrade: string | undefined;
    /** Root squash setting of the NFS share. */
    rootSquash: string | undefined;
    /** Public network access state. */
    publicNetworkAccess: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Files share managed by the file-share-centric
 * `Microsoft.FileShares` resource provider: an NFS 4.1 share on SSD with
 * provisioned v2 billing and no parent storage account.
 *
 * Shares are billed for provisioned storage, IOPS, and throughput whether
 * or not they hold data. Mounting the share requires network access from a
 * VNet (allowed subnets or a private endpoint).
 *
 * @see https://learn.microsoft.com/azure/storage/files/
 *
 * ### Creating a File Share
 * **Example:** Minimal NFS share
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const share = yield* Azure.FileShares.FileShare("data", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Zone-redundant share with root squash
 * ```typescript
 * const share = yield* Azure.FileShares.FileShare("data", {
 *   resourceGroup: group.resourceGroupName,
 *   redundancy: "Zone",
 *   provisionedStorageGiB: 128,
 *   nfs: { rootSquash: "RootSquash" },
 * });
 * ```
 *
 * ### Network Access
 * **Example:** Restrict the share to a subnet
 * ```typescript
 * const share = yield* Azure.FileShares.FileShare("data", {
 *   resourceGroup: group.resourceGroupName,
 *   allowedSubnets: [subnet.subnetId],
 * });
 * ```
 *
 * **Example:** Disable the public endpoint
 * ```typescript
 * const share = yield* Azure.FileShares.FileShare("data", {
 *   resourceGroup: group.resourceGroupName,
 *   publicNetworkAccess: "Disabled",
 * });
 * ```
 *
 * @resource
 */
export const FileShare = Resource<FileShare>("Azure.FileShares.FileShare");

type ObservedShare = fileshares.GetFileShareResponse;

export const getFileShare = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
) =>
  orUndefinedIfNotFound(
    fileshares.GetFileShare({
      subscriptionId,
      resourceGroupName,
      resourceName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  share: ObservedShare | fileshares.FileShare,
): FileShare["Attributes"] => {
  const p = share.properties;
  return {
    fileShareName: name,
    fileShareId: share.id ?? "",
    resourceGroup,
    location: share.location,
    mountName: p?.mountName ?? name,
    hostName: p?.hostName,
    mediaTier: p?.mediaTier ?? "SSD",
    redundancy: p?.redundancy ?? "Local",
    protocol: p?.protocol ?? "NFS",
    provisionedStorageGiB: p?.provisionedStorageGiB,
    provisionedIOPerSec: p?.provisionedIOPerSec,
    provisionedThroughputMiBPerSec: p?.provisionedThroughputMiBPerSec,
    includedBurstIOPerSec: p?.includedBurstIOPerSec,
    maxBurstIOPerSecCredits: p?.maxBurstIOPerSecCredits,
    provisionedStorageNextAllowedDowngrade:
      p?.provisionedStorageNextAllowedDowngrade,
    provisionedIOPerSecNextAllowedDowngrade:
      p?.provisionedIOPerSecNextAllowedDowngrade,
    provisionedThroughputNextAllowedDowngrade:
      p?.provisionedThroughputNextAllowedDowngrade,
    rootSquash: p?.nfsProtocolProperties?.rootSquash,
    publicNetworkAccess: p?.publicNetworkAccess,
    tags: userTags(share.tags),
  };
};

const lower = (value: string | undefined) => value?.toLowerCase();

const sameSubnets = (
  observed: ReadonlyArray<string> | undefined,
  desired: ReadonlyArray<string>,
) =>
  JSON.stringify([...(observed ?? [])].map((s) => s.toLowerCase()).sort()) ===
  JSON.stringify([...desired].map((s) => s.toLowerCase()).sort());

export const FileShareProvider = () =>
  Provider.succeed(FileShare, {
    stables: [
      "fileShareName",
      "fileShareId",
      "resourceGroup",
      "location",
      "mountName",
      "hostName",
      "mediaTier",
      "redundancy",
      "protocol",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* orUndefinedIfNotFound(
        fileshares
          .ListFileShareBySubscription({ subscriptionId })
          .pipe(
            Effect.flatMap((page) =>
              requireSinglePage("ListFileShareBySubscription", page),
            ),
          ),
      );
      return (page?.value ?? []).flatMap((share) => {
        const group = resourceGroupOf(share.id);
        return hasAnyAlchemyTag(share.tags) &&
          group !== undefined &&
          share.name !== undefined
          ? [toAttrs(group, share.name, share)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.fileShareName) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location)) ||
        (news.mountName ?? news.name ?? output.fileShareName) !==
          output.mountName ||
        (news.redundancy ?? "Local") !== output.redundancy
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.fileShareName ?? olds?.name ?? (yield* createFileShareName(id));
      const observed = yield* getFileShare(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.FileShares");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.fileShareName ?? (yield* createFileShareName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const storageGiB = news.provisionedStorageGiB ?? 32;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        resourceName: name,
      };
      const label = `file share ${name}`;
      const get = getFileShare(subscriptionId, resourceGroup, name);
      const budget = { interval: "3 seconds", times: 100 } as const;

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        yield* fileshares.FileSharesCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: {
            mountName: news.mountName ?? name,
            mediaTier: "SSD",
            redundancy: news.redundancy ?? "Local",
            protocol: "NFS",
            provisionedStorageGiB: storageGiB,
            provisionedIOPerSec: news.provisionedIOPerSec,
            provisionedThroughputMiBPerSec: news.provisionedThroughputMiBPerSec,
            nfsProtocolProperties: news.nfs,
            publicNetworkAccess: news.publicNetworkAccess,
            publicAccessProperties:
              news.allowedSubnets === undefined
                ? undefined
                : { allowedSubnets: news.allowedSubnets },
          },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (share) => share.properties?.provisioningState,
        budget,
      );

      // Sync each mutable aspect against observed state; PATCH only deltas.
      const p = observed.properties ?? {};
      const changed: fileshares.FileShareUpdateProperties = {};
      if (p.provisionedStorageGiB !== storageGiB) {
        changed.provisionedStorageGiB = storageGiB;
      }
      if (
        news.provisionedIOPerSec !== undefined &&
        p.provisionedIOPerSec !== news.provisionedIOPerSec
      ) {
        changed.provisionedIOPerSec = news.provisionedIOPerSec;
      }
      if (
        news.provisionedThroughputMiBPerSec !== undefined &&
        p.provisionedThroughputMiBPerSec !== news.provisionedThroughputMiBPerSec
      ) {
        changed.provisionedThroughputMiBPerSec =
          news.provisionedThroughputMiBPerSec;
      }
      const observedNfs = p.nfsProtocolProperties ?? {};
      if (
        (news.nfs?.rootSquash !== undefined &&
          observedNfs.rootSquash !== news.nfs.rootSquash) ||
        (news.nfs?.encryptionInTransitRequired !== undefined &&
          observedNfs.encryptionInTransitRequired !==
            news.nfs.encryptionInTransitRequired)
      ) {
        changed.nfsProtocolProperties = { ...observedNfs, ...news.nfs };
      }
      if (
        news.publicNetworkAccess !== undefined &&
        p.publicNetworkAccess !== news.publicNetworkAccess
      ) {
        changed.publicNetworkAccess = news.publicNetworkAccess;
      }
      if (
        news.allowedSubnets !== undefined &&
        !sameSubnets(
          p.publicAccessProperties?.allowedSubnets,
          news.allowedSubnets,
        )
      ) {
        changed.publicAccessProperties = {
          allowedSubnets: news.allowedSubnets,
        };
      }
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (Object.keys(changed).length > 0 || tagsChanged) {
        yield* fileshares.UpdateFileShare({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: Object.keys(changed).length > 0 ? changed : undefined,
        });
        // The PATCH is a long-running operation that still reports the old
        // values (and `Succeeded`) right after it returns; wait until the
        // observed share reflects the delta.
        const applied = (share: ObservedShare) => {
          const q = share.properties ?? {};
          return (
            (changed.provisionedStorageGiB === undefined ||
              q.provisionedStorageGiB === changed.provisionedStorageGiB) &&
            (changed.provisionedIOPerSec === undefined ||
              q.provisionedIOPerSec === changed.provisionedIOPerSec) &&
            (changed.provisionedThroughputMiBPerSec === undefined ||
              q.provisionedThroughputMiBPerSec ===
                changed.provisionedThroughputMiBPerSec) &&
            (changed.nfsProtocolProperties?.rootSquash === undefined ||
              q.nfsProtocolProperties?.rootSquash ===
                changed.nfsProtocolProperties.rootSquash) &&
            (changed.nfsProtocolProperties?.encryptionInTransitRequired ===
              undefined ||
              q.nfsProtocolProperties?.encryptionInTransitRequired ===
                changed.nfsProtocolProperties.encryptionInTransitRequired) &&
            (changed.publicNetworkAccess === undefined ||
              q.publicNetworkAccess === changed.publicNetworkAccess) &&
            (changed.publicAccessProperties?.allowedSubnets === undefined ||
              sameSubnets(
                q.publicAccessProperties?.allowedSubnets,
                changed.publicAccessProperties.allowedSubnets,
              )) &&
            (!tagsChanged || !tagsDiffer(share.tags, tags))
          );
        };
        observed = yield* waitForProvisioned(
          label,
          get.pipe(
            Effect.map((share) =>
              share !== undefined && applied(share) ? share : undefined,
            ),
          ),
          (share) => share.properties?.provisioningState,
          budget,
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        fileshares.DeleteFileShare({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          resourceName: output.fileShareName,
        }),
      );
      yield* waitUntilGone(
        `file share ${output.fileShareName}`,
        getFileShare(
          subscriptionId,
          output.resourceGroup,
          output.fileShareName,
        ),
        { interval: "3 seconds", times: 100 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
