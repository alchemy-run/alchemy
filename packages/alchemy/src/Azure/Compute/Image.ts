import * as compute from "@distilled.cloud/azure/compute";
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
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  canonical,
  createComputeName,
  ref,
  sameId,
  waitComputeGone,
  waitComputeProvisioned,
  whileComputeBusy,
} from "./common.ts";

export interface ImageOsDisk {
  /** Operating system of the disk. */
  osType: "Linux" | "Windows";
  /** `Generalized` (sysprepped / deprovisioned) or `Specialized`. */
  osState: "Generalized" | "Specialized";
  /** ARM ID of a managed disk to capture. */
  managedDiskId?: string;
  /** ARM ID of a snapshot to capture. */
  snapshotId?: string;
  /** URI of a VHD page blob to capture. */
  blobUri?: string;
  /** Storage type of disks created from the image. */
  storageAccountType?: string;
  /** Size in GiB of disks created from the image. */
  diskSizeGB?: number;
}

export interface ImageDataDisk {
  /** Logical unit number of the data disk. */
  lun: number;
  /** ARM ID of a managed disk to capture. */
  managedDiskId?: string;
  /** ARM ID of a snapshot to capture. */
  snapshotId?: string;
  /** URI of a VHD page blob to capture. */
  blobUri?: string;
  /** Storage type of disks created from the image. */
  storageAccountType?: string;
  /** Size in GiB of disks created from the image. */
  diskSizeGB?: number;
}

export interface ImageProps {
  /**
   * Resource group the image is created in. Changing it replaces the image.
   */
  resourceGroup: string;
  /**
   * Name of the image: 1-80 letters, digits, `_`, `.`, and `-`. If
   * omitted, a unique name is generated from the app, stage, and logical
   * ID. Changing it replaces the image.
   */
  name?: string;
  /**
   * Azure location of the image; must match the source. Changing it
   * replaces the image.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of a generalized, deallocated VM to capture. Changing it
   * replaces the image. Set this or `osDisk`.
   */
  sourceVirtualMachineId?: string;
  /**
   * OS disk source (managed disk, snapshot, or VHD blob). Changing it
   * replaces the image.
   */
  osDisk?: ImageOsDisk;
  /**
   * Data disk sources. Changing them replaces the image.
   */
  dataDisks?: ImageDataDisk[];
  /**
   * Hyper-V generation of VMs created from the image; must match the
   * source (Gen2 sources need `V2`). Changing it replaces the image.
   * @default "V1"
   */
  hyperVGeneration?: "V1" | "V2";
  /**
   * Store the image on zone-redundant storage (regions with zones only).
   * Changing it replaces the image.
   */
  zoneResilient?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Image extends Resource<
  "Azure.Compute.Image",
  ImageProps,
  {
    /** Name of the image. */
    imageName: string;
    /** ARM resource ID of the image; use it as a VM's `image: { id }`. */
    imageId: string;
    /** Resource group that holds the image. */
    resourceGroup: string;
    /** Location of the image. */
    location: string;
    /** ARM ID of the captured VM, if any. */
    sourceVirtualMachineId: string | undefined;
    /** Hyper-V generation. */
    hyperVGeneration: string | undefined;
    /** OS type of the image. */
    osType: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure managed image — a captured, reusable VM image built from a
 * generalized VM, managed disks, snapshots, or VHD blobs. Images cost only
 * their storage. (Azure Compute Gallery is the modern, replicated
 * successor.)
 *
 * @see https://learn.microsoft.com/azure/virtual-machines/capture-image-resource
 *
 * ### Capturing a VM
 * **Example:** Image from a generalized VM
 * ```typescript
 * // The VM must be deallocated and generalized first
 * // (`waagent -deprovision+user`, then the Generalize action).
 * const image = yield* Azure.Compute.Image("golden", {
 *   resourceGroup: group.resourceGroupName,
 *   sourceVirtualMachineId: vm.virtualMachineId,
 *   hyperVGeneration: "V2",
 * });
 * ```
 *
 * ### Importing a VHD
 * **Example:** Image from a VHD blob
 * ```typescript
 * const image = yield* Azure.Compute.Image("imported", {
 *   resourceGroup: group.resourceGroupName,
 *   osDisk: {
 *     osType: "Linux",
 *     osState: "Generalized",
 *     blobUri: "https://myaccount.blob.core.windows.net/vhds/os.vhd",
 *   },
 * });
 * ```
 *
 * ### Using the Image
 * **Example:** VM from the image
 * ```typescript
 * const vm = yield* Azure.Compute.VirtualMachine("app", {
 *   resourceGroup: group.resourceGroupName,
 *   vmSize: "Standard_B1s",
 *   image: { id: image.imageId },
 *   networkInterfaceIds: [nic.networkInterfaceId],
 *   adminUsername: "azureuser",
 *   sshPublicKeys: [publicKey],
 * });
 * ```
 *
 * @resource
 */
export const Image = Resource<Image>("Azure.Compute.Image");

type Observed = compute.GetImageResponse;

const getImage = (
  subscriptionId: string,
  resourceGroupName: string,
  imageName: string,
) =>
  orUndefinedIfNotFound(
    compute.GetImage({ subscriptionId, resourceGroupName, imageName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  image: Observed,
): Image["Attributes"] => ({
  imageName: name,
  imageId: image.id ?? "",
  resourceGroup,
  location: image.location,
  sourceVirtualMachineId: image.properties?.sourceVirtualMachine?.id,
  hyperVGeneration: image.properties?.hyperVGeneration,
  osType: image.properties?.storageProfile?.osDisk?.osType,
  tags: userTags(image.tags),
});

const sourceKey = (p: ImageProps) =>
  canonical({
    vm: p.sourceVirtualMachineId?.toLowerCase(),
    osDisk: p.osDisk,
    dataDisks: p.dataDisks ?? [],
    hyperVGeneration: p.hyperVGeneration ?? "V1",
    zoneResilient: p.zoneResilient ?? false,
  });

export const ImageProvider = () =>
  Provider.succeed(Image, {
    stables: ["imageName", "imageId", "resourceGroup", "location"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* compute
        .ListImages({ subscriptionId })
        .pipe(Effect.flatMap((page) => requireSinglePage("ListImages", page)));
      return page.value.flatMap((image) => {
        const resourceGroup = resourceGroupOf(image.id);
        return hasAnyAlchemyTag(image.tags) &&
          resourceGroup !== undefined &&
          image.name !== undefined
          ? [toAttrs(resourceGroup, image.name, image)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && !sameId(news.name, output.imageName)) ||
        (news.location !== undefined &&
          !sameId(news.location, output.location)) ||
        (olds !== undefined && sourceKey(news) !== sourceKey(olds))
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
        output?.imageName ?? olds?.name ?? (yield* createComputeName(id));
      const observed = yield* getImage(subscriptionId, resourceGroup, name);
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
        news.name ?? output?.imageName ?? (yield* createComputeName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        imageName: name,
      };
      const label = `image ${name}`;
      const get = getImage(subscriptionId, resourceGroup, name);

      // Observe.
      let observed = yield* get;

      // Ensure. Capturing is a long-running operation.
      if (observed === undefined) {
        const os = news.osDisk;
        yield* compute
          .ImagesCreateOrUpdate({
            ...where,
            location,
            tags,
            properties: {
              sourceVirtualMachine: ref(news.sourceVirtualMachineId),
              hyperVGeneration: news.hyperVGeneration,
              storageProfile:
                os === undefined &&
                news.dataDisks === undefined &&
                news.zoneResilient === undefined
                  ? undefined
                  : {
                      zoneResilient: news.zoneResilient,
                      osDisk:
                        os === undefined
                          ? undefined
                          : {
                              osType: os.osType,
                              osState: os.osState,
                              managedDisk: ref(os.managedDiskId),
                              snapshot: ref(os.snapshotId),
                              blobUri: os.blobUri,
                              storageAccountType: os.storageAccountType,
                              diskSizeGB: os.diskSizeGB,
                            },
                      dataDisks: news.dataDisks?.map((disk) => ({
                        lun: disk.lun,
                        managedDisk: ref(disk.managedDiskId),
                        snapshot: ref(disk.snapshotId),
                        blobUri: disk.blobUri,
                        storageAccountType: disk.storageAccountType,
                        diskSizeGB: disk.diskSizeGB,
                      })),
                    },
            },
          })
          .pipe(Effect.retry(whileComputeBusy));
      }
      observed = yield* waitComputeProvisioned(label, get);

      // Sync tags (the only mutable aspect).
      if (tagsDiffer(observed.tags, tags)) {
        yield* compute.UpdateImage({ ...where, tags });
        observed = yield* waitComputeProvisioned(label, get);
      }
      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        compute.DeleteImage({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          imageName: output.imageName,
        }),
      );
      yield* waitComputeGone(
        `image ${output.imageName}`,
        getImage(subscriptionId, output.resourceGroup, output.imageName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
