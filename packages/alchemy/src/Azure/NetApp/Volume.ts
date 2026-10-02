import * as netapp from "@distilled.cloud/azure/netapp";
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
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createNetAppName,
  getVolume,
  listAllPools,
  LRO_BUDGET,
  matchesObserved,
  type NetAppExportPolicyRule,
  parseNetAppId,
  poolRefs,
  whileBusy,
} from "./Common.ts";

/** 1 GiB in bytes. */
export const GiB = 1_073_741_824;

export type NetAppProtocolType = "NFSv3" | "NFSv4.1" | "CIFS";

export interface VolumeProps {
  /** Resource group of the NetApp account. Changing it replaces the volume. */
  resourceGroup: string;
  /** Name of the NetApp account. Changing it replaces the volume. */
  account: string;
  /** Name of the capacity pool. Changing it replaces the volume. */
  pool: string;
  /**
   * Volume name: 1-64 letters, digits, `-` and `_`, starting with a letter.
   * If omitted, a unique name is generated from the app, stage, and
   * logical ID. Changing it replaces the volume.
   */
  name?: string;
  /**
   * Export path (unique per subscription and region): the NFS mount path
   * or SMB share name. Changing it replaces the volume.
   * @default the volume name
   */
  creationToken?: string;
  /**
   * ARM ID of a subnet delegated to `Microsoft.NetApp/volumes`. Changing it
   * replaces the volume.
   */
  subnetId: string;
  /**
   * Quota (maximum logical size) in bytes: 50 GiB to 100 TiB (up to 1 PiB
   * for large volumes).
   * @default 100 GiB
   */
  usageThreshold?: number;
  /**
   * Protocols the volume serves. Changing it replaces the volume.
   * @default ["NFSv3"]
   */
  protocolTypes?: NetAppProtocolType[];
  /** Export policy rules (NFS client access). */
  exportPolicy?: NetAppExportPolicyRule[];
  /**
   * Network features. `Standard` enables the full VNet feature set.
   * Changing it replaces the volume.
   * @default "Standard"
   */
  networkFeatures?: "Basic" | "Standard";
  /** Availability zone to place the volume in. Changing it replaces the volume. */
  zones?: string[];
  /** Create the volume from this snapshot (ARM ID or UUID). Changing it replaces the volume. */
  snapshotId?: string;
  /** Create the volume from this backup (ARM ID). Changing it replaces the volume. */
  backupId?: string;
  /** Security style of a dual-protocol or NFSv4.1 volume. Changing it replaces the volume. */
  securityStyle?: "ntfs" | "unix";
  /** Show the `.snapshot` directory to clients. */
  snapshotDirectoryVisible?: boolean;
  /** UNIX permissions of the volume root in octal, e.g. `0770`. */
  unixPermissions?: string;
  /** Throughput in MiB/s (manual-QoS pools only). */
  throughputMibps?: number;
  /** Enable default user/group quotas. */
  isDefaultQuotaEnabled?: boolean;
  /** Default user quota in KiB. */
  defaultUserQuotaInKiBs?: number;
  /** Default group quota in KiB. */
  defaultGroupQuotaInKiBs?: number;
  /** Tier cold data to cool storage (cool-access pools only). */
  coolAccess?: boolean;
  /** Days after which unaccessed data is cooled (2-183). */
  coolnessPeriod?: number;
  /** When cooled data is read back to the hot tier. */
  coolAccessRetrievalPolicy?: "Default" | "OnRead" | "Never";
  /** Which data is tiered. */
  coolAccessTieringPolicy?: "Auto" | "SnapshotOnly";
  /** SMB access-based enumeration. */
  smbAccessBasedEnumeration?: "Disabled" | "Enabled";
  /** Hide the SMB share from browse lists. */
  smbNonBrowsable?: "Disabled" | "Enabled";
  /** ARM ID of a snapshot policy applied to the volume. */
  snapshotPolicyId?: string;
  /** ARM ID of a backup policy applied to the volume. */
  backupPolicyId?: string;
  /** ARM ID of the backup vault storing the volume's backups. */
  backupVaultId?: string;
  /** Whether the backup policy is enforced. */
  backupPolicyEnforced?: boolean;
  /** Enable Kerberos. Changing it replaces the volume. */
  kerberosEnabled?: boolean;
  /** Enable LDAP for NFS. Changing it replaces the volume. */
  ldapEnabled?: boolean;
  /** Require SMB3 encryption. Changing it replaces the volume. */
  smbEncryption?: boolean;
  /** SMB continuous availability. Changing it replaces the volume. */
  smbContinuouslyAvailable?: boolean;
  /** Create a large volume (up to 1 PiB). Changing it replaces the volume. */
  isLargeVolume?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Volume extends Resource<
  "Azure.NetApp.Volume",
  VolumeProps,
  {
    /** Name of the volume. */
    volumeName: string;
    /** ARM resource ID of the volume. */
    volumeId: string;
    /** UUID of the file system. */
    fileSystemId: string | undefined;
    /** Parent NetApp account. */
    account: string;
    /** Parent capacity pool. */
    pool: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** Location of the volume. */
    location: string;
    /** Export path / share name. */
    creationToken: string;
    /** Delegated subnet ID. */
    subnetId: string;
    /** Quota in bytes. */
    usageThreshold: number;
    /** Protocols served. */
    protocolTypes: string[];
    /** Service level inherited from the pool. */
    serviceLevel: string | undefined;
    /** Network features. */
    networkFeatures: string | undefined;
    /** Mount target IP addresses (e.g. `10.0.1.4`). */
    mountIpAddresses: string[];
    /** Effective throughput in MiB/s. */
    actualThroughputMibps: number | undefined;
    /** Availability zones. */
    zones: string[];
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure NetApp Files volume — an NFS / SMB file system carved out of a
 * capacity pool and mounted from a subnet delegated to
 * `Microsoft.NetApp/volumes`. Volumes add no cost beyond their pool.
 *
 * @see https://learn.microsoft.com/azure/azure-netapp-files/azure-netapp-files-create-volumes
 *
 * ### Creating a Volume
 * **Example:** NFSv3 volume
 * ```typescript
 * const vnet = yield* Azure.Network.VirtualNetwork("vnet", {
 *   resourceGroup: group.resourceGroupName,
 *   addressPrefixes: ["10.0.0.0/16"],
 * });
 * const subnet = yield* Azure.Network.Subnet("anf", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.1.0/24",
 *   delegations: [{ serviceName: "Microsoft.NetApp/volumes" }],
 * });
 * const volume = yield* Azure.NetApp.Volume("data", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   pool: pool.poolName,
 *   subnetId: subnet.subnetId,
 *   usageThreshold: 100 * Azure.NetApp.GiB,
 * });
 * ```
 *
 * ### Client Access
 * **Example:** Read-only export for one subnet
 * ```typescript
 * const volume = yield* Azure.NetApp.Volume("data", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   pool: pool.poolName,
 *   subnetId: subnet.subnetId,
 *   exportPolicy: [
 *     {
 *       ruleIndex: 1,
 *       allowedClients: "10.0.2.0/24",
 *       nfsv3: true,
 *       unixReadOnly: true,
 *       unixReadWrite: false,
 *     },
 *   ],
 * });
 * ```
 *
 * ### Data Protection
 * **Example:** Attach a snapshot policy
 * ```typescript
 * const policy = yield* Azure.NetApp.SnapshotPolicy("nightly", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   dailySchedule: { snapshotsToKeep: 7, hour: 2, minute: 0 },
 * });
 * const volume = yield* Azure.NetApp.Volume("data", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   pool: pool.poolName,
 *   subnetId: subnet.subnetId,
 *   snapshotPolicyId: policy.snapshotPolicyId,
 * });
 * ```
 *
 * @resource
 */
export const Volume = Resource<Volume>("Azure.NetApp.Volume");

type ObservedVolume = netapp.GetVolumeResponse | netapp.Volume;

const toAttrs = (
  resourceGroup: string,
  account: string,
  pool: string,
  name: string,
  volume: ObservedVolume,
): Volume["Attributes"] => ({
  volumeName: name,
  volumeId: volume.id ?? "",
  fileSystemId: volume.properties?.fileSystemId,
  account,
  pool,
  resourceGroup,
  location: volume.location ?? "",
  creationToken: volume.properties?.creationToken ?? "",
  subnetId: volume.properties?.subnetId ?? "",
  usageThreshold: volume.properties?.usageThreshold ?? 0,
  protocolTypes: [...(volume.properties?.protocolTypes ?? [])],
  serviceLevel: volume.properties?.serviceLevel,
  networkFeatures: volume.properties?.networkFeatures,
  mountIpAddresses: (volume.properties?.mountTargets ?? []).flatMap((t) =>
    t.ipAddress ? [t.ipAddress] : [],
  ),
  actualThroughputMibps: volume.properties?.actualThroughputMibps,
  zones: [...(volume.zones ?? [])],
  tags: userTags(volume.tags),
});

const toRules = (rules: NetAppExportPolicyRule[]): netapp.ExportPolicyRule[] =>
  rules.map((rule) => ({ hasRootAccess: true, ...rule }));

const sameList = (
  a: ReadonlyArray<string> | undefined,
  b: ReadonlyArray<string> | undefined,
) =>
  JSON.stringify([...(a ?? [])].map((x) => x.toLowerCase()).sort()) ===
  JSON.stringify([...(b ?? [])].map((x) => x.toLowerCase()).sort());

const lowerOrUndefined = (value: string | undefined) => value?.toLowerCase();

/** The PATCH-able properties of a volume, as desired by the props. */
const mutable = (news: VolumeProps) => ({
  usageThreshold: news.usageThreshold ?? 100 * GiB,
  snapshotDirectoryVisible: news.snapshotDirectoryVisible,
  unixPermissions: news.unixPermissions,
  throughputMibps: news.throughputMibps,
  isDefaultQuotaEnabled: news.isDefaultQuotaEnabled,
  defaultUserQuotaInKiBs: news.defaultUserQuotaInKiBs,
  defaultGroupQuotaInKiBs: news.defaultGroupQuotaInKiBs,
  coolAccess: news.coolAccess,
  coolnessPeriod: news.coolnessPeriod,
  coolAccessRetrievalPolicy: news.coolAccessRetrievalPolicy,
  coolAccessTieringPolicy: news.coolAccessTieringPolicy,
  smbAccessBasedEnumeration: news.smbAccessBasedEnumeration,
  smbNonBrowsable: news.smbNonBrowsable,
});

const dataProtection = (news: VolumeProps) =>
  news.snapshotPolicyId === undefined &&
  news.backupPolicyId === undefined &&
  news.backupVaultId === undefined
    ? undefined
    : {
        snapshot:
          news.snapshotPolicyId !== undefined
            ? { snapshotPolicyId: news.snapshotPolicyId }
            : undefined,
        backup:
          news.backupPolicyId !== undefined || news.backupVaultId !== undefined
            ? {
                backupPolicyId: news.backupPolicyId,
                backupVaultId: news.backupVaultId,
                policyEnforced: news.backupPolicyEnforced,
              }
            : undefined,
      };

export const VolumeProvider = () =>
  Provider.succeed(Volume, {
    stables: [
      "volumeName",
      "volumeId",
      "fileSystemId",
      "account",
      "pool",
      "resourceGroup",
      "location",
      "creationToken",
      "subnetId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const pools = yield* listAllPools(subscriptionId);
      const volumes = yield* Effect.forEach(
        poolRefs(pools),
        ({ resourceGroup, account, name }) =>
          orUndefinedIfNotFound(
            netapp
              .ListVolumes({
                subscriptionId,
                resourceGroupName: resourceGroup,
                accountName: account,
                poolName: name,
              })
              .pipe(
                Effect.flatMap((page) =>
                  requireSinglePage("ListVolumes", page),
                ),
              ),
          ).pipe(Effect.map((page) => page?.value ?? [])),
      );
      return volumes.flat().flatMap((volume) => {
        const { resourceGroup, account, pool, name } = parseNetAppId(volume.id);
        return hasAnyAlchemyTag(volume.tags) &&
          resourceGroup &&
          account &&
          pool &&
          name
          ? [toAttrs(resourceGroup, account, pool, name, volume)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output, olds }) {
      if (!isResolved(news) || output === undefined) return undefined;
      const immutableChanged =
        olds !== undefined &&
        (news.securityStyle !== olds.securityStyle ||
          news.kerberosEnabled !== olds.kerberosEnabled ||
          news.ldapEnabled !== olds.ldapEnabled ||
          news.smbEncryption !== olds.smbEncryption ||
          news.smbContinuouslyAvailable !== olds.smbContinuouslyAvailable ||
          news.isLargeVolume !== olds.isLargeVolume ||
          news.snapshotId !== olds.snapshotId ||
          news.backupId !== olds.backupId);
      if (
        immutableChanged ||
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.account.toLowerCase() !== output.account.toLowerCase() ||
        news.pool.toLowerCase() !== output.pool.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.volumeName.toLowerCase()) ||
        (news.creationToken !== undefined &&
          news.creationToken !== output.creationToken) ||
        news.subnetId.toLowerCase() !== output.subnetId.toLowerCase() ||
        !sameList(news.protocolTypes ?? ["NFSv3"], output.protocolTypes) ||
        lowerOrUndefined(news.networkFeatures ?? "Standard") !==
          lowerOrUndefined(output.networkFeatures ?? "Standard") ||
        (news.zones !== undefined && !sameList(news.zones, output.zones))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.account ?? olds?.account;
      const pool = output?.pool ?? olds?.pool;
      if (!resourceGroup || !account || !pool) return undefined;
      const name =
        output?.volumeName ?? olds?.name ?? (yield* createNetAppName(id, 64));
      const observed = yield* getVolume(
        subscriptionId,
        resourceGroup,
        account,
        pool,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, pool, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.NetApp");
      const { resourceGroup, account, pool } = news;
      const name =
        news.name ?? output?.volumeName ?? (yield* createNetAppName(id, 64));
      const tags = yield* desiredTags(id, news.tags);
      const desired = mutable(news);
      const protection = dataProtection(news);
      const rules = news.exportPolicy ? toRules(news.exportPolicy) : undefined;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: account,
        poolName: pool,
        volumeName: name,
      };
      const get = getVolume(subscriptionId, resourceGroup, account, pool, name);
      const waitReady = waitForProvisioned(
        `netapp volume ${name}`,
        get,
        (volume) => volume.properties?.provisioningState,
        LRO_BUDGET,
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        const parent = yield* netapp.GetPool({
          subscriptionId,
          resourceGroupName: resourceGroup,
          accountName: account,
          poolName: pool,
        });
        yield* whileBusy(
          netapp.VolumesCreateOrUpdate({
            ...where,
            location: parent.location,
            tags,
            zones: news.zones,
            properties: {
              ...desired,
              creationToken: news.creationToken ?? name,
              subnetId: news.subnetId,
              serviceLevel: parent.properties.serviceLevel,
              protocolTypes: news.protocolTypes ?? ["NFSv3"],
              networkFeatures: news.networkFeatures ?? "Standard",
              exportPolicy: rules ? { rules } : undefined,
              dataProtection: protection,
              snapshotId: news.snapshotId,
              backupId: news.backupId,
              securityStyle: news.securityStyle,
              kerberosEnabled: news.kerberosEnabled,
              ldapEnabled: news.ldapEnabled,
              smbEncryption: news.smbEncryption,
              smbContinuouslyAvailable: news.smbContinuouslyAvailable,
              isLargeVolume: news.isLargeVolume,
            },
          }),
        );
      }
      observed = yield* waitReady;

      // Sync mutable properties, export policy, data protection, and tags
      // against observed state; PATCH only the delta.
      const props = observed.properties;
      const changed: netapp.VolumePatchProperties = {};
      for (const key of Object.keys(desired) as (keyof typeof desired)[]) {
        const value = desired[key];
        if (value !== undefined && !matchesObserved(value, props?.[key])) {
          Object.assign(changed, { [key]: value });
        }
      }
      if (rules && !matchesObserved(rules, props?.exportPolicy?.rules ?? [])) {
        changed.exportPolicy = { rules };
      }
      if (protection && !matchesObserved(protection, props?.dataProtection)) {
        changed.dataProtection = protection;
      }
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (Object.keys(changed).length > 0 || tagsChanged) {
        yield* whileBusy(
          netapp.UpdateVolume({
            ...where,
            tags: tagsChanged ? tags : undefined,
            properties: Object.keys(changed).length > 0 ? changed : undefined,
          }),
        );
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, account, pool, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* whileBusy(
        ignoreNotFound(
          netapp.DeleteVolume({
            subscriptionId,
            resourceGroupName: output.resourceGroup,
            accountName: output.account,
            poolName: output.pool,
            volumeName: output.volumeName,
          }),
        ),
      );
      yield* waitUntilGone(
        `netapp volume ${output.volumeName}`,
        getVolume(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.pool,
          output.volumeName,
        ),
        LRO_BUDGET,
      );
    }),

    nuke: {
      dependsOn: ["Azure.NetApp.CapacityPool", "Azure.Resources.ResourceGroup"],
    },
  });
