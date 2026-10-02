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

/** A platform (marketplace) image, or a custom image / gallery image by ID. */
export type VirtualMachineImage =
  | {
      /** Image publisher, e.g. `Canonical`. */
      publisher: string;
      /** Image offer, e.g. `ubuntu-24_04-lts`. */
      offer: string;
      /** Image SKU, e.g. `server`. */
      sku: string;
      /**
       * Image version.
       * @default "latest"
       */
      version?: string;
    }
  | {
      /** ARM ID of a managed image or a Compute Gallery image (version). */
      id: string;
    };

export interface VirtualMachineIdentity {
  /** Enable the system-assigned managed identity. */
  systemAssigned?: boolean;
  /** ARM IDs of user-assigned managed identities to attach. */
  userAssignedIdentityIds?: string[];
}

export interface VirtualMachineProps {
  /**
   * Resource group the VM is created in. Changing it replaces the VM.
   */
  resourceGroup: string;
  /**
   * Name of the VM: 1-64 letters, digits, `.`, `_`, and `-`. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the VM.
   */
  name?: string;
  /**
   * Azure location of the VM; the NICs must be in the same location.
   * Changing it replaces the VM.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Availability zone(s) to place the VM in. Changing them replaces the VM.
   */
  zones?: string[];
  /**
   * VM size, e.g. `Standard_B1s` or `Standard_D2s_v5`. Resizing happens in
   * place; Azure restarts the VM, and fails with `OperationNotAllowed` if
   * the new size is not available on the current hardware cluster. A size
   * without capacity in the region fails with `SkuNotAvailable`.
   */
  vmSize: string;
  /**
   * OS image. Changing it replaces the VM.
   * @default Ubuntu 24.04 LTS (`Canonical` / `ubuntu-24_04-lts` / `server` / `latest`)
   */
  image?: VirtualMachineImage;
  /**
   * Storage type of the managed OS disk. Changing it replaces the VM.
   * @default "Standard_LRS"
   */
  osDiskStorageAccountType?:
    | "Standard_LRS"
    | "StandardSSD_LRS"
    | "Premium_LRS"
    | "StandardSSD_ZRS"
    | "Premium_ZRS";
  /**
   * Size of the OS disk in GiB. Changing it replaces the VM.
   * @default the image's disk size
   */
  osDiskSizeGB?: number;
  /**
   * ARM IDs of the network interfaces; the first is primary. Changing them
   * replaces the VM. NICs are detached, not deleted, with the VM. A VM is
   * always replaced delete-first, since its NICs cannot be shared.
   */
  networkInterfaceIds: string[];
  /**
   * Administrator user name. Changing it replaces the VM.
   */
  adminUsername: string;
  /**
   * Administrator password. Required for Windows; for Linux, set it to
   * enable password login. Changing it replaces the VM.
   */
  adminPassword?: Redacted.Redacted<string>;
  /**
   * OpenSSH public keys authorised for `adminUsername` (Linux). When set
   * and no `adminPassword` is given, password login is disabled. Changing
   * them replaces the VM.
   */
  sshPublicKeys?: string[];
  /**
   * Host name of the VM (Windows: at most 15 characters). Changing it
   * replaces the VM.
   * @default the VM name
   */
  computerName?: string;
  /**
   * Base64-encoded custom data (cloud-init) passed at provisioning.
   * Changing it replaces the VM.
   */
  customData?: string;
  /**
   * Base64-encoded user data available to the VM through the instance
   * metadata service. Updated in place.
   */
  userData?: string;
  /**
   * Enable boot diagnostics with managed storage. Updated in place.
   * @default false
   */
  bootDiagnostics?: boolean;
  /**
   * Managed identities of the VM. Updated in place.
   */
  identity?: VirtualMachineIdentity;
  /**
   * Security type. Changing it replaces the VM.
   * @default Azure's default for the image (`TrustedLaunch` for Gen2 images)
   */
  securityType?: "TrustedLaunch" | "ConfidentialVM" | "Standard";
  /**
   * ARM ID of an availability set to place the VM in. Changing it replaces
   * the VM.
   */
  availabilitySetId?: string;
  /**
   * ARM ID of a proximity placement group. Changing it replaces the VM.
   */
  proximityPlacementGroupId?: string;
  /**
   * ARM ID of a dedicated host to place the VM on. Changing it replaces
   * the VM.
   */
  hostId?: string;
  /**
   * ARM ID of a dedicated host group with automatic placement. Changing it
   * replaces the VM.
   */
  hostGroupId?: string;
  /**
   * ARM ID of a capacity reservation group to draw capacity from. Changing
   * it replaces the VM.
   */
  capacityReservationGroupId?: string;
  /**
   * Priority: `Spot` VMs are cheap but can be evicted. Changing it replaces
   * the VM.
   * @default "Regular"
   */
  priority?: "Regular" | "Spot" | "Low";
  /**
   * What happens to an evicted Spot VM. Changing it replaces the VM.
   * @default "Deallocate" for Spot VMs
   */
  evictionPolicy?: "Deallocate" | "Delete";
  /**
   * Maximum hourly price for a Spot VM in USD; `-1` means up to the
   * on-demand price. Updated in place.
   */
  maxPrice?: number;
  /**
   * Azure Hybrid Benefit license type (e.g. `Windows_Server`,
   * `RHEL_BYOS`). Updated in place.
   */
  licenseType?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface VirtualMachine extends Resource<
  "Azure.Compute.VirtualMachine",
  VirtualMachineProps,
  {
    /** Name of the VM. */
    virtualMachineName: string;
    /** ARM resource ID of the VM. */
    virtualMachineId: string;
    /** Immutable GUID Azure assigned to the VM (`vmId`). */
    vmId: string | undefined;
    /** Resource group that holds the VM. */
    resourceGroup: string;
    /** Location of the VM. */
    location: string;
    /** Zones the VM is placed in. */
    zones: string[];
    /** VM size. */
    vmSize: string | undefined;
    /** Host name of the VM. */
    computerName: string | undefined;
    /** Name of the managed OS disk. */
    osDiskName: string | undefined;
    /** ARM ID of the managed OS disk. */
    osDiskId: string | undefined;
    /** ARM IDs of the attached network interfaces. */
    networkInterfaceIds: string[];
    /** Principal ID of the system-assigned identity, if enabled. */
    principalId: string | undefined;
    /** Tenant ID of the system-assigned identity, if enabled. */
    tenantId: string | undefined;
    /** Creation time (ISO 8601). */
    timeCreated: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure virtual machine with a managed OS disk.
 *
 * The OS disk is deleted with the VM; network interfaces are only detached
 * (create them with `Azure.Network.NetworkInterface`). The VM is ready when
 * the deploy returns (`provisioningState: Succeeded`).
 *
 * @see https://learn.microsoft.com/azure/virtual-machines/overview
 *
 * ### Creating a Linux VM
 * **Example:** Ubuntu VM with SSH key authentication
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const vnet = yield* Azure.Network.VirtualNetwork("vnet", {
 *   resourceGroup: group.resourceGroupName,
 *   addressPrefixes: ["10.0.0.0/16"],
 * });
 * const subnet = yield* Azure.Network.Subnet("vms", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.1.0/24",
 * });
 * const nic = yield* Azure.Network.NetworkInterface("web", {
 *   resourceGroup: group.resourceGroupName,
 *   ipConfigurations: [{ subnetId: subnet.subnetId }],
 * });
 * const vm = yield* Azure.Compute.VirtualMachine("web", {
 *   resourceGroup: group.resourceGroupName,
 *   vmSize: "Standard_B1s",
 *   networkInterfaceIds: [nic.networkInterfaceId],
 *   adminUsername: "azureuser",
 *   sshPublicKeys: ["ssh-ed25519 AAAAC3Nza... me@example.com"],
 * });
 * ```
 *
 * ### Choosing an Image
 * **Example:** Debian 12 on Premium SSD
 * ```typescript
 * const vm = yield* Azure.Compute.VirtualMachine("db", {
 *   resourceGroup: group.resourceGroupName,
 *   vmSize: "Standard_D2s_v5",
 *   image: { publisher: "Debian", offer: "debian-12", sku: "12-gen2" },
 *   osDiskStorageAccountType: "Premium_LRS",
 *   networkInterfaceIds: [nic.networkInterfaceId],
 *   adminUsername: "azureuser",
 *   sshPublicKeys: [publicKey],
 * });
 * ```
 *
 * ### Identity and Diagnostics
 * **Example:** System-assigned identity with boot diagnostics
 * ```typescript
 * const vm = yield* Azure.Compute.VirtualMachine("worker", {
 *   resourceGroup: group.resourceGroupName,
 *   vmSize: "Standard_B1s",
 *   networkInterfaceIds: [nic.networkInterfaceId],
 *   adminUsername: "azureuser",
 *   sshPublicKeys: [publicKey],
 *   identity: { systemAssigned: true },
 *   bootDiagnostics: true,
 * });
 * // grant vm.principalId access with Azure.Authorization.RoleAssignment
 * ```
 *
 * ### Spot VMs
 * **Example:** Spot VM that is deallocated on eviction
 * ```typescript
 * const vm = yield* Azure.Compute.VirtualMachine("batch", {
 *   resourceGroup: group.resourceGroupName,
 *   vmSize: "Standard_D2s_v5",
 *   networkInterfaceIds: [nic.networkInterfaceId],
 *   adminUsername: "azureuser",
 *   sshPublicKeys: [publicKey],
 *   priority: "Spot",
 *   evictionPolicy: "Deallocate",
 *   maxPrice: -1,
 * });
 * ```
 *
 * @resource
 */
export const VirtualMachine = Resource<VirtualMachine>(
  "Azure.Compute.VirtualMachine",
);

type Observed = compute.GetVirtualMachineResponse;

const DEFAULT_IMAGE = {
  publisher: "Canonical",
  offer: "ubuntu-24_04-lts",
  sku: "server",
  version: "latest",
} as const;

const getVm = (
  subscriptionId: string,
  resourceGroupName: string,
  vmName: string,
) =>
  orUndefinedIfNotFound(
    compute.GetVirtualMachine({ subscriptionId, resourceGroupName, vmName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  vm: Observed,
): VirtualMachine["Attributes"] => {
  const p = vm.properties;
  return {
    virtualMachineName: name,
    virtualMachineId: vm.id ?? "",
    vmId: p?.vmId,
    resourceGroup,
    location: vm.location,
    zones: [...(vm.zones ?? [])],
    vmSize: p?.hardwareProfile?.vmSize,
    computerName: p?.osProfile?.computerName,
    osDiskName: p?.storageProfile?.osDisk?.name,
    osDiskId: p?.storageProfile?.osDisk?.managedDisk?.id,
    networkInterfaceIds: (p?.networkProfile?.networkInterfaces ?? []).flatMap(
      (nic) => (nic.id ? [nic.id] : []),
    ),
    principalId: vm.identity?.principalId,
    tenantId: vm.identity?.tenantId,
    timeCreated: p?.timeCreated,
    tags: userTags(vm.tags),
  };
};

const identityInput = (
  identity: VirtualMachineIdentity | undefined,
): compute.VirtualMachineIdentityInput | undefined => {
  if (identity === undefined) return undefined;
  const system = identity.systemAssigned ?? false;
  const users = identity.userAssignedIdentityIds ?? [];
  const type =
    system && users.length > 0
      ? "SystemAssigned, UserAssigned"
      : system
        ? "SystemAssigned"
        : users.length > 0
          ? "UserAssigned"
          : "None";
  return {
    type,
    userAssignedIdentities:
      users.length > 0
        ? Object.fromEntries(users.map((userId) => [userId, {}]))
        : undefined,
  };
};

/** Normalised identity for observed-vs-desired comparison. */
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

/**
 * VMs are replaced delete-first: the replacement attaches the same network
 * interfaces, and a NIC belongs to at most one VM.
 */
const REPLACE = { action: "replace", deleteFirst: true } as const;

export const VirtualMachineProvider = () =>
  Provider.succeed(VirtualMachine, {
    stables: [
      "virtualMachineName",
      "virtualMachineId",
      "vmId",
      "resourceGroup",
      "location",
      "osDiskName",
      "osDiskId",
      "timeCreated",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* compute
        .ListVirtualMachineAll({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListVirtualMachineAll", page),
          ),
        );
      return page.value.flatMap((vm) => {
        const resourceGroup = resourceGroupOf(vm.id);
        return hasAnyAlchemyTag(vm.tags) &&
          resourceGroup !== undefined &&
          vm.name !== undefined
          ? [toAttrs(resourceGroup, vm.name, vm)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameId(news.name, output.virtualMachineName)) ||
        (news.location !== undefined &&
          !sameId(news.location, output.location)) ||
        !sameSet(news.zones, output.zones) ||
        !sameSet(news.networkInterfaceIds, output.networkInterfaceIds) ||
        (news.computerName !== undefined &&
          news.computerName !== output.computerName)
      ) {
        return REPLACE;
      }
      // Immutable-after-create inputs that Azure does not echo back.
      const immutable = (p: VirtualMachineProps) =>
        canonical({
          image: imageReference(p.image),
          osDiskStorageAccountType:
            p.osDiskStorageAccountType ?? "Standard_LRS",
          osDiskSizeGB: p.osDiskSizeGB,
          adminUsername: p.adminUsername,
          sshPublicKeys: p.sshPublicKeys ?? [],
          customData: p.customData,
          securityType: p.securityType,
          availabilitySetId: p.availabilitySetId?.toLowerCase(),
          proximityPlacementGroupId: p.proximityPlacementGroupId?.toLowerCase(),
          hostId: p.hostId?.toLowerCase(),
          hostGroupId: p.hostGroupId?.toLowerCase(),
          capacityReservationGroupId:
            p.capacityReservationGroupId?.toLowerCase(),
          priority: p.priority ?? "Regular",
          evictionPolicy: p.evictionPolicy,
        });
      if (olds !== undefined && immutable(news) !== immutable(olds)) {
        return REPLACE;
      }
      if (
        olds !== undefined &&
        (news.adminPassword === undefined) !==
          (olds.adminPassword === undefined)
      ) {
        return REPLACE;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.virtualMachineName ??
        olds?.name ??
        (yield* createComputeName(id, 64));
      const observed = yield* getVm(subscriptionId, resourceGroup, name);
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
        output?.virtualMachineName ??
        (yield* createComputeName(id, 64));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const vmSize = news.vmSize;
      const bootDiagnostics = news.bootDiagnostics ?? false;
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        vmName: name,
      };
      const label = `virtual machine ${name}`;
      const get = getVm(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure. The PUT returns 201 and provisioning continues in the
      // background; poll until the VM reports Succeeded.
      if (observed === undefined) {
        const sshKeys = news.sshPublicKeys ?? [];
        yield* compute
          .VirtualMachinesCreateOrUpdate({
            ...where,
            location,
            tags,
            zones: news.zones,
            identity: identityInput(news.identity),
            properties: {
              hardwareProfile: { vmSize },
              storageProfile: {
                imageReference: imageReference(news.image),
                osDisk: {
                  createOption: "FromImage",
                  deleteOption: "Delete",
                  diskSizeGB: news.osDiskSizeGB,
                  managedDisk: {
                    storageAccountType:
                      news.osDiskStorageAccountType ?? "Standard_LRS",
                  },
                },
              },
              osProfile: {
                computerName: news.computerName ?? name,
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
              networkProfile: {
                networkInterfaces: news.networkInterfaceIds.map(
                  (nicId, index) => ({
                    id: nicId,
                    properties: {
                      primary: index === 0,
                      deleteOption: "Detach",
                    },
                  }),
                ),
              },
              securityProfile:
                news.securityType === undefined
                  ? undefined
                  : { securityType: news.securityType },
              diagnosticsProfile: {
                bootDiagnostics: { enabled: bootDiagnostics },
              },
              availabilitySet: ref(news.availabilitySetId),
              proximityPlacementGroup: ref(news.proximityPlacementGroupId),
              host: ref(news.hostId),
              hostGroup: ref(news.hostGroupId),
              capacityReservation:
                news.capacityReservationGroupId === undefined
                  ? undefined
                  : {
                      capacityReservationGroup: ref(
                        news.capacityReservationGroupId,
                      ),
                    },
              priority: news.priority,
              evictionPolicy: news.evictionPolicy,
              billingProfile:
                news.maxPrice === undefined
                  ? undefined
                  : { maxPrice: news.maxPrice },
              licenseType: news.licenseType,
              userData: news.userData,
            },
          })
          .pipe(Effect.retry(whileComputeBusy));
      }
      observed = yield* waitComputeProvisioned(label, get);

      // Sync each mutable aspect against observed state; PATCH only deltas.
      const p = observed.properties;
      const patch: compute.VirtualMachinePropertiesInput = {};
      if (p?.hardwareProfile?.vmSize !== vmSize) {
        patch.hardwareProfile = { vmSize };
      }
      if (
        (p?.diagnosticsProfile?.bootDiagnostics?.enabled ?? false) !==
        bootDiagnostics
      ) {
        patch.diagnosticsProfile = {
          bootDiagnostics: { enabled: bootDiagnostics },
        };
      }
      if (
        news.maxPrice !== undefined &&
        p?.billingProfile?.maxPrice !== news.maxPrice
      ) {
        patch.billingProfile = { maxPrice: news.maxPrice };
      }
      if (
        news.licenseType !== undefined &&
        p?.licenseType !== news.licenseType
      ) {
        patch.licenseType = news.licenseType;
      }
      // userData is only returned with `$expand=userData`.
      if (news.userData !== undefined) {
        const withUserData = yield* compute.GetVirtualMachine({
          ...where,
          _expand: "userData",
        });
        if (withUserData.properties?.userData !== news.userData) {
          patch.userData = news.userData;
        }
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
      if (Object.keys(patch).length > 0 || identityChanged || tagsChanged) {
        yield* compute
          .UpdateVirtualMachine({
            ...where,
            tags: tagsChanged ? tags : undefined,
            identity: identityChanged ? desiredIdentity : undefined,
            properties: Object.keys(patch).length > 0 ? patch : undefined,
          })
          .pipe(Effect.retry(whileComputeBusy));
        observed = yield* waitComputeProvisioned(label, get);
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        compute.DeleteVirtualMachine({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          vmName: output.virtualMachineName,
        }),
      ).pipe(Effect.retry(whileComputeBusy));
      yield* waitComputeGone(
        `virtual machine ${output.virtualMachineName}`,
        getVm(subscriptionId, output.resourceGroup, output.virtualMachineName),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.Network.NetworkInterface",
        "Azure.Compute.AvailabilitySet",
        "Azure.Compute.ProximityPlacementGroup",
      ],
    },
  });
