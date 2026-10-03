import * as elasticsan from "@distilled.cloud/azure/elasticsan";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createSanName, isParentOwned, lower } from "./Common.ts";

export type VolumeGroupEncryption =
  | "EncryptionAtRestWithPlatformKey"
  | "EncryptionAtRestWithCustomerManagedKey";

/** Customer-managed key settings of a volume group. */
export interface VolumeGroupEncryptionProperties {
  /** Key Vault key used to encrypt the volumes. */
  keyVaultProperties?: {
    /** Name of the Key Vault key. */
    keyName?: string;
    /** Version of the key. Omit to follow the latest version. */
    keyVersion?: string;
    /** URI of the Key Vault, e.g. `https://my-vault.vault.azure.net/`. */
    keyVaultUri?: string;
  };
  /** Identity used to access the key. */
  identity?: {
    /** Resource ID of a user-assigned identity attached to the group. */
    userAssignedIdentity?: string;
  };
}

/** Managed identity of a volume group. */
export interface VolumeGroupIdentity {
  /** Identity type. */
  type: "None" | "SystemAssigned" | "UserAssigned";
  /** Resource IDs of user-assigned identities (with `type: "UserAssigned"`). */
  userAssignedIdentities?: string[];
}

/** A virtual network rule allowing a subnet to reach the volume group. */
export interface VolumeGroupVirtualNetworkRule {
  /**
   * Resource ID of the subnet. The subnet needs the `Microsoft.Storage`
   * (or `Microsoft.Storage.Global`) service endpoint.
   */
  id: string;
  /**
   * Rule action.
   * @default "Allow"
   */
  action?: "Allow";
}

export interface VolumeGroupProps {
  /** Resource group of the Elastic SAN. Changing it replaces the group. */
  resourceGroup: string;
  /** Name of the parent Elastic SAN. Changing it replaces the group. */
  elasticSan: string;
  /**
   * Volume group name: 3-63 lowercase letters, digits, hyphens and
   * underscores, starting and ending with a letter or digit. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the group.
   */
  name?: string;
  /**
   * Storage target protocol of the group's volumes. Changing it replaces
   * the group.
   * @default "Iscsi"
   */
  protocolType?: "Iscsi" | "None";
  /**
   * Encryption at rest.
   * @default "EncryptionAtRestWithPlatformKey"
   */
  encryption?: VolumeGroupEncryption;
  /** Customer-managed key settings (with `EncryptionAtRestWithCustomerManagedKey`). */
  encryptionProperties?: VolumeGroupEncryptionProperties;
  /** Managed identity of the group (needed for customer-managed keys). */
  identity?: VolumeGroupIdentity;
  /**
   * Subnets allowed to reach the group's volumes. An empty list removes
   * every rule.
   */
  virtualNetworkRules?: VolumeGroupVirtualNetworkRule[];
  /** Enforce CRC data-integrity checks on iSCSI connections. */
  enforceDataIntegrityCheckForIscsi?: boolean;
}

export interface VolumeGroup extends Resource<
  "Azure.ElasticSan.VolumeGroup",
  VolumeGroupProps,
  {
    /** Name of the volume group. */
    volumeGroupName: string;
    /** ARM resource ID of the volume group. */
    volumeGroupId: string;
    /** Name of the parent Elastic SAN. */
    elasticSan: string;
    /** Resource group of the Elastic SAN. */
    resourceGroup: string;
    /** Storage target protocol as reported by Azure (e.g. `iSCSI`). */
    protocolType: string;
    /** Encryption at rest. */
    encryption: string;
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** Subnet IDs allowed by the group's network rules. */
    virtualNetworkRules: string[];
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A volume group in an Azure Elastic SAN. Volume groups hold volumes and
 * apply network rules, encryption, and protocol settings to all of them.
 *
 * Volume groups have no tags; Alchemy treats a group as owned when its
 * parent SAN carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/storage/elastic-san/elastic-san-create
 *
 * ### Creating a Volume Group
 * **Example:** iSCSI volume group with platform-managed keys
 * ```typescript
 * const san = yield* Azure.ElasticSan.ElasticSan("san", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * const volumes = yield* Azure.ElasticSan.VolumeGroup("volumes", {
 *   resourceGroup: group.resourceGroupName,
 *   elasticSan: san.elasticSanName,
 * });
 * ```
 *
 * ### Network Rules
 * **Example:** Allow a subnet with a storage service endpoint
 * ```typescript
 * const volumes = yield* Azure.ElasticSan.VolumeGroup("volumes", {
 *   resourceGroup: group.resourceGroupName,
 *   elasticSan: san.elasticSanName,
 *   virtualNetworkRules: [{ id: subnet.subnetId }],
 * });
 * ```
 *
 * @resource
 */
export const VolumeGroup = Resource<VolumeGroup>(
  "Azure.ElasticSan.VolumeGroup",
);

type ObservedGroup = elasticsan.GetVolumeGroupResponse;

const getVolumeGroup = (
  subscriptionId: string,
  resourceGroupName: string,
  elasticSanName: string,
  volumeGroupName: string,
) =>
  orUndefinedIfNotFound(
    elasticsan.GetVolumeGroup({
      subscriptionId,
      resourceGroupName,
      elasticSanName,
      volumeGroupName,
    }),
  );

const ruleIds = (rules: { id: string }[] | undefined) =>
  (rules ?? []).map((rule) => rule.id.toLowerCase()).sort();

const toAttrs = (
  resourceGroup: string,
  elasticSan: string,
  name: string,
  group: ObservedGroup,
): VolumeGroup["Attributes"] => ({
  volumeGroupName: name,
  volumeGroupId: group.id ?? "",
  elasticSan,
  resourceGroup,
  protocolType: group.properties?.protocolType ?? "",
  encryption: group.properties?.encryption ?? "",
  principalId: group.identity?.principalId,
  virtualNetworkRules: (
    group.properties?.networkAcls?.virtualNetworkRules ?? []
  ).map((rule) => rule.id),
  provisioningState: group.properties?.provisioningState,
});

const toIdentityInput = (
  identity: VolumeGroupIdentity,
): elasticsan.IdentityInput => ({
  type: identity.type,
  userAssignedIdentities: identity.userAssignedIdentities
    ? Object.fromEntries(identity.userAssignedIdentities.map((id) => [id, {}]))
    : undefined,
});

const identityMatches = (
  observed: elasticsan.Identity | undefined,
  desired: VolumeGroupIdentity,
) =>
  (observed?.type ?? "None") === desired.type &&
  Object.keys(observed?.userAssignedIdentities ?? {})
    .map((id) => id.toLowerCase())
    .sort()
    .join(",") ===
    (desired.userAssignedIdentities ?? [])
      .map((id) => id.toLowerCase())
      .sort()
      .join(",");

const encryptionPropertiesMatch = (
  observed: elasticsan.EncryptionProperties | undefined,
  desired: VolumeGroupEncryptionProperties,
) => {
  const kv = desired.keyVaultProperties;
  const okv = observed?.keyVaultProperties;
  return (
    (kv?.keyName === undefined || kv.keyName === okv?.keyName) &&
    (kv?.keyVersion === undefined || kv.keyVersion === okv?.keyVersion) &&
    (kv?.keyVaultUri === undefined ||
      lower(kv.keyVaultUri)?.replace(/\/$/, "") ===
        lower(okv?.keyVaultUri)?.replace(/\/$/, "")) &&
    (desired.identity?.userAssignedIdentity === undefined ||
      lower(desired.identity.userAssignedIdentity) ===
        lower(observed?.identity?.userAssignedIdentity))
  );
};

export const VolumeGroupProvider = () =>
  Provider.succeed(VolumeGroup, {
    stables: [
      "volumeGroupName",
      "volumeGroupId",
      "elasticSan",
      "resourceGroup",
      "protocolType",
    ],

    // Volume groups live inside an Elastic SAN; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        news.elasticSan !== output.elasticSan ||
        (news.name !== undefined && news.name !== output.volumeGroupName) ||
        // Azure reports the protocol as `iSCSI`.
        lower(news.protocolType ?? "Iscsi") !== lower(output.protocolType)
      ) {
        // An explicit, unchanged name cannot be held by two generations.
        return {
          action: "replace",
          deleteFirst:
            news.name !== undefined && news.name === output.volumeGroupName,
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const elasticSan = output?.elasticSan ?? olds?.elasticSan;
      if (resourceGroup === undefined || elasticSan === undefined) {
        return undefined;
      }
      const name =
        output?.volumeGroupName ?? olds?.name ?? (yield* createSanName(id, 63));
      const observed = yield* getVolumeGroup(
        subscriptionId,
        resourceGroup,
        elasticSan,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, elasticSan, name, observed);
      return (yield* isParentOwned(subscriptionId, resourceGroup, elasticSan))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.ElasticSan");
      const { resourceGroup, elasticSan } = news;
      const name =
        news.name ?? output?.volumeGroupName ?? (yield* createSanName(id, 63));
      const encryption = news.encryption ?? "EncryptionAtRestWithPlatformKey";
      const networkAcls =
        news.virtualNetworkRules === undefined
          ? undefined
          : {
              virtualNetworkRules: news.virtualNetworkRules.map((rule) => ({
                id: rule.id,
                action: rule.action ?? "Allow",
              })),
            };
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        elasticSanName: elasticSan,
        volumeGroupName: name,
      };
      const get = getVolumeGroup(
        subscriptionId,
        resourceGroup,
        elasticSan,
        name,
      );
      const waitReady = waitForProvisioned(
        `elastic san volume group ${name}`,
        get,
        (group) => group.properties?.provisioningState,
        { interval: "3 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* elasticsan.CreateVolumeGroup({
          ...where,
          identity: news.identity ? toIdentityInput(news.identity) : undefined,
          properties: {
            protocolType: news.protocolType ?? "Iscsi",
            encryption,
            encryptionProperties: news.encryptionProperties,
            networkAcls,
            enforceDataIntegrityCheckForIscsi:
              news.enforceDataIntegrityCheckForIscsi,
          },
        });
      }
      observed = yield* waitReady;

      // Sync mutable aspects against observed state.
      const p = observed.properties;
      const changed: elasticsan.VolumeGroupPropertiesInput = {};
      if (lower(p?.encryption) !== lower(encryption)) {
        changed.encryption = encryption;
      }
      if (
        news.encryptionProperties !== undefined &&
        !encryptionPropertiesMatch(
          p?.encryptionProperties,
          news.encryptionProperties,
        )
      ) {
        changed.encryptionProperties = news.encryptionProperties;
      }
      if (
        networkAcls !== undefined &&
        ruleIds(p?.networkAcls?.virtualNetworkRules).join(",") !==
          ruleIds(networkAcls.virtualNetworkRules).join(",")
      ) {
        changed.networkAcls = networkAcls;
      }
      if (
        news.enforceDataIntegrityCheckForIscsi !== undefined &&
        (p?.enforceDataIntegrityCheckForIscsi ?? false) !==
          news.enforceDataIntegrityCheckForIscsi
      ) {
        changed.enforceDataIntegrityCheckForIscsi =
          news.enforceDataIntegrityCheckForIscsi;
      }
      const identityChanged =
        news.identity !== undefined &&
        !identityMatches(observed.identity, news.identity);
      if (Object.keys(changed).length > 0 || identityChanged) {
        yield* elasticsan.UpdateVolumeGroup({
          ...where,
          identity:
            identityChanged && news.identity
              ? toIdentityInput(news.identity)
              : undefined,
          properties: Object.keys(changed).length > 0 ? changed : undefined,
        });
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, elasticSan, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        elasticsan.DeleteVolumeGroup({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          elasticSanName: output.elasticSan,
          volumeGroupName: output.volumeGroupName,
        }),
      );
      yield* waitUntilGone(
        `elastic san volume group ${output.volumeGroupName}`,
        getVolumeGroup(
          subscriptionId,
          output.resourceGroup,
          output.elasticSan,
          output.volumeGroupName,
        ),
        { interval: "3 seconds", times: 60 },
      );
    }),
  });
