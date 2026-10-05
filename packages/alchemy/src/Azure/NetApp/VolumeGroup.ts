import * as netapp from "@distilled.cloud/azure/netapp";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createNetAppName,
  getAccount,
  getVolume,
  LRO_BUDGET,
  type NetAppExportPolicyRule,
  ownedByStage,
  parseNetAppId,
  whileBusy,
} from "./Common.ts";
import { GiB } from "./Volume.ts";

/** One volume of an application volume group. */
export interface VolumeGroupVolume {
  /**
   * Volume name, e.g. `SH1-data-mnt00001` (SAP HANA naming follows
   * `{SID}-{volumeSpecName}`).
   */
  name: string;
  /**
   * Role of the volume in the application, e.g. `data`, `log`, `shared`,
   * `data-backup`, `log-backup` (SAP HANA) or `ora-data1`, `ora-log`
   * (Oracle).
   */
  volumeSpecName: string;
  /** ARM ID of the capacity pool the volume is carved from. */
  capacityPoolResourceId: string;
  /** ARM ID of a subnet delegated to `Microsoft.NetApp/volumes`. */
  subnetId: string;
  /**
   * Export path of the volume (unique per subscription and region).
   * @default the volume name
   */
  creationToken?: string;
  /**
   * Quota in bytes.
   * @default 100 GiB
   */
  usageThreshold?: number;
  /**
   * Protocols.
   * @default ["NFSv4.1"]
   */
  protocolTypes?: ("NFSv3" | "NFSv4.1")[];
  /** Throughput in MiB/s (manual-QoS pools). */
  throughputMibps?: number;
  /** ARM ID of the proximity placement group (SAP HANA). */
  proximityPlacementGroup?: string;
  /** Availability zone (Oracle). */
  zones?: string[];
  /**
   * Export policy rules. Azure requires one on every volume in a group.
   * @default one rule allowing read/write from `0.0.0.0/0` over the volume's protocols
   */
  exportPolicy?: NetAppExportPolicyRule[];
  /**
   * Network features.
   * @default "Standard"
   */
  networkFeatures?: "Basic" | "Standard";
}

export interface VolumeGroupProps {
  /** Resource group of the NetApp account. Changing it replaces the group. */
  resourceGroup: string;
  /** Name of the NetApp account. Changing it replaces the group. */
  account: string;
  /**
   * Volume group name. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the group.
   */
  name?: string;
  /** Application the group is laid out for. Changing it replaces the group. */
  applicationType: "SAP-HANA" | "ORACLE";
  /** Application identifier, e.g. the SAP SID. Changing it replaces the group. */
  applicationIdentifier: string;
  /** Description of the group. Changing it replaces the group. */
  groupDescription?: string;
  /** Application-specific placement rules. Changing them replaces the group. */
  globalPlacementRules?: { key: string; value: string }[];
  /**
   * The group's volumes, created in one deployment. Changing the list
   * replaces the group; resize individual volumes out of band.
   */
  volumes: VolumeGroupVolume[];
  /**
   * User tags applied to every volume of the group. Alchemy ownership tags
   * are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface VolumeGroup extends Resource<
  "Azure.NetApp.VolumeGroup",
  VolumeGroupProps,
  {
    /** Name of the volume group. */
    volumeGroupName: string;
    /** ARM resource ID of the volume group. */
    volumeGroupId: string;
    /** Parent NetApp account. */
    account: string;
    /** Resource group of the account. */
    resourceGroup: string;
    /** Location of the group. */
    location: string;
    /** Application type. */
    applicationType: string | undefined;
    /** ARM IDs of the group's volumes. */
    volumeIds: string[];
  },
  never,
  Providers
> {}

/**
 * An Azure NetApp Files application volume group — the full set of
 * volumes for an SAP HANA system or an Oracle database, created in one
 * deployment with application-aware placement.
 *
 * Volume groups have no tags; Alchemy treats a group as owned when its
 * account carries this stack's ownership tags. Deleting the group deletes
 * its volumes first.
 *
 * @see https://learn.microsoft.com/azure/azure-netapp-files/application-volume-group-introduction
 *
 * ### Oracle
 * **Example:** Oracle data and log volumes
 * ```typescript
 * const group = yield* Azure.NetApp.VolumeGroup("ora1", {
 *   resourceGroup: rg.resourceGroupName,
 *   account: account.accountName,
 *   applicationType: "ORACLE",
 *   applicationIdentifier: "ORA1",
 *   volumes: [
 *     {
 *       name: "ORA1-ora-data1",
 *       volumeSpecName: "ora-data1",
 *       capacityPoolResourceId: pool.capacityPoolId,
 *       subnetId: subnet.subnetId,
 *       zones: ["1"],
 *     },
 *     {
 *       name: "ORA1-ora-log",
 *       volumeSpecName: "ora-log",
 *       capacityPoolResourceId: pool.capacityPoolId,
 *       subnetId: subnet.subnetId,
 *       zones: ["1"],
 *     },
 *   ],
 * });
 * ```
 *
 * ### SAP HANA
 * **Example:** HANA data volume pinned to a proximity placement group
 * ```typescript
 * const group = yield* Azure.NetApp.VolumeGroup("sh1", {
 *   resourceGroup: rg.resourceGroupName,
 *   account: account.accountName,
 *   applicationType: "SAP-HANA",
 *   applicationIdentifier: "SH1",
 *   volumes: [
 *     {
 *       name: "SH1-data-mnt00001",
 *       volumeSpecName: "data",
 *       capacityPoolResourceId: pool.capacityPoolId,
 *       subnetId: subnet.subnetId,
 *       proximityPlacementGroup: ppg.proximityPlacementGroupId,
 *       usageThreshold: 500 * Azure.NetApp.GiB,
 *       throughputMibps: 400,
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const VolumeGroup = Resource<VolumeGroup>("Azure.NetApp.VolumeGroup");

const protocolsOf = (volume: VolumeGroupVolume) =>
  volume.protocolTypes ?? ["NFSv4.1"];

/**
 * Volume groups validate every access flag as required
 * (`Request is missing a value for 'ExportPolicy.Rules[UnixReadOnly]'`),
 * so unset flags are sent as explicit `false`.
 */
const RULE_DEFAULTS = {
  hasRootAccess: true,
  unixReadOnly: false,
  unixReadWrite: false,
  cifs: false,
  nfsv3: false,
  nfsv41: false,
  kerberos5ReadOnly: false,
  kerberos5ReadWrite: false,
  kerberos5iReadOnly: false,
  kerberos5iReadWrite: false,
  kerberos5pReadOnly: false,
  kerberos5pReadWrite: false,
} satisfies Partial<NetAppExportPolicyRule>;

const defaultExportPolicy = (
  volume: VolumeGroupVolume,
): NetAppExportPolicyRule[] => [
  {
    ruleIndex: 1,
    allowedClients: "0.0.0.0/0",
    unixReadWrite: true,
    nfsv3: protocolsOf(volume).includes("NFSv3"),
    nfsv41: protocolsOf(volume).includes("NFSv4.1"),
  },
];

interface Where {
  subscriptionId: string;
  resourceGroupName: string;
  accountName: string;
  volumeGroupName: string;
}

const getVolumeGroup = (where: Where) =>
  orUndefinedIfNotFound(netapp.GetVolumeGroup(where));

/** A member volume name is held by a volume outside this group. */
export class VolumeGroupVolumeNameInUse extends Data.TaggedError(
  "Azure.NetApp.VolumeGroupVolumeNameInUse",
)<{ readonly volumeName: string; readonly message: string }> {}

/** Pool coordinates of a member volume. */
const memberOf = (where: Where, volume: VolumeGroupVolume) => {
  const { resourceGroup, pool } = parseNetAppId(volume.capacityPoolResourceId);
  return {
    resourceGroupName: resourceGroup ?? where.resourceGroupName,
    poolName: pool ?? "",
    volumeName: volume.name,
  };
};

/**
 * A group create whose member name is taken is accepted (201) and then
 * fails asynchronously ("There already exists a volume with name ..."),
 * leaving no group to observe. Check every member name first: wait while
 * the holder is a volume still being deleted (e.g. the old group of a
 * delete-first replacement), and fail fast when a live volume holds it.
 */
const waitMemberNamesFree = Effect.fn(function* (
  where: Where,
  location: string,
  volumes: ReadonlyArray<VolumeGroupVolume>,
) {
  for (const volume of volumes) {
    const member = memberOf(where, volume);
    const check = netapp.CheckNetAppResourceNameAvailability({
      subscriptionId: where.subscriptionId,
      location,
      name: `${where.accountName}/${member.poolName}/${member.volumeName}`,
      type: "Microsoft.NetApp/netAppAccounts/capacityPools/volumes",
      resourceGroup: member.resourceGroupName,
    });
    const first = yield* check;
    if (first.isAvailable !== false) continue;
    const holder = yield* getVolume(
      where.subscriptionId,
      member.resourceGroupName,
      where.accountName,
      member.poolName,
      member.volumeName,
    );
    // This group's own in-flight create (e.g. after an interrupted run).
    if (
      holder?.properties.volumeGroupName?.toLowerCase() ===
      where.volumeGroupName.toLowerCase()
    ) {
      continue;
    }
    if (
      holder !== undefined &&
      holder.properties.provisioningState?.toLowerCase() !== "deleting"
    ) {
      return yield* new VolumeGroupVolumeNameInUse({
        volumeName: member.volumeName,
        message: `volume ${member.volumeName} already exists in pool ${member.poolName}; volume group members need unused names`,
      });
    }
    const last = yield* check.pipe(
      Effect.repeat({
        schedule: Schedule.spaced("15 seconds"),
        until: (result) => result.isAvailable !== false,
        times: 60,
      }),
    );
    if (last.isAvailable === false) {
      return yield* new VolumeGroupVolumeNameInUse({
        volumeName: member.volumeName,
        message: `volume name ${member.volumeName} is still in use after waiting 15 minutes for its deleting volume: ${last.message ?? ""}`,
      });
    }
  }
});

const toAttrs = (
  where: Where,
  group: netapp.GetVolumeGroupResponse,
): VolumeGroup["Attributes"] => ({
  volumeGroupName: where.volumeGroupName,
  volumeGroupId: group.id ?? "",
  account: where.accountName,
  resourceGroup: where.resourceGroupName,
  location: group.location ?? "",
  applicationType: group.properties?.groupMetaData?.applicationType,
  volumeIds: (group.properties?.volumes ?? []).flatMap((v) =>
    v.id ? [v.id] : [],
  ),
});

/** Everything that defines the group (all of it is create-only). */
const shape = (props: VolumeGroupProps) =>
  JSON.stringify({
    applicationType: props.applicationType,
    applicationIdentifier: props.applicationIdentifier,
    groupDescription: props.groupDescription,
    globalPlacementRules: props.globalPlacementRules,
    volumes: props.volumes,
  });

export const VolumeGroupProvider = () =>
  Provider.succeed(VolumeGroup, {
    stables: [
      "volumeGroupName",
      "volumeGroupId",
      "account",
      "resourceGroup",
      "location",
      "applicationType",
    ],

    // Volume groups carry no tags; their volumes are tagged and listed by
    // `Azure.NetApp.Volume`, and the account delete removes the empty group.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.account.toLowerCase() !== output.account.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.volumeGroupName.toLowerCase()) ||
        (olds !== undefined && shape(news) !== shape(olds))
      ) {
        // Member volume names and export paths are user-fixed, so the old
        // group must be gone before its replacement is created.
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroupName = output?.resourceGroup ?? olds?.resourceGroup;
      const accountName = output?.account ?? olds?.account;
      if (!resourceGroupName || !accountName) return undefined;
      const where = {
        subscriptionId,
        resourceGroupName,
        accountName,
        volumeGroupName:
          output?.volumeGroupName ??
          olds?.name ??
          (yield* createNetAppName(id, 64)),
      };
      const observed = yield* getVolumeGroup(where);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(where, observed);
      const parent = yield* getAccount(
        subscriptionId,
        resourceGroupName,
        accountName,
      );
      return (yield* ownedByStage(parent?.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.NetApp");
      const where = {
        subscriptionId,
        resourceGroupName: news.resourceGroup,
        accountName: news.account,
        volumeGroupName:
          news.name ??
          output?.volumeGroupName ??
          (yield* createNetAppName(id, 64)),
      };
      const tags = yield* desiredTags(id, news.tags);
      const get = getVolumeGroup(where);

      // Observe; ensure. Every property is create-only (volumes inside the
      // group are resized individually), so there is nothing to sync.
      if ((yield* get) === undefined) {
        const parent = yield* netapp.GetAccount({
          subscriptionId,
          resourceGroupName: where.resourceGroupName,
          accountName: where.accountName,
        });
        yield* waitMemberNamesFree(where, parent.location, news.volumes);
        yield* whileBusy(
          netapp.CreateVolumeGroup({
            ...where,
            location: parent.location,
            properties: {
              groupMetaData: {
                applicationType: news.applicationType,
                applicationIdentifier: news.applicationIdentifier,
                groupDescription: news.groupDescription,
                globalPlacementRules: news.globalPlacementRules,
              },
              volumes: news.volumes.map((volume) => ({
                name: volume.name,
                tags,
                zones: volume.zones,
                properties: {
                  creationToken: volume.creationToken ?? volume.name,
                  usageThreshold: volume.usageThreshold ?? 100 * GiB,
                  subnetId: volume.subnetId,
                  capacityPoolResourceId: volume.capacityPoolResourceId,
                  volumeSpecName: volume.volumeSpecName,
                  protocolTypes: protocolsOf(volume),
                  throughputMibps: volume.throughputMibps,
                  proximityPlacementGroup: volume.proximityPlacementGroup,
                  networkFeatures: volume.networkFeatures ?? "Standard",
                  // Volumes inside a group must carry an export policy
                  // (`VolumesInVolumeGroupMustHaveExportPolicy`).
                  exportPolicy: {
                    rules: (
                      volume.exportPolicy ?? defaultExportPolicy(volume)
                    ).map((rule) => ({ ...RULE_DEFAULTS, ...rule })),
                  },
                },
              })),
            },
          }),
        );
      }
      const observed = yield* waitForProvisioned(
        `volume group ${where.volumeGroupName}`,
        // The group GET fails with a transient 500 while its volumes are
        // still provisioning; keep polling.
        get.pipe(
          Effect.catchTag("NetAppVolumeGroupNotReadable", () =>
            Effect.succeed(undefined),
          ),
        ),
        (group) => group.properties?.provisioningState,
        LRO_BUDGET,
      );
      return toAttrs(where, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        accountName: output.account,
        volumeGroupName: output.volumeGroupName,
      };
      // Azure deletes a volume group only once its volumes are gone.
      const observed = yield* getVolumeGroup(where);
      const volumeIds = [
        ...output.volumeIds,
        ...(observed?.properties?.volumes ?? []).flatMap((v) =>
          v.id ? [v.id] : [],
        ),
      ].filter((id, i, all) => all.indexOf(id) === i);
      yield* Effect.forEach(
        volumeIds,
        Effect.fnUntraced(function* (volumeId) {
          const { resourceGroup, account, pool, name } =
            parseNetAppId(volumeId);
          if (!resourceGroup || !account || !pool || !name) return;
          const target = {
            subscriptionId,
            resourceGroupName: resourceGroup,
            accountName: account,
            poolName: pool,
            volumeName: name,
          };
          yield* whileBusy(ignoreNotFound(netapp.DeleteVolume(target)));
          yield* waitUntilGone(
            `netapp volume ${name}`,
            getVolume(subscriptionId, resourceGroup, account, pool, name),
            LRO_BUDGET,
          );
        }),
        { concurrency: "unbounded" },
      );
      yield* whileBusy(ignoreNotFound(netapp.DeleteVolumeGroup(where)));
      yield* waitUntilGone(
        `volume group ${output.volumeGroupName}`,
        getVolumeGroup(where),
        LRO_BUDGET,
      );
    }),

    nuke: {
      dependsOn: ["Azure.NetApp.Account", "Azure.Resources.ResourceGroup"],
    },
  });
