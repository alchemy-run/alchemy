import * as compute from "@distilled.cloud/azure/compute";
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
  orUndefinedIfNotFound,
  requireSinglePage,
  resourceGroupOf,
  tagsDiffer,
  userTags,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  canonical,
  createComputeName,
  ref,
  sameId,
  sameSet,
  waitComputeGone,
  waitComputeProvisioned,
  whileComputeBusy,
} from "./common.ts";
import type {
  VirtualMachineIdentity,
  VirtualMachineImage,
} from "./VirtualMachine.ts";

export interface VirtualMachineScaleSetProps {
  /**
   * Resource group the scale set is created in. Changing it replaces the
   * scale set.
   */
  resourceGroup: string;
  /**
   * Name of the scale set: 1-64 letters, digits, `.`, `_`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the scale set.
   */
  name?: string;
  /**
   * Azure location of the scale set. Changing it replaces the scale set.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Availability zones to spread instances over. Changing them replaces the
   * scale set.
   */
  zones?: string[];
  /**
   * Orchestration mode. `Flexible` instances are regular VMs; `Uniform`
   * instances are identical, scale-set-managed VMs. Changing it replaces the
   * scale set.
   * @default "Flexible"
   */
  orchestrationMode?: "Flexible" | "Uniform";
  /**
   * Fault domain count. Changing it replaces the scale set.
   * @default 1
   */
  platformFaultDomainCount?: number;
  /**
   * ARM ID of a proximity placement group. Changing it replaces the scale
   * set.
   */
  proximityPlacementGroupId?: string;
  /**
   * VM size of the instances. A change updates the scale set model;
   * existing instances pick it up on upgrade (`upgradePolicyMode`).
   */
  vmSize: string;
  /**
   * Number of instances. Scaling happens in place.
   * @default 1
   */
  capacity?: number;
  /**
   * How model changes roll out to existing instances.
   * @default "Manual"
   */
  upgradePolicyMode?: "Manual" | "Automatic" | "Rolling";
  /**
   * OS image. Changing it replaces the scale set.
   * @default Ubuntu 24.04 LTS (`Canonical` / `ubuntu-24_04-lts` / `server` / `latest`)
   */
  image?: VirtualMachineImage;
  /**
   * Storage type of the instances' managed OS disks. Changing it replaces
   * the scale set.
   * @default "Standard_LRS"
   */
  osDiskStorageAccountType?:
    | "Standard_LRS"
    | "StandardSSD_LRS"
    | "Premium_LRS"
    | "StandardSSD_ZRS"
    | "Premium_ZRS";
  /**
   * ARM ID of the subnet the instances' primary NIC joins. Changing it
   * replaces the scale set.
   */
  subnetId: string;
  /**
   * ARM ID of a network security group for the instances' NICs. Changing
   * it replaces the scale set.
   */
  networkSecurityGroupId?: string;
  /**
   * ARM IDs of load balancer backend pools the instances join. Changing
   * them replaces the scale set.
   */
  loadBalancerBackendAddressPoolIds?: string[];
  /**
   * Administrator user name. Changing it replaces the scale set.
   */
  adminUsername: string;
  /**
   * Administrator password (required for Windows). Changing it replaces the
   * scale set.
   */
  adminPassword?: Redacted.Redacted<string>;
  /**
   * OpenSSH public keys authorised for `adminUsername` (Linux). Changing
   * them replaces the scale set.
   */
  sshPublicKeys?: string[];
  /**
   * Prefix of the instances' host names (Windows: at most 9 characters).
   * Changing it replaces the scale set.
   * @default the first 9 characters of the scale set name
   */
  computerNamePrefix?: string;
  /**
   * Base64-encoded custom data (cloud-init). Changing it replaces the scale
   * set.
   */
  customData?: string;
  /**
   * Enable boot diagnostics with managed storage. Updated in place.
   * @default false
   */
  bootDiagnostics?: boolean;
  /**
   * Managed identities of the instances. Updated in place.
   */
  identity?: VirtualMachineIdentity;
  /**
   * Instance priority. Changing it replaces the scale set.
   * @default "Regular"
   */
  priority?: "Regular" | "Spot" | "Low";
  /**
   * What happens to evicted Spot instances. Changing it replaces the scale
   * set.
   */
  evictionPolicy?: "Deallocate" | "Delete";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface VirtualMachineScaleSet extends Resource<
  "Azure.Compute.VirtualMachineScaleSet",
  VirtualMachineScaleSetProps,
  {
    /** Name of the scale set. */
    virtualMachineScaleSetName: string;
    /** ARM resource ID of the scale set. */
    virtualMachineScaleSetId: string;
    /** Immutable unique ID Azure assigned to the scale set. */
    uniqueId: string | undefined;
    /** Resource group that holds the scale set. */
    resourceGroup: string;
    /** Location of the scale set. */
    location: string;
    /** Zones of the scale set. */
    zones: string[];
    /** Orchestration mode. */
    orchestrationMode: string | undefined;
    /** VM size of the instances. */
    vmSize: string | undefined;
    /** Number of instances. */
    capacity: number | undefined;
    /** Principal ID of the system-assigned identity, if enabled. */
    principalId: string | undefined;
    /** Creation time (ISO 8601). */
    timeCreated: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure virtual machine scale set — a group of load-balanced VMs whose
 * instance count scales in place. Instances' OS disks and NICs are deleted
 * with the scale set.
 *
 * Model changes (size, profile) apply to new instances; existing
 * instances follow the `upgradePolicyMode`.
 *
 * @see https://learn.microsoft.com/azure/virtual-machine-scale-sets/overview
 *
 * ### Creating a Scale Set
 * **Example:** Flexible scale set with two Linux instances
 * ```typescript
 * const scaleSet = yield* Azure.Compute.VirtualMachineScaleSet("web", {
 *   resourceGroup: group.resourceGroupName,
 *   vmSize: "Standard_B1s",
 *   capacity: 2,
 *   subnetId: subnet.subnetId,
 *   adminUsername: "azureuser",
 *   sshPublicKeys: [publicKey],
 * });
 * ```
 *
 * ### Behind a Load Balancer
 * **Example:** Instances in a load balancer backend pool
 * ```typescript
 * const scaleSet = yield* Azure.Compute.VirtualMachineScaleSet("web", {
 *   resourceGroup: group.resourceGroupName,
 *   vmSize: "Standard_B2s",
 *   capacity: 3,
 *   zones: ["1", "2", "3"],
 *   subnetId: subnet.subnetId,
 *   loadBalancerBackendAddressPoolIds: [lb.backendAddressPoolIds[0]],
 *   adminUsername: "azureuser",
 *   sshPublicKeys: [publicKey],
 *   upgradePolicyMode: "Automatic",
 * });
 * ```
 *
 * ### Uniform Orchestration
 * **Example:** Uniform scale set of Spot instances
 * ```typescript
 * const batch = yield* Azure.Compute.VirtualMachineScaleSet("batch", {
 *   resourceGroup: group.resourceGroupName,
 *   orchestrationMode: "Uniform",
 *   vmSize: "Standard_D2s_v5",
 *   capacity: 4,
 *   priority: "Spot",
 *   evictionPolicy: "Delete",
 *   subnetId: subnet.subnetId,
 *   adminUsername: "azureuser",
 *   sshPublicKeys: [publicKey],
 * });
 * ```
 *
 * @resource
 */
export const VirtualMachineScaleSet = Resource<VirtualMachineScaleSet>(
  "Azure.Compute.VirtualMachineScaleSet",
);

type Observed = compute.GetVirtualMachineScaleSetResponse;

const DEFAULT_IMAGE = {
  publisher: "Canonical",
  offer: "ubuntu-24_04-lts",
  sku: "server",
  version: "latest",
} as const;

const getScaleSet = (
  subscriptionId: string,
  resourceGroupName: string,
  vmScaleSetName: string,
) =>
  orUndefinedIfNotFound(
    compute.GetVirtualMachineScaleSet({
      subscriptionId,
      resourceGroupName,
      vmScaleSetName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  set: Observed,
): VirtualMachineScaleSet["Attributes"] => ({
  virtualMachineScaleSetName: name,
  virtualMachineScaleSetId: set.id ?? "",
  uniqueId: set.properties?.uniqueId,
  resourceGroup,
  location: set.location,
  zones: [...(set.zones ?? [])],
  orchestrationMode: set.properties?.orchestrationMode,
  vmSize: set.sku?.name,
  capacity: set.sku?.capacity,
  principalId: set.identity?.principalId,
  timeCreated: set.properties?.timeCreated,
  tags: userTags(set.tags),
});

const identityInput = (
  identity: VirtualMachineIdentity | undefined,
): compute.VirtualMachineScaleSetIdentityInput | undefined => {
  if (identity === undefined) return undefined;
  const system = identity.systemAssigned ?? false;
  const users = identity.userAssignedIdentityIds ?? [];
  return {
    type:
      system && users.length > 0
        ? "SystemAssigned, UserAssigned"
        : system
          ? "SystemAssigned"
          : users.length > 0
            ? "UserAssigned"
            : "None",
    userAssignedIdentities:
      users.length > 0
        ? Object.fromEntries(users.map((userId) => [userId, {}]))
        : undefined,
  };
};

const identityKey = (
  type: string | undefined,
  userIds: ReadonlyArray<string>,
) =>
  canonical({
    system: (type ?? "None").includes("SystemAssigned"),
    users: userIds.map((id) => id.toLowerCase()).sort(),
  });

const imageReference = (
  image: VirtualMachineImage | undefined,
): compute.ImageReferenceInput => {
  const value = image ?? DEFAULT_IMAGE;
  return "id" in value
    ? { id: value.id }
    : {
        publisher: value.publisher,
        offer: value.offer,
        sku: value.sku,
        version: value.version ?? "latest",
      };
};

/** Immutable-after-create inputs that Azure does not echo back verbatim. */
const immutableKey = (p: VirtualMachineScaleSetProps) =>
  canonical({
    image: imageReference(p.image),
    osDiskStorageAccountType: p.osDiskStorageAccountType ?? "Standard_LRS",
    subnetId: p.subnetId.toLowerCase(),
    networkSecurityGroupId: p.networkSecurityGroupId?.toLowerCase(),
    pools: (p.loadBalancerBackendAddressPoolIds ?? [])
      .map((id) => id.toLowerCase())
      .sort(),
    adminUsername: p.adminUsername,
    sshPublicKeys: p.sshPublicKeys ?? [],
    computerNamePrefix: p.computerNamePrefix,
    customData: p.customData,
    priority: p.priority ?? "Regular",
    evictionPolicy: p.evictionPolicy,
    platformFaultDomainCount: p.platformFaultDomainCount ?? 1,
    proximityPlacementGroupId: p.proximityPlacementGroupId?.toLowerCase(),
    hasPassword: p.adminPassword !== undefined,
  });

export const VirtualMachineScaleSetProvider = () =>
  Provider.succeed(VirtualMachineScaleSet, {
    stables: [
      "virtualMachineScaleSetName",
      "virtualMachineScaleSetId",
      "uniqueId",
      "resourceGroup",
      "location",
      "timeCreated",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* compute
        .ListVirtualMachineScaleSetAll({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListVirtualMachineScaleSetAll", page),
          ),
        );
      return page.value.flatMap((set) => {
        const resourceGroup = resourceGroupOf(set.id);
        return hasAnyAlchemyTag(set.tags) &&
          resourceGroup !== undefined &&
          set.name !== undefined
          ? [toAttrs(resourceGroup, set.name, set)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameId(news.name, output.virtualMachineScaleSetName)) ||
        (news.location !== undefined &&
          !sameId(news.location, output.location)) ||
        !sameSet(news.zones, output.zones) ||
        !sameId(
          news.orchestrationMode ?? "Flexible",
          output.orchestrationMode ?? "Flexible",
        ) ||
        (olds !== undefined && immutableKey(news) !== immutableKey(olds))
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
        output?.virtualMachineScaleSetName ??
        olds?.name ??
        (yield* createComputeName(id, 64));
      const observed = yield* getScaleSet(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.Compute");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.virtualMachineScaleSetName ??
        (yield* createComputeName(id, 64));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const capacity = news.capacity ?? 1;
      const flexible = (news.orchestrationMode ?? "Flexible") === "Flexible";
      const upgradeMode = news.upgradePolicyMode ?? "Manual";
      const bootDiagnostics = news.bootDiagnostics ?? false;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        vmScaleSetName: name,
      };
      const label = `virtual machine scale set ${name}`;
      const get = getScaleSet(subscriptionId, resourceGroup, name);
      const wait = waitComputeProvisioned(label, get, {
        interval: "5 seconds",
        times: 150,
      });

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        const sshKeys = news.sshPublicKeys ?? [];
        yield* compute
          .VirtualMachineScaleSetsCreateOrUpdate({
            ...where,
            location,
            tags,
            zones: news.zones,
            sku: { name: news.vmSize, capacity },
            identity: identityInput(news.identity),
            properties: {
              orchestrationMode: news.orchestrationMode ?? "Flexible",
              platformFaultDomainCount: news.platformFaultDomainCount ?? 1,
              singlePlacementGroup: flexible ? undefined : false,
              overprovision: flexible ? undefined : false,
              upgradePolicy: { mode: upgradeMode },
              proximityPlacementGroup: ref(news.proximityPlacementGroupId),
              virtualMachineProfile: {
                osProfile: {
                  computerNamePrefix:
                    news.computerNamePrefix ??
                    name.replace(/[^a-zA-Z0-9-]/g, "").slice(0, 9),
                  adminUsername: news.adminUsername,
                  adminPassword: news.adminPassword,
                  customData: news.customData,
                  linuxConfiguration:
                    sshKeys.length > 0
                      ? {
                          disablePasswordAuthentication:
                            news.adminPassword === undefined,
                          ssh: {
                            publicKeys: sshKeys.map((keyData) => ({
                              path: `/home/${news.adminUsername}/.ssh/authorized_keys`,
                              keyData,
                            })),
                          },
                        }
                      : undefined,
                },
                storageProfile: {
                  imageReference: imageReference(news.image),
                  osDisk: {
                    createOption: "FromImage",
                    deleteOption: flexible ? "Delete" : undefined,
                    managedDisk: {
                      storageAccountType:
                        news.osDiskStorageAccountType ?? "Standard_LRS",
                    },
                  },
                },
                networkProfile: {
                  networkApiVersion: flexible ? "2020-11-01" : undefined,
                  networkInterfaceConfigurations: [
                    {
                      name: "nic",
                      properties: {
                        primary: true,
                        deleteOption: flexible ? "Delete" : undefined,
                        networkSecurityGroup: ref(news.networkSecurityGroupId),
                        ipConfigurations: [
                          {
                            name: "ipconfig",
                            properties: {
                              primary: true,
                              subnet: { id: news.subnetId },
                              loadBalancerBackendAddressPools:
                                news.loadBalancerBackendAddressPoolIds?.map(
                                  (poolId) => ({ id: poolId }),
                                ),
                            },
                          },
                        ],
                      },
                    },
                  ],
                },
                diagnosticsProfile: {
                  bootDiagnostics: { enabled: bootDiagnostics },
                },
                priority: news.priority,
                evictionPolicy: news.evictionPolicy,
              },
            },
          })
          .pipe(Effect.retry(whileComputeBusy));
      }
      observed = yield* wait;

      // Sync each mutable aspect against observed state; PATCH only deltas.
      const skuChanged =
        observed.sku?.name !== news.vmSize ||
        observed.sku?.capacity !== capacity;
      const properties: compute.VirtualMachineScaleSetUpdatePropertiesInput =
        {};
      if (!sameId(observed.properties?.upgradePolicy?.mode, upgradeMode)) {
        properties.upgradePolicy = { mode: upgradeMode };
      }
      if (
        (observed.properties?.virtualMachineProfile?.diagnosticsProfile
          ?.bootDiagnostics?.enabled ?? false) !== bootDiagnostics
      ) {
        properties.virtualMachineProfile = {
          diagnosticsProfile: { bootDiagnostics: { enabled: bootDiagnostics } },
        };
      }
      const desiredIdentity = identityInput(news.identity);
      const identityChanged =
        desiredIdentity !== undefined &&
        identityKey(
          observed.identity?.type,
          Object.keys(observed.identity?.userAssignedIdentities ?? {}),
        ) !==
          identityKey(
            desiredIdentity.type,
            news.identity?.userAssignedIdentityIds ?? [],
          );
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (
        skuChanged ||
        Object.keys(properties).length > 0 ||
        identityChanged ||
        tagsChanged
      ) {
        yield* compute
          .UpdateVirtualMachineScaleSet({
            ...where,
            sku: skuChanged ? { name: news.vmSize, capacity } : undefined,
            tags: tagsChanged ? tags : undefined,
            identity: identityChanged ? desiredIdentity : undefined,
            properties:
              Object.keys(properties).length > 0 ? properties : undefined,
          })
          .pipe(Effect.retry(whileComputeBusy));
        observed = yield* wait;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        compute.DeleteVirtualMachineScaleSet({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          vmScaleSetName: output.virtualMachineScaleSetName,
        }),
      ).pipe(Effect.retry(whileComputeBusy));
      yield* waitComputeGone(
        `virtual machine scale set ${output.virtualMachineScaleSetName}`,
        getScaleSet(
          subscriptionId,
          output.resourceGroup,
          output.virtualMachineScaleSetName,
        ),
        { interval: "5 seconds", times: 150 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.Compute.ProximityPlacementGroup",
      ],
    },
  });
