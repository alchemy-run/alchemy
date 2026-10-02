import * as vmware from "@distilled.cloud/azure/vmware";
import * as Effect from "effect/Effect";
import type * as Redacted from "effect/Redacted";
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
  AVS_NAMESPACE,
  createAvsName,
  getPrivateCloud,
  PRIVATE_CLOUD_BUDGET,
  sameName,
  sameSet,
  unredact,
} from "./common.ts";

/** A vCenter Single Sign-On LDAP identity source. */
export interface PrivateCloudIdentitySource {
  /** Name of the identity source. */
  name: string;
  /** The domain's NetBIOS name. */
  alias?: string;
  /** The domain's DNS name. */
  domain?: string;
  /** Base distinguished name for users. */
  baseUserDN?: string;
  /** Base distinguished name for groups. */
  baseGroupDN?: string;
  /** Primary LDAP server URL. */
  primaryServer?: string;
  /** Secondary LDAP server URL. */
  secondaryServer?: string;
  /** Protect LDAP communication with SSL (LDAPS). */
  ssl?: "Enabled" | "Disabled";
  /** Active Directory user with read access to the base DNs. */
  username?: string;
  /** Password of `username`. Write-only; sent on every identity-source update. */
  password?: Redacted.Redacted<string>;
}

/** Customer-managed key encryption of the private cloud's vSAN datastores. */
export interface PrivateCloudEncryption {
  /** Whether customer-managed key encryption is enabled. */
  status?: "Enabled" | "Disabled";
  /** Name of the Key Vault key. */
  keyName?: string;
  /** Version of the key; omit to auto-detect the latest version. */
  keyVersion?: string;
  /** URL of the Key Vault, e.g. `https://myvault.vault.azure.net/`. */
  keyVaultUrl?: string;
}

/** How a private cloud is distributed across availability zones. */
export interface PrivateCloudAvailability {
  /** Availability strategy. */
  strategy?: "SingleZone" | "DualZone";
  /** Primary availability zone. */
  zone?: number;
  /** Secondary availability zone (stretched clusters only). */
  secondaryZone?: number;
}

export interface PrivateCloudProps {
  /** Resource group the private cloud is created in. Changing it replaces the private cloud. */
  resourceGroup: string;
  /**
   * Name of the private cloud. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the private cloud.
   */
  name?: string;
  /**
   * Azure location. Changing it replaces the private cloud.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Host SKU of the management cluster (`av36`, `av36p`, `av52`, `av64`, ...).
   * Changing it replaces the private cloud.
   * @default "av36p"
   */
  sku?: string;
  /**
   * /22 address block for the management networks. Must not overlap any
   * VNet or on-premises network. Changing it replaces the private cloud.
   */
  networkBlock: string;
  /**
   * Number of hosts in the management cluster (minimum 3).
   * @default 3
   */
  clusterSize?: number;
  /** Internet connectivity of the private cloud. */
  internet?: "Enabled" | "Disabled";
  /** vCenter Single Sign-On identity sources. */
  identitySources?: PrivateCloudIdentitySource[];
  /**
   * Availability strategy (`SingleZone` / `DualZone` stretched clusters).
   * Changing it replaces the private cloud.
   */
  availability?: PrivateCloudAvailability;
  /** Customer-managed key encryption. Requires `identity: "SystemAssigned"`. */
  encryption?: PrivateCloudEncryption;
  /** Additional non-contiguous /22 network blocks. */
  extendedNetworkBlocks?: string[];
  /** Type of DNS zone used by the private cloud. */
  dnsZoneType?: "Public" | "Private";
  /**
   * Azure virtual network ID (Gen 2 private clouds). Changing it replaces
   * the private cloud.
   */
  virtualNetworkId?: string;
  /** Availability zones. Changing them replaces the private cloud. */
  zones?: string[];
  /** Managed identity of the private cloud. */
  identity?: "SystemAssigned" | "None";
  /**
   * vCenter admin password set at creation. Write-only and create-only;
   * rotate it in the portal afterwards.
   */
  vcenterPassword?: Redacted.Redacted<string>;
  /** NSX-T Manager password set at creation. Write-only and create-only. */
  nsxtPassword?: Redacted.Redacted<string>;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

/** vCenter, NSX-T Manager, and HCX endpoints of a private cloud. */
export interface PrivateCloudEndpoints {
  /** vCenter Server Appliance FQDN. */
  vcsa: string | undefined;
  /** NSX-T Manager FQDN. */
  nsxtManager: string | undefined;
  /** HCX Cloud Manager FQDN. */
  hcxCloudManager: string | undefined;
  /** vCenter IP. */
  vcenterIp: string | undefined;
  /** NSX-T Manager IP. */
  nsxtManagerIp: string | undefined;
  /** HCX Cloud Manager IP. */
  hcxCloudManagerIp: string | undefined;
}

/** The ExpressRoute circuit of a private cloud. */
export interface PrivateCloudCircuit {
  /** ExpressRoute circuit ID; pass it to an ExpressRoute authorization. */
  expressRouteId: string | undefined;
  /** ExpressRoute private peering ID. */
  expressRoutePrivatePeeringId: string | undefined;
  /** CIDR of the primary subnet. */
  primarySubnet: string | undefined;
  /** CIDR of the secondary subnet. */
  secondarySubnet: string | undefined;
}

export interface PrivateCloud extends Resource<
  "Azure.VMware.PrivateCloud",
  PrivateCloudProps,
  {
    /** Name of the private cloud. */
    privateCloudName: string;
    /** ARM resource ID of the private cloud. */
    privateCloudId: string;
    /** Resource group of the private cloud. */
    resourceGroup: string;
    /** Location of the private cloud. */
    location: string;
    /** Host SKU of the management cluster. */
    sku: string;
    /** Number of hosts in the management cluster. */
    clusterSize: number | undefined;
    /** The management /22 network block. */
    networkBlock: string;
    /** Internet connectivity. */
    internet: string | undefined;
    /** Provisioning state. */
    provisioningState: string | undefined;
    /** vCenter, NSX-T Manager, and HCX endpoints. */
    endpoints: PrivateCloudEndpoints;
    /** The private cloud's ExpressRoute circuit. */
    circuit: PrivateCloudCircuit;
    /** Network used to reach vCenter and NSX-T Manager. */
    managementNetwork: string | undefined;
    /** Network used for cold migration, cloning, and snapshots. */
    provisioningNetwork: string | undefined;
    /** Network used for vMotion. */
    vmotionNetwork: string | undefined;
    /** Principal ID of the system-assigned identity. */
    principalId: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure VMware Solution private cloud — a dedicated vSphere, vSAN, and
 * NSX-T environment on bare-metal hosts.
 *
 * A private cloud needs at least 3 dedicated hosts (~$8-11 per host-hour),
 * an AVS host quota granted through a support request, and 3-4 hours to
 * provision. Every other `Azure.VMware` resource lives inside one.
 *
 * @see https://learn.microsoft.com/azure/azure-vmware/introduction
 *
 * ### Creating a Private Cloud
 * **Example:** Three-host private cloud
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("avs");
 * const cloud = yield* Azure.VMware.PrivateCloud("cloud", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "av36p",
 *   networkBlock: "10.175.0.0/22",
 *   clusterSize: 3,
 * });
 * ```
 *
 * ### Internet and Identity
 * **Example:** Enable internet access and a system-assigned identity
 * ```typescript
 * const cloud = yield* Azure.VMware.PrivateCloud("cloud", {
 *   resourceGroup: group.resourceGroupName,
 *   networkBlock: "10.175.0.0/22",
 *   internet: "Enabled",
 *   identity: "SystemAssigned",
 * });
 * ```
 *
 * @resource
 */
export const PrivateCloud = Resource<PrivateCloud>("Azure.VMware.PrivateCloud");

type Observed = vmware.GetPrivateCloudResponse;

const createName = (id: string) => createAvsName(id, 64);

const toAttrs = (
  resourceGroup: string,
  name: string,
  cloud: Observed,
): PrivateCloud["Attributes"] => {
  const props = cloud.properties;
  return {
    privateCloudName: name,
    privateCloudId: cloud.id ?? "",
    resourceGroup,
    location: cloud.location,
    sku: cloud.sku?.name ?? "",
    clusterSize: props?.managementCluster?.clusterSize,
    networkBlock: props?.networkBlock ?? "",
    internet: props?.internet,
    provisioningState: props?.provisioningState,
    endpoints: {
      vcsa: props?.endpoints?.vcsa,
      nsxtManager: props?.endpoints?.nsxtManager,
      hcxCloudManager: props?.endpoints?.hcxCloudManager,
      vcenterIp: props?.endpoints?.vcenterIp,
      nsxtManagerIp: props?.endpoints?.nsxtManagerIp,
      hcxCloudManagerIp: props?.endpoints?.hcxCloudManagerIp,
    },
    circuit: {
      expressRouteId: props?.circuit?.expressRouteID,
      expressRoutePrivatePeeringId:
        props?.circuit?.expressRoutePrivatePeeringID,
      primarySubnet: props?.circuit?.primarySubnet,
      secondarySubnet: props?.circuit?.secondarySubnet,
    },
    managementNetwork: props?.managementNetwork,
    provisioningNetwork: props?.provisioningNetwork,
    vmotionNetwork: props?.vmotionNetwork,
    principalId: cloud.identity?.principalId,
    tags: userTags(cloud.tags),
  };
};

const toIdentitySources = (sources: PrivateCloudIdentitySource[]) =>
  sources.map((source) => ({
    ...source,
    password: unredact(source.password),
  }));

/** Identity sources compared without the write-only password. */
const identitySourcesDiffer = (
  observed: ReadonlyArray<vmware.IdentitySource> | undefined,
  desired: ReadonlyArray<PrivateCloudIdentitySource>,
) => {
  const normalize = (
    sources: ReadonlyArray<{
      name?: string;
      alias?: string;
      domain?: string;
      baseUserDN?: string;
      baseGroupDN?: string;
      primaryServer?: string;
      secondaryServer?: string;
      ssl?: string;
      username?: string;
    }>,
  ) =>
    JSON.stringify(
      sources
        .map((s) => ({
          name: s.name ?? "",
          alias: s.alias,
          domain: s.domain,
          baseUserDN: s.baseUserDN,
          baseGroupDN: s.baseGroupDN,
          primaryServer: s.primaryServer,
          secondaryServer: s.secondaryServer,
          ssl: s.ssl,
          username: s.username,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    );
  return normalize(observed ?? []) !== normalize(desired);
};

const encryptionDiffers = (
  observed: vmware.Encryption | undefined,
  desired: PrivateCloudEncryption,
) =>
  (desired.status !== undefined && observed?.status !== desired.status) ||
  (desired.keyName !== undefined &&
    observed?.keyVaultProperties?.keyName !== desired.keyName) ||
  (desired.keyVersion !== undefined &&
    observed?.keyVaultProperties?.keyVersion !== desired.keyVersion) ||
  (desired.keyVaultUrl !== undefined &&
    !sameName(observed?.keyVaultProperties?.keyVaultUrl, desired.keyVaultUrl));

const toEncryption = (encryption: PrivateCloudEncryption) => ({
  status: encryption.status,
  keyVaultProperties:
    encryption.keyName !== undefined || encryption.keyVaultUrl !== undefined
      ? {
          keyName: encryption.keyName,
          keyVersion: encryption.keyVersion,
          keyVaultUrl: encryption.keyVaultUrl,
        }
      : undefined,
});

export const PrivateCloudProvider = () =>
  Provider.succeed(PrivateCloud, {
    stables: [
      "privateCloudName",
      "privateCloudId",
      "resourceGroup",
      "location",
      "networkBlock",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* vmware
        .ListPrivateCloudInSubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListPrivateCloudInSubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((cloud) => {
        const group = resourceGroupOf(cloud.id);
        return hasAnyAlchemyTag(cloud.tags) &&
          group !== undefined &&
          cloud.name !== undefined
          ? [toAttrs(group, cloud.name, cloud)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.privateCloudName) ||
        (news.location !== undefined &&
          !sameName(news.location, output.location)) ||
        !sameName(news.sku ?? "av36p", output.sku) ||
        news.networkBlock !== output.networkBlock ||
        !sameName(news.virtualNetworkId, olds?.virtualNetworkId) ||
        JSON.stringify(news.availability ?? {}) !==
          JSON.stringify(olds?.availability ?? {}) ||
        !sameSet(news.zones, olds?.zones)
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
        output?.privateCloudName ?? olds?.name ?? (yield* createName(id));
      const observed = yield* getPrivateCloud(
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
      yield* ensureRegistered(subscriptionId, AVS_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.privateCloudName ?? (yield* createName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        privateCloudName: name,
      };
      const get = getPrivateCloud(subscriptionId, resourceGroup, name);
      const wait = () =>
        waitForProvisioned(
          `AVS private cloud ${name}`,
          get,
          (cloud) => cloud.properties?.provisioningState,
          PRIVATE_CLOUD_BUDGET,
        );

      // Observe.
      let observed = yield* get;

      // Ensure. Creation provisions dedicated hosts and takes hours.
      if (observed === undefined) {
        yield* vmware.PrivateCloudsCreateOrUpdate({
          ...where,
          location,
          tags,
          sku: { name: news.sku ?? "av36p" },
          zones: news.zones,
          identity: news.identity ? { type: news.identity } : undefined,
          properties: {
            networkBlock: news.networkBlock,
            managementCluster: { clusterSize: news.clusterSize ?? 3 },
            internet: news.internet,
            identitySources: news.identitySources
              ? toIdentitySources(news.identitySources)
              : undefined,
            availability: news.availability,
            encryption: news.encryption
              ? toEncryption(news.encryption)
              : undefined,
            extendedNetworkBlocks: news.extendedNetworkBlocks,
            dnsZoneType: news.dnsZoneType,
            virtualNetworkId: news.virtualNetworkId,
            vcenterPassword: unredact(news.vcenterPassword),
            nsxtPassword: unredact(news.nsxtPassword),
          },
        });
      }
      observed = yield* wait();

      // Sync each mutable aspect against observed state; PATCH only deltas.
      const props = observed.properties;
      const changed: vmware.PrivateCloudUpdatePropertiesInput = {};
      const clusterSize = news.clusterSize ?? 3;
      if (props?.managementCluster?.clusterSize !== clusterSize) {
        changed.managementCluster = { clusterSize };
      }
      if (news.internet !== undefined && props?.internet !== news.internet) {
        changed.internet = news.internet;
      }
      if (
        news.identitySources !== undefined &&
        identitySourcesDiffer(props?.identitySources, news.identitySources)
      ) {
        changed.identitySources = toIdentitySources(news.identitySources);
      }
      if (
        news.encryption !== undefined &&
        encryptionDiffers(props?.encryption, news.encryption)
      ) {
        changed.encryption = toEncryption(news.encryption);
      }
      if (
        news.extendedNetworkBlocks !== undefined &&
        !sameSet(props?.extendedNetworkBlocks, news.extendedNetworkBlocks)
      ) {
        changed.extendedNetworkBlocks = news.extendedNetworkBlocks;
      }
      if (
        news.dnsZoneType !== undefined &&
        props?.dnsZoneType !== news.dnsZoneType
      ) {
        changed.dnsZoneType = news.dnsZoneType;
      }
      const identityChanged =
        news.identity !== undefined &&
        (observed.identity?.type ?? "None") !== news.identity;
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (Object.keys(changed).length > 0 || identityChanged || tagsChanged) {
        yield* vmware.UpdatePrivateCloud({
          ...where,
          tags: tagsChanged ? tags : undefined,
          identity:
            identityChanged && news.identity
              ? { type: news.identity }
              : undefined,
          properties: Object.keys(changed).length > 0 ? changed : undefined,
        });
        observed = yield* wait();
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        vmware.DeletePrivateCloud({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          privateCloudName: output.privateCloudName,
        }),
      );
      yield* waitUntilGone(
        `AVS private cloud ${output.privateCloudName}`,
        getPrivateCloud(
          subscriptionId,
          output.resourceGroup,
          output.privateCloudName,
        ),
        PRIVATE_CLOUD_BUDGET,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
