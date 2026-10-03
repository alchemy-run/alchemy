import * as storagecache from "@distilled.cloud/azure/storagecache";
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
import {
  createLustreName,
  FILESYSTEM_BUDGET,
  sameList,
  sameLocation,
} from "./Common.ts";

/** Azure Managed Lustre SKU (throughput tier in MB/s per TiB). */
export type AmlFilesystemSku =
  | "AMLFS-Durable-Premium-40"
  | "AMLFS-Durable-Premium-125"
  | "AMLFS-Durable-Premium-250"
  | "AMLFS-Durable-Premium-500";

/** Day of the week of the weekly maintenance window. */
export type AmlFilesystemMaintenanceDay =
  | "Monday"
  | "Tuesday"
  | "Wednesday"
  | "Thursday"
  | "Friday"
  | "Saturday"
  | "Sunday";

/** Start of the 30-minute weekly maintenance window. */
export interface AmlFilesystemMaintenanceWindow {
  /** Day of the week on which the maintenance window starts. */
  dayOfWeek: AmlFilesystemMaintenanceDay;
  /** Time of day (UTC, `HH:MM`) the maintenance window starts, e.g. `"22:00"`. */
  timeOfDayUTC: string;
}

/** Blob integration (hierarchical storage management) settings. */
export interface AmlFilesystemHsm {
  /**
   * Resource ID of the blob container used to hydrate the namespace and to
   * archive into. The HPC Cache resource provider needs `Storage Account
   * Contributor` and `Storage Blob Data Contributor` on the storage account.
   */
  container: string;
  /**
   * Resource ID of the blob container that receives import/export logs. Must
   * be a different container in the same storage account.
   */
  loggingContainer: string;
  /**
   * Blob prefixes imported into the namespace when the file system is
   * created.
   * @default ["/"]
   */
  importPrefixesInitial?: string[];
}

/** Root squash settings for non-trusted clients. */
export interface AmlFilesystemRootSquash {
  /**
   * `None` squashes nothing, `RootOnly` squashes the root user, `All`
   * squashes every user on non-trusted systems.
   */
  mode: "None" | "RootOnly" | "All";
  /** Semicolon-separated NID lists of trusted systems that are not squashed. */
  noSquashNidLists?: string;
  /** User ID to squash to. */
  squashUID?: number;
  /** Group ID to squash to. */
  squashGID?: number;
}

/** Customer-managed key used to encrypt the file system. */
export interface AmlFilesystemEncryption {
  /** URL of the key-encryption key in Key Vault (including its version). */
  keyUrl: string;
  /** Resource ID of the Key Vault holding the key. */
  sourceVaultId: string;
}

export interface AmlFilesystemProps {
  /**
   * Resource group the file system is created in. Changing it replaces the
   * file system.
   */
  resourceGroup: string;
  /**
   * Name of the file system: 1-80 alphanumerics, `_` and `-`, starting and
   * ending with an alphanumeric. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the file system.
   */
  name?: string;
  /**
   * Azure location of the file system. Changing it replaces the file system.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /** Availability zones (e.g. `["1"]`). Changing them replaces the file system. */
  zones?: string[];
  /**
   * Throughput SKU. Each SKU has a minimum capacity and increment:
   * Premium-40 48 TiB, Premium-125 16 TiB, Premium-250 8 TiB, Premium-500
   * 4 TiB. Changing it replaces the file system.
   */
  sku: AmlFilesystemSku;
  /**
   * Storage capacity in TiB (may be rounded up by Azure). Changing it
   * replaces the file system.
   */
  storageCapacityTiB: number;
  /**
   * Resource ID of the subnet used for the file system and client traffic.
   * Use a dedicated subnet of at least /24 (see
   * `GetRequiredAmlFSSubnetsSize`). Changing it replaces the file system.
   */
  filesystemSubnet: string;
  /** Weekly 30-minute maintenance window. */
  maintenanceWindow: AmlFilesystemMaintenanceWindow;
  /**
   * Blob integration settings. Set only at creation; changing them replaces
   * the file system.
   */
  hsm?: AmlFilesystemHsm;
  /** Root squash settings. */
  rootSquashSettings?: AmlFilesystemRootSquash;
  /**
   * Customer-managed key encryption. Requires a user-assigned identity with
   * access to the key (see {@link AmlFilesystemProps.userAssignedIdentityIds}).
   */
  encryptionSettings?: AmlFilesystemEncryption;
  /** Resource IDs of user-assigned managed identities attached to the file system. */
  userAssignedIdentityIds?: string[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface AmlFilesystem extends Resource<
  "Azure.StorageCache.AmlFilesystem",
  AmlFilesystemProps,
  {
    /** Name of the file system. */
    amlFilesystemName: string;
    /** ARM resource ID of the file system. */
    amlFilesystemId: string;
    /** Resource group that holds the file system. */
    resourceGroup: string;
    /** Location of the file system. */
    location: string;
    /** SKU of the file system. */
    sku: string | undefined;
    /** Requested storage capacity in TiB. */
    storageCapacityTiB: number;
    /** Current storage capacity in TiB, including expansions. */
    currentStorageCapacityTiB: number | undefined;
    /** Resource ID of the file system subnet. */
    filesystemSubnet: string;
    /** Weekly maintenance window. */
    maintenanceWindow: AmlFilesystemMaintenanceWindow;
    /** Provisioned throughput in MB/s. */
    throughputProvisionedMBps: number | undefined;
    /** Lustre Management Service (MGS) IPv4 address clients mount from. */
    mgsAddress: string | undefined;
    /** Recommended `mount` command for clients. */
    mountCommand: string | undefined;
    /** Lustre version running in the file system. */
    lustreVersion: string | undefined;
    /** Unique identifier of the Lustre cluster. */
    clusterUuid: string | undefined;
    /** Health state (`Available`, `Degraded`, ...). */
    health: string | undefined;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Managed Lustre file system — a fully managed, high-throughput
 * Lustre parallel file system for HPC and AI workloads, optionally
 * integrated with a Blob Storage container for hydration and archiving.
 *
 * Creation takes 10-30 minutes; the smallest file system (4 TiB of
 * `AMLFS-Durable-Premium-500`) costs roughly $2-3 per hour.
 *
 * @see https://learn.microsoft.com/azure/azure-managed-lustre/amlfs-overview
 *
 * ### Creating a File System
 * **Example:** 4 TiB Premium-500 file system in a dedicated subnet
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("hpc");
 * const vnet = yield* Azure.Network.VirtualNetwork("vnet", {
 *   resourceGroup: group.resourceGroupName,
 *   addressPrefixes: ["10.0.0.0/16"],
 * });
 * const subnet = yield* Azure.Network.Subnet("lustre", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.0.0/24",
 * });
 * const fs = yield* Azure.StorageCache.AmlFilesystem("scratch", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "AMLFS-Durable-Premium-500",
 *   storageCapacityTiB: 4,
 *   filesystemSubnet: subnet.subnetId,
 *   maintenanceWindow: { dayOfWeek: "Sunday", timeOfDayUTC: "22:00" },
 * });
 * ```
 *
 * ### Blob Integration
 * **Example:** Hydrate from and archive to a blob container
 * ```typescript
 * const fs = yield* Azure.StorageCache.AmlFilesystem("scratch", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "AMLFS-Durable-Premium-500",
 *   storageCapacityTiB: 4,
 *   filesystemSubnet: subnet.subnetId,
 *   maintenanceWindow: { dayOfWeek: "Sunday", timeOfDayUTC: "22:00" },
 *   hsm: {
 *     container: data.containerId,
 *     loggingContainer: logs.containerId,
 *   },
 * });
 * ```
 *
 * ### Root Squash
 * **Example:** Squash root on untrusted clients
 * ```typescript
 * const fs = yield* Azure.StorageCache.AmlFilesystem("scratch", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "AMLFS-Durable-Premium-500",
 *   storageCapacityTiB: 4,
 *   filesystemSubnet: subnet.subnetId,
 *   maintenanceWindow: { dayOfWeek: "Sunday", timeOfDayUTC: "22:00" },
 *   rootSquashSettings: { mode: "RootOnly", squashUID: 65534, squashGID: 65534 },
 * });
 * ```
 *
 * @resource
 */
export const AmlFilesystem = Resource<AmlFilesystem>(
  "Azure.StorageCache.AmlFilesystem",
);

type ObservedFilesystem = storagecache.GetAmlFilesystemResponse;

export const getAmlFilesystem = (
  subscriptionId: string,
  resourceGroupName: string,
  amlFilesystemName: string,
) =>
  orUndefinedIfNotFound(
    storagecache.GetAmlFilesystem({
      subscriptionId,
      resourceGroupName,
      amlFilesystemName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  fs: ObservedFilesystem,
): AmlFilesystem["Attributes"] => ({
  amlFilesystemName: name,
  amlFilesystemId: fs.id ?? "",
  resourceGroup,
  location: fs.location,
  sku: fs.sku?.name,
  storageCapacityTiB: fs.properties?.storageCapacityTiB ?? 0,
  currentStorageCapacityTiB: fs.properties?.currentStorageCapacityTiB,
  filesystemSubnet: fs.properties?.filesystemSubnet ?? "",
  maintenanceWindow: {
    dayOfWeek: (fs.properties?.maintenanceWindow?.dayOfWeek ??
      "Sunday") as AmlFilesystemMaintenanceDay,
    timeOfDayUTC: fs.properties?.maintenanceWindow?.timeOfDayUTC ?? "",
  },
  throughputProvisionedMBps: fs.properties?.throughputProvisionedMBps,
  mgsAddress: fs.properties?.clientInfo?.mgsAddress,
  mountCommand: fs.properties?.clientInfo?.mountCommand,
  lustreVersion: fs.properties?.clientInfo?.lustreVersion,
  clusterUuid: fs.properties?.clusterUuid,
  health: fs.properties?.health?.state,
  provisioningState: fs.properties?.provisioningState,
  tags: userTags(fs.tags),
});

const rootSquashInput = (
  settings: AmlFilesystemRootSquash | undefined,
): storagecache.AmlFilesystemRootSquashSettingsInput | undefined =>
  settings === undefined
    ? undefined
    : {
        mode: settings.mode,
        noSquashNidLists: settings.noSquashNidLists,
        squashUID: settings.squashUID,
        squashGID: settings.squashGID,
      };

const encryptionInput = (
  settings: AmlFilesystemEncryption | undefined,
): storagecache.AmlFilesystemEncryptionSettings | undefined =>
  settings === undefined
    ? undefined
    : {
        keyEncryptionKey: {
          keyUrl: settings.keyUrl,
          sourceVault: { id: settings.sourceVaultId },
        },
      };

const identityInput = (
  ids: readonly string[] | undefined,
): storagecache.AmlFilesystemIdentityInput | undefined =>
  ids === undefined || ids.length === 0
    ? undefined
    : {
        type: "UserAssigned",
        userAssignedIdentities: Object.fromEntries(ids.map((id) => [id, {}])),
      };

const maintenanceDiffers = (
  observed: storagecache.AmlFilesystemPropertiesMaintenanceWindow | undefined,
  desired: AmlFilesystemMaintenanceWindow,
) =>
  observed?.dayOfWeek !== desired.dayOfWeek ||
  observed?.timeOfDayUTC !== desired.timeOfDayUTC;

/** Root squash is only compared when the user manages it. */
const rootSquashDiffers = (
  observed: storagecache.AmlFilesystemRootSquashSettings | undefined,
  desired: AmlFilesystemRootSquash | undefined,
) =>
  desired !== undefined &&
  ((observed?.mode ?? "None") !== desired.mode ||
    (desired.noSquashNidLists !== undefined &&
      observed?.noSquashNidLists !== desired.noSquashNidLists) ||
    (desired.squashUID !== undefined &&
      observed?.squashUID !== desired.squashUID) ||
    (desired.squashGID !== undefined &&
      observed?.squashGID !== desired.squashGID));

const encryptionDiffers = (
  observed: storagecache.AmlFilesystemEncryptionSettings | undefined,
  desired: AmlFilesystemEncryption | undefined,
) =>
  desired !== undefined &&
  observed?.keyEncryptionKey?.keyUrl !== desired.keyUrl;

const identityDiffers = (
  observed: storagecache.AmlFilesystemIdentity | undefined,
  desired: readonly string[] | undefined,
) => {
  const want = (desired ?? []).map((id) => id.toLowerCase()).sort();
  const have = Object.keys(observed?.userAssignedIdentities ?? {})
    .map((id) => id.toLowerCase())
    .sort();
  return !sameList(want, have);
};

export const AmlFilesystemProvider = () =>
  Provider.succeed(AmlFilesystem, {
    stables: [
      "amlFilesystemName",
      "amlFilesystemId",
      "resourceGroup",
      "location",
      "filesystemSubnet",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* orUndefinedIfNotFound(
        storagecache
          .ListAmlFilesystems({ subscriptionId })
          .pipe(
            Effect.flatMap((page) =>
              requireSinglePage("ListAmlFilesystems", page),
            ),
          ),
      );
      return (page?.value ?? []).flatMap((fs) => {
        const group = resourceGroupOf(fs.id);
        return hasAnyAlchemyTag(fs.tags) &&
          group !== undefined &&
          fs.name !== undefined
          ? [toAttrs(group, fs.name, fs)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.amlFilesystemName.toLowerCase()) ||
        (news.location !== undefined &&
          !sameLocation(news.location, output.location)) ||
        news.filesystemSubnet.toLowerCase() !==
          output.filesystemSubnet.toLowerCase() ||
        (output.sku !== undefined &&
          news.sku.toLowerCase() !== output.sku.toLowerCase())
      ) {
        return { action: "replace" } as const;
      }
      if (
        olds !== undefined &&
        (news.storageCapacityTiB !== olds.storageCapacityTiB ||
          !sameList(news.zones, olds.zones) ||
          JSON.stringify(news.hsm ?? null) !== JSON.stringify(olds.hsm ?? null))
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
        output?.amlFilesystemName ??
        olds?.name ??
        (yield* createLustreName(id));
      const observed = yield* getAmlFilesystem(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.StorageCache");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.amlFilesystemName ?? (yield* createLustreName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        amlFilesystemName: name,
      };
      const get = getAmlFilesystem(subscriptionId, resourceGroup, name);
      const settle = waitForProvisioned(
        `AML file system ${name}`,
        get,
        (fs) => fs.properties?.provisioningState,
        FILESYSTEM_BUDGET,
      );
      const put = storagecache.AmlFilesystemsCreateOrUpdate({
        ...where,
        location,
        tags,
        sku: { name: news.sku },
        zones: news.zones,
        identity: identityInput(news.userAssignedIdentityIds),
        properties: {
          storageCapacityTiB: news.storageCapacityTiB,
          filesystemSubnet: news.filesystemSubnet,
          maintenanceWindow: news.maintenanceWindow,
          encryptionSettings: encryptionInput(news.encryptionSettings),
          rootSquashSettings: rootSquashInput(news.rootSquashSettings),
          hsm:
            news.hsm === undefined
              ? undefined
              : {
                  settings: {
                    container: news.hsm.container,
                    loggingContainer: news.hsm.loggingContainer,
                    importPrefixesInitial: news.hsm.importPrefixesInitial,
                  },
                },
        },
      });

      // Observe; wait out an in-flight create/update from an earlier run.
      let observed = yield* get;
      if (
        observed !== undefined &&
        observed.properties?.provisioningState !== "Succeeded" &&
        observed.properties?.provisioningState !== "Failed"
      ) {
        observed = yield* settle;
      }

      // Ensure: create (LRO), or re-PUT when the identity set changed (the
      // PATCH body has no identity).
      if (
        observed === undefined ||
        identityDiffers(observed.identity, news.userAssignedIdentityIds)
      ) {
        yield* put;
        observed = yield* settle;
      }

      // Sync mutable settings and tags against the observed file system.
      const props = observed.properties;
      const patch: storagecache.AmlFilesystemUpdatePropertiesInput = {};
      if (
        maintenanceDiffers(props?.maintenanceWindow, news.maintenanceWindow)
      ) {
        patch.maintenanceWindow = news.maintenanceWindow;
      }
      if (
        rootSquashDiffers(props?.rootSquashSettings, news.rootSquashSettings)
      ) {
        patch.rootSquashSettings = rootSquashInput(news.rootSquashSettings);
      }
      if (
        encryptionDiffers(props?.encryptionSettings, news.encryptionSettings)
      ) {
        patch.encryptionSettings = encryptionInput(news.encryptionSettings);
      }
      const retag = tagsDiffer(observed.tags, tags);
      if (Object.keys(patch).length > 0 || retag) {
        yield* storagecache.UpdateAmlFilesystem({
          ...where,
          tags: retag ? tags : undefined,
          properties: Object.keys(patch).length > 0 ? patch : undefined,
        });
        observed = yield* settle;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        storagecache.DeleteAmlFilesystem({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          amlFilesystemName: output.amlFilesystemName,
        }),
      );
      yield* waitUntilGone(
        `AML file system ${output.amlFilesystemName}`,
        getAmlFilesystem(
          subscriptionId,
          output.resourceGroup,
          output.amlFilesystemName,
        ),
        FILESYSTEM_BUDGET,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
