import * as devtestlabs from "@distilled.cloud/azure/devtestlabs";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  desiredTags,
  ensureRegistered,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { createLabResourceName, DEVTESTLAB_NAMESPACE, labLocation } from "./Common.ts";

export interface CustomImageProps {
  /**
   * Resource group of the lab. Changing it replaces the image.
   * @default the stack's resource group (`<stack>-<stage>`)
   */
  resourceGroup: string;
  /** Name of the lab. Changing it replaces the image. */
  lab: string;
  /**
   * Image name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the image.
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Capture the image from a lab VM. Exactly one of `vm` or `vhd` is
   * required. Changing the source replaces the image.
   * @default unset
   */
  vm?: {
    /** ARM ID of the source lab VM. */
    sourceVmId: string;
    /** Deprovisioning state of a Linux source. */
    linuxOsState?: "NonDeprovisioned" | "DeprovisionRequested" | "DeprovisionApplied";
    /** Sysprep state of a Windows source. */
    windowsOsState?: "NonSysprepped" | "SysprepRequested" | "SysprepApplied";
  };
  /**
   * Create the image from a VHD uploaded to the lab's storage account.
   * Changing it replaces the image.
   * @default unset
   */
  vhd?: {
    /** HTTPS URI of the VHD blob in the lab's storage account. */
    imageName: string;
    /** OS type of the VHD. */
    osType: "Windows" | "Linux" | "None";
    /** Whether the Windows VHD is sysprepped. */
    sysPrep?: boolean;
  };
  /**
   * Storage type per data disk LUN. Changing it replaces the image.
   * @default []
   */
  dataDiskStorageInfo?: { lun: string; storageType: "Standard" | "Premium" | "StandardSSD" }[];
  /**
   * Description of the image.
   * @default unset
   */
  description?: string;
  /**
   * Author of the image.
   * @default unset
   */
  author?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default no user tags
   */
  tags?: Record<string, string>;
}

export interface CustomImage extends Resource<
  "Azure.DevTestLabs.CustomImage",
  CustomImageProps,
  {
    /** Name of the image. */
    customImageName: string;
    /** ARM resource ID of the image; use it as a lab VM's `customImageId`. */
    customImageId: string;
    /** Resource group of the lab. */
    resourceGroup: string;
    /** Name of the lab. */
    lab: string;
    /** ARM ID of the managed image backing the custom image. */
    managedImageId: string | undefined;
    /** Creation time of the image. */
    creationDate: string | undefined;
    /** Unique immutable identifier (GUID). */
    uniqueIdentifier: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A DevTest Labs custom image (`Microsoft.DevTestLab/labs/customimages`) —
 * a VM image captured from a lab VM or imported from a VHD that lab users
 * can create VMs from. The lab RP does not import managed images or
 * snapshots on their own: a source needs `vm` or `vhd`.
 *
 * :::caution
 * Changing `lab`, `name`, `resourceGroup`, or the image source (`vm`,
 * `vhd`, `dataDiskStorageInfo`) replaces the custom image.
 * :::
 *
 * @see https://learn.microsoft.com/azure/devtest-labs/devtest-lab-create-custom-image-from-vm-using-portal
 *
 * ### Capturing a Lab VM
 * **Example:** Image from a deprovisioned Linux lab VM
 * ```typescript
 * const lab = yield* Azure.DevTestLabs.Lab("team-lab");
 * const vnet = yield* Azure.Network.VirtualNetwork("lab-vnet", {
 *   addressPrefixes: ["10.0.0.0/16"],
 * });
 * const subnet = yield* Azure.Network.Subnet("lab-vms", {
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.1.0/24",
 * });
 * const network = yield* Azure.DevTestLabs.LabVirtualNetwork("net", {
 *   lab: lab.labName,
 *   externalProviderResourceId: vnet.virtualNetworkId,
 *   subnetOverrides: [
 *     {
 *       resourceId: subnet.subnetId,
 *       labSubnetName: subnet.subnetName,
 *       useInVmCreationPermission: "Allow",
 *     },
 *   ],
 * });
 * const publicKey = "ssh-ed25519 AAAAC3Nza... me@example.com";
 * const vm = yield* Azure.DevTestLabs.VirtualMachine("dev", {
 *   lab: lab.labName,
 *   size: "Standard_B1s",
 *   galleryImageReference: {
 *     publisher: "Canonical",
 *     offer: "0001-com-ubuntu-server-jammy",
 *     sku: "22_04-lts-gen2",
 *     osType: "Linux",
 *   },
 *   userName: "azureuser",
 *   isAuthenticationWithSshKey: true,
 *   sshKey: publicKey,
 *   labVirtualNetworkId: network.labVirtualNetworkId,
 *   labSubnetName: subnet.subnetName,
 * });
 * const image = yield* Azure.DevTestLabs.CustomImage("golden", {
 *   lab: lab.labName,
 *   vm: {
 *     sourceVmId: vm.virtualMachineId,
 *     linuxOsState: "DeprovisionRequested",
 *   },
 *   description: "Golden dev image",
 * });
 * ```
 *
 * ### Importing a VHD
 * **Example:** Image from an uploaded Linux VHD
 * ```typescript
 * const image = yield* Azure.DevTestLabs.CustomImage("imported", {
 *   lab: lab.labName,
 *   vhd: {
 *     imageName: "https://mylabstorage.blob.core.windows.net/uploads/os.vhd",
 *     osType: "Linux",
 *   },
 * });
 * ```
 *
 * @resource
 */
export const CustomImage = GroupedResource<CustomImage>("Azure.DevTestLabs.CustomImage");

const getImage = (
  subscriptionId: string,
  resourceGroupName: string,
  labName: string,
  name: string,
) =>
  orUndefinedIfNotFound(
    devtestlabs.GetCustomImage({
      subscriptionId,
      resourceGroupName,
      labName,
      name,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  lab: string,
  name: string,
  i: devtestlabs.GetCustomImageResponse,
): CustomImage["Attributes"] => ({
  customImageName: name,
  customImageId: i.id ?? "",
  resourceGroup,
  lab,
  managedImageId: i.properties?.managedImageId,
  creationDate: i.properties?.creationDate,
  uniqueIdentifier: i.properties?.uniqueIdentifier,
  tags: userTags(i.tags),
});

const sourceInput = (news: CustomImageProps): devtestlabs.CustomImagePropertiesInput => {
  return {
    vm:
      news.vm !== undefined
        ? {
            sourceVmId: news.vm.sourceVmId,
            linuxOsInfo:
              news.vm.linuxOsState === undefined
                ? undefined
                : { linuxOsState: news.vm.linuxOsState },
            windowsOsInfo:
              news.vm.windowsOsState === undefined
                ? undefined
                : { windowsOsState: news.vm.windowsOsState },
          }
        : undefined,
    vhd: news.vhd,
    dataDiskStorageInfo: news.dataDiskStorageInfo,
  };
};

export const CustomImageProvider = () =>
  Provider.succeed(CustomImage, {
    stables: ["customImageName", "customImageId", "resourceGroup", "lab"],

    // Custom images are deleted with their lab.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !== output.resourceGroup.toLowerCase() ||
        news.lab.toLowerCase() !== output.lab.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.customImageName.toLowerCase()) ||
        (olds !== undefined &&
          JSON.stringify(sourceInput(news)) !== JSON.stringify(sourceInput(olds)))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const lab = output?.lab ?? olds?.lab;
      if (resourceGroup === undefined || lab === undefined) return undefined;
      const name = output?.customImageName ?? olds?.name ?? (yield* createLabResourceName(id));
      const observed = yield* getImage(subscriptionId, resourceGroup, lab, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, lab, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, DEVTESTLAB_NAMESPACE);
      const { resourceGroup, lab } = news;
      const name = news.name ?? output?.customImageName ?? (yield* createLabResourceName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        labName: lab,
        name,
      };
      const get = getImage(subscriptionId, resourceGroup, lab, name);
      const wait = waitForProvisioned(
        `lab custom image ${name}`,
        get,
        (i) => i.properties?.provisioningState,
        // Capturing a VM takes several minutes.
        { interval: "10 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;
      if (observed !== undefined) observed = yield* wait;

      // Ensure: the source is fixed at creation (long-running PUT).
      if (observed === undefined) {
        yield* devtestlabs.CustomImagesCreateOrUpdate({
          ...where,
          location: yield* labLocation(subscriptionId, resourceGroup, lab),
          tags,
          properties: {
            ...sourceInput(news),
            description: news.description,
            author: news.author,
          },
        });
        observed = yield* wait;
      }

      // Sync description, author, and tags. PATCH only updates tags, so
      // property deltas re-send the full PUT with the observed source.
      const p = observed.properties ?? {};
      if (
        (news.description !== undefined && news.description !== p.description) ||
        (news.author !== undefined && news.author !== p.author)
      ) {
        yield* devtestlabs.CustomImagesCreateOrUpdate({
          ...where,
          location: observed.location,
          tags,
          properties: {
            ...sourceInput(news),
            description: news.description ?? p.description,
            author: news.author ?? p.author,
          },
        });
        observed = yield* wait;
      } else if (tagsDiffer(observed.tags, tags)) {
        yield* devtestlabs.UpdateCustomImage({ ...where, tags });
        observed = yield* wait;
      }

      return toAttrs(resourceGroup, lab, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        devtestlabs.DeleteCustomImage({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          labName: output.lab,
          name: output.customImageName,
        }),
      );
      yield* waitUntilGone(
        `lab custom image ${output.customImageName}`,
        getImage(subscriptionId, output.resourceGroup, output.lab, output.customImageName),
        { interval: "5 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
