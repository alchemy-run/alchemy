import * as nc from "@distilled.cloud/azure/networkcloud";
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
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createNexusName,
  customLocation,
  differs,
  identityBody,
  identityInSync,
  NEXUS_NAMESPACE,
  NEXUS_SLOW_BUDGET,
  propertyDelta,
  sameArm,
  secretsDiffer,
  waitNexusProvisioned,
} from "./Common.ts";
import type { NexusIdentity, NexusSshPublicKey } from "./Types.ts";

export interface VirtualMachineProps {
  /**
   * Resource group the virtual machine is created in. Changing it replaces the
   * virtual machine.
   */
  resourceGroup: string;
  /**
   * Name of the virtual machine. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the virtual machine.
   */
  name?: string;
  /**
   * Azure location of the virtual machine; must match the location of the Nexus
   * cluster. Changing it replaces the virtual machine.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the Nexus cluster's custom location (`clusterExtendedLocation`).
   * Changing it replaces the virtual machine.
   */
  customLocationId: string;
  /** Admin user name of the VM. Changing it replaces the virtual machine. */
  adminUsername: string;
  /**
   * Attachment to the cloud services network (`networkAttachmentName`
   * ignored). Changing it replaces the virtual machine.
   */
  cloudServicesNetworkAttachment: nc.NetworkAttachmentInput;
  /** Number of vCPUs. Changing it replaces the virtual machine. */
  cpuCores: number;
  /** Memory in GB. Changing it replaces the virtual machine. */
  memorySizeGB: number;
  /** OS disk and attached volumes. Changing it replaces the virtual machine. */
  storageProfile: nc.StorageProfile;
  /** Container image (`registry/repo:tag`) of the VM OS disk. Changing it replaces the virtual machine. */
  vmImage: string;
  /**
   * Credentials of the registry hosting `vmImage` (password may be
   * `Redacted`). Updated in place.
   */
  vmImageRepositoryCredentials?: nc.ImageRepositoryCredentials;
  /** Workload network attachments. Changing them replaces the virtual machine. */
  networkAttachments?: nc.NetworkAttachmentInput[];
  /** Base64 cloud-init network data. Changing it replaces the virtual machine. */
  networkDataContent?: string;
  /** Base64 cloud-init user data. Changing it replaces the virtual machine. */
  userDataContent?: string;
  /** Scheduling hints (affinity to racks/machines). Changing them replaces the virtual machine. */
  placementHints?: nc.VirtualMachinePlacementHint[];
  /** SSH public keys of the admin user. Changing them replaces the virtual machine. */
  sshPublicKeys?: NexusSshPublicKey[];
  /** Boot method: `UEFI` or `BIOS`. Changing it replaces the virtual machine. */
  bootMethod?: "BIOS" | "UEFI";
  /** Pin the emulator thread to a dedicated core (`True`/`False`). Changing it replaces the virtual machine. */
  isolateEmulatorThread?: "True" | "False";
  /** Virtio interface mode: `Modern` or `Transitional`. Changing it replaces the virtual machine. */
  virtioInterface?: "Modern" | "Transitional";
  /** Virtual hardware model: `T1`, `T2`, or `T3`. Changing it replaces the virtual machine. */
  vmDeviceModel?: "T1" | "T2" | "T3";
  /**
   * Custom location of the cluster manager used for console access.
   * Changing it replaces the virtual machine.
   */
  consoleCustomLocationId?: string;
  /** Managed identity of the virtual machine. */
  identity?: NexusIdentity;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface VirtualMachine extends Resource<
  "Azure.NetworkCloud.VirtualMachine",
  VirtualMachineProps,
  {
    /** Name of the virtual machine. */
    virtualMachineName: string;
    /** ARM resource ID of the virtual machine. */
    virtualMachineId: string;
    /** Resource group that holds the virtual machine. */
    resourceGroup: string;
    /** Location of the virtual machine. */
    location: string;
    /** Custom location the virtual machine is deployed to. */
    customLocationId: string | undefined;
    /** Power state, e.g. `On`. */
    powerState: string | undefined;
    /** ARM ID of the bare metal machine hosting the VM. */
    bareMetalMachineId: string | undefined;
    /** ARM ID of the Nexus cluster hosting the VM. */
    clusterId: string | undefined;
    /** ARM IDs of the volumes attached to the VM. */
    volumeIds: string[];
    /** Principal ID of the system-assigned identity, if any. */
    principalId: string | undefined;
    /** Detailed status reported by the platform. */
    detailedStatus: string | undefined;
    /** Message describing the detailed status. */
    detailedStatusMessage: string | undefined;
    /** Provisioning state, e.g. `Succeeded`. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Operator Nexus virtual machine — a VM for virtualized network
 * functions running on the bare metal machines of a Nexus cluster, booted
 * from a container image and attached to Nexus networks and volumes. Only
 * tags, identity, and the image registry credentials update in place.
 * Needs a deployed Operator Nexus cluster.
 *
 * @see https://learn.microsoft.com/azure/operator-nexus/quickstarts-tenant-workload-deployment
 *
 * ### Creating a Virtual Machine
 * **Example:** VM on an L3 network
 * ```typescript
 * const vm = yield* Azure.NetworkCloud.VirtualMachine("vnf", {
 *   resourceGroup: group.resourceGroupName,
 *   customLocationId: cluster.clusterExtendedLocationId,
 *   adminUsername: "azureuser",
 *   cloudServicesNetworkAttachment: {
 *     attachedNetworkId: csn.cloudServicesNetworkId,
 *     ipAllocationMethod: "Dynamic",
 *   },
 *   networkAttachments: [
 *     {
 *       attachedNetworkId: l3.l3NetworkId,
 *       ipAllocationMethod: "Dynamic",
 *       defaultGateway: "True",
 *     },
 *   ],
 *   cpuCores: 4,
 *   memorySizeGB: 8,
 *   storageProfile: { osDisk: { diskSizeGB: 64 } },
 *   vmImage: "myregistry.azurecr.io/ubuntu:22.04",
 *   sshPublicKeys: [{ keyData: "ssh-ed25519 AAAA..." }],
 * });
 * ```
 *
 * @resource
 */
export const VirtualMachine = Resource<VirtualMachine>(
  "Azure.NetworkCloud.VirtualMachine",
);

type Observed = nc.GetVirtualMachineResponse;

const getVirtualMachine = (
  subscriptionId: string,
  resourceGroupName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    nc.GetVirtualMachine({
      subscriptionId,
      resourceGroupName,
      virtualMachineName: name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Observed,
): VirtualMachine["Attributes"] => {
  const p = observed.properties;
  return {
    virtualMachineName: name,
    virtualMachineId: observed.id ?? "",
    resourceGroup,
    location: observed.location,
    customLocationId: observed.extendedLocation?.name,
    powerState: p.powerState,
    bareMetalMachineId: p.bareMetalMachineId,
    clusterId: p.clusterId,
    volumeIds: [...(p.volumes ?? [])],
    principalId: observed.identity?.principalId,
    detailedStatus: p?.detailedStatus,
    detailedStatusMessage: p?.detailedStatusMessage,
    provisioningState: p?.provisioningState,
    tags: userTags(observed.tags),
  };
};

export const VirtualMachineProvider = () =>
  Provider.succeed(VirtualMachine, {
    stables: [
      "virtualMachineName",
      "virtualMachineId",
      "resourceGroup",
      "location",
      "customLocationId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* nc
        .ListVirtualMachineBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListVirtualMachineBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((item) => {
        const group = resourceGroupOf(item.id);
        return hasAnyAlchemyTag(item.tags) &&
          group !== undefined &&
          item.name !== undefined
          ? [toAttrs(group, item.name, item)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.virtualMachineName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        !sameArm(news.customLocationId, output.customLocationId) ||
        (olds !== undefined &&
          (differs(news.cpuCores, olds.cpuCores) ||
            news.adminUsername !== olds.adminUsername ||
            differs(
              news.cloudServicesNetworkAttachment,
              olds.cloudServicesNetworkAttachment,
            ) ||
            differs(news.memorySizeGB, olds.memorySizeGB) ||
            differs(news.storageProfile, olds.storageProfile) ||
            news.vmImage !== olds.vmImage ||
            differs(news.networkAttachments, olds.networkAttachments) ||
            news.networkDataContent !== olds.networkDataContent ||
            news.userDataContent !== olds.userDataContent ||
            differs(news.placementHints, olds.placementHints) ||
            differs(news.sshPublicKeys, olds.sshPublicKeys) ||
            !sameArm(news.bootMethod, olds.bootMethod) ||
            !sameArm(news.isolateEmulatorThread, olds.isolateEmulatorThread) ||
            !sameArm(news.virtioInterface, olds.virtioInterface) ||
            !sameArm(news.vmDeviceModel, olds.vmDeviceModel) ||
            !sameArm(
              news.consoleCustomLocationId,
              olds.consoleCustomLocationId,
            )))
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
        output?.virtualMachineName ??
        olds?.name ??
        (yield* createNexusName(id, 63));
      const observed = yield* getVirtualMachine(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, NEXUS_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.virtualMachineName ??
        (yield* createNexusName(id, 63));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        virtualMachineName: name,
      };
      const label = `Nexus virtual machine ${name}`;
      const get = getVirtualMachine(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* nc.VirtualMachinesCreateOrUpdate({
          ...where,
          location,
          tags,
          extendedLocation: customLocation(news.customLocationId),
          identity: identityBody(news.identity),
          properties: {
            adminUsername: news.adminUsername,
            cloudServicesNetworkAttachment: news.cloudServicesNetworkAttachment,
            cpuCores: news.cpuCores,
            memorySizeGB: news.memorySizeGB,
            storageProfile: news.storageProfile,
            vmImage: news.vmImage,
            vmImageRepositoryCredentials: news.vmImageRepositoryCredentials,
            networkAttachments: news.networkAttachments,
            networkDataContent: news.networkDataContent,
            userDataContent: news.userDataContent,
            placementHints: news.placementHints,
            sshPublicKeys: news.sshPublicKeys,
            bootMethod: news.bootMethod,
            isolateEmulatorThread: news.isolateEmulatorThread,
            virtioInterface: news.virtioInterface,
            vmDeviceModel: news.vmDeviceModel,
            consoleExtendedLocation:
              news.consoleCustomLocationId === undefined
                ? undefined
                : customLocation(news.consoleCustomLocationId),
          },
        });
      }
      observed = yield* waitNexusProvisioned(label, get, NEXUS_SLOW_BUDGET);

      // Sync mutable aspects against observed state; send only the delta.
      // Azure never returns the registry password, so the credentials are
      // compared against the previous props.
      const credentialsChanged =
        news.vmImageRepositoryCredentials !== undefined &&
        (olds === undefined ||
          secretsDiffer(
            news.vmImageRepositoryCredentials,
            olds.vmImageRepositoryCredentials,
          ));
      const delta = credentialsChanged
        ? { vmImageRepositoryCredentials: news.vmImageRepositoryCredentials }
        : undefined;
      const identityChanged = !identityInSync(observed.identity, news.identity);
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (delta !== undefined || identityChanged || tagsChanged) {
        yield* nc.UpdateVirtualMachine({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: delta,
          identity: identityChanged ? identityBody(news.identity) : undefined,
        });
        observed = yield* waitNexusProvisioned(label, get, NEXUS_SLOW_BUDGET);
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const name = output.virtualMachineName;
      yield* ignoreNotFound(
        nc.DeleteVirtualMachine({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          virtualMachineName: name,
        }),
      );
      yield* waitUntilGone(
        `Nexus virtual machine ${name}`,
        getVirtualMachine(subscriptionId, output.resourceGroup, name),
        NEXUS_SLOW_BUDGET,
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.NetworkCloud.CloudServicesNetwork",
        "Azure.NetworkCloud.L2Network",
        "Azure.NetworkCloud.L3Network",
        "Azure.NetworkCloud.TrunkedNetwork",
        "Azure.NetworkCloud.Volume",
      ],
    },
  });
