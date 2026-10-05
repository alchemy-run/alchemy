import * as hci from "@distilled.cloud/azure/azurestackhci";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
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
  HCI_NAMESPACE,
  type HciExtendedLocation,
  sameId,
  sameValue,
  toExtendedLocation,
} from "./Common.ts";

/** Publisher/offer/SKU identifier of a gallery image definition. */
export type GalleryImageIdentifier = hci.GalleryImageIdentifier;
/** Version of a gallery image and its storage profile. */
export type GalleryImageVersion = hci.GalleryImageVersionInput;

export interface GalleryImageProps {
  /** Resource group the gallery image is created in. Changing it replaces the gallery image. */
  resourceGroup: string;
  /**
   * Name of the gallery image. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the gallery image.
   */
  name?: string;
  /**
   * Azure region of the gallery image; must match the custom location's region.
   * Changing it replaces the gallery image.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Arc custom location of the Azure Local cluster that hosts the gallery image.
   * Changing it replaces the gallery image.
   */
  extendedLocation: HciExtendedLocation;
  /**
   * Location of the source image: a local path on the cluster, or a
   * storage blob URL. Changing it replaces the image.
   */
  imagePath?: string;
  /**
   * ARM ID of the storage container that stores the image. Changing it
   * replaces the image.
   * @default the cluster's default storage path
   */
  containerId?: string;
  /** Operating system of the image. Changing it replaces the image. */
  osType: "Windows" | "Linux";
  /** Cloud-init datasource of the image. Changing it replaces the image. */
  cloudInitDataSource?: "NoCloud" | "Azure";
  /** Hyper-V generation of the image. Changing it replaces the image. */
  hyperVGeneration?: "V1" | "V2";
  /** Gallery image definition identifier. Changing it replaces the image. */
  identifier?: GalleryImageIdentifier;
  /** Image version. Changing it replaces the image. */
  version?: GalleryImageVersion;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface GalleryImage extends Resource<
  "Azure.AzureStackHCI.GalleryImage",
  GalleryImageProps,
  {
    /** Name of the gallery image. */
    galleryImageName: string;
    /** Resource group that holds the gallery image. */
    resourceGroup: string;
    /** ARM resource ID of the gallery image. */
    galleryImageId: string;
    /** Azure region of the gallery image. */
    location: string;
    /** ARM ID of the Arc custom location that hosts the gallery image. */
    customLocationId: string | undefined;
    /** Provisioning state of the gallery image. */
    provisioningState: string | undefined;
    /** Operating system of the image. */
    osType: string | undefined;
    /** Download progress of the image, in percent. */
    downloadPercent: number | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A VM image on an Azure Local cluster, imported from a local path or a
 * storage blob, used to create Arc VMs. Needs an Arc custom location backed
 * by the Arc Resource Bridge of a deployed Azure Local cluster.
 *
 * @see https://learn.microsoft.com/azure/azure-local/manage/virtual-machine-image-storage-account
 *
 * ### Importing an Image
 * **Example:** Image from a storage blob
 * ```typescript
 * const image = yield* Azure.AzureStackHCI.GalleryImage("ubuntu", {
 *   resourceGroup: group.resourceGroupName,
 *   extendedLocation: { name: customLocationId },
 *   imagePath: "https://account.blob.core.windows.net/images/ubuntu.vhdx",
 *   osType: "Linux",
 * });
 * ```
 *
 * @resource
 */
export const GalleryImage = Resource<GalleryImage>(
  "Azure.AzureStackHCI.GalleryImage",
);

const SPEC_KEYS = [
  "imagePath",
  "containerId",
  "osType",
  "cloudInitDataSource",
  "hyperVGeneration",
  "identifier",
  "version",
] as const;

const getGalleryImage = (
  subscriptionId: string,
  resourceGroupName: string,
  galleryImageName: string,
) =>
  orUndefinedIfNotFound(
    hci.GetGalleryImage({
      subscriptionId,
      resourceGroupName,
      galleryImageName,
    }),
  );

const createName = (id: string) => createPhysicalName({ id, maxLength: 63 });

const toAttrs = (
  resourceGroup: string,
  name: string,
  value: hci.GetGalleryImageResponse,
): GalleryImage["Attributes"] => ({
  galleryImageName: name,
  resourceGroup,
  galleryImageId: value.id ?? "",
  location: value.location,
  customLocationId: value.extendedLocation?.name,
  provisioningState: value.properties?.provisioningState,
  osType: value.properties?.osType,
  downloadPercent: value.properties?.status?.progressPercentage,
  tags: userTags(value.tags),
});

export const GalleryImageProvider = () =>
  Provider.succeed(GalleryImage, {
    stables: [
      "galleryImageName",
      "resourceGroup",
      "galleryImageId",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* orUndefinedIfNotFound(
        hci
          .ListGalleryImageAll({ subscriptionId })
          .pipe(
            Effect.flatMap((page) =>
              requireSinglePage("ListGalleryImageAll", page),
            ),
          ),
      );
      return (page?.value ?? []).flatMap((value) => {
        const group = resourceGroupOf(value.id);
        return hasAnyAlchemyTag(value.tags) &&
          group !== undefined &&
          value.name !== undefined
          ? [toAttrs(group, value.name, value)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameId(news.name, output.galleryImageName)) ||
        (news.location !== undefined &&
          !sameId(news.location, output.location)) ||
        (output.customLocationId !== undefined &&
          !sameId(news.extendedLocation.name, output.customLocationId)) ||
        (olds !== undefined &&
          SPEC_KEYS.some((key) => !sameValue(news[key], olds[key])))
      ) {
        // An explicit name is reused by the replacement, so the old one
        // must go first; generated names differ per instance.
        return {
          action: "replace",
          deleteFirst: news.name !== undefined,
        } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.galleryImageName ?? olds?.name ?? (yield* createName(id));
      const observed = yield* getGalleryImage(
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
      yield* ensureRegistered(subscriptionId, HCI_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.galleryImageName ?? (yield* createName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        galleryImageName: name,
      };
      const get = getGalleryImage(subscriptionId, resourceGroup, name);
      const settle = waitForProvisioned(
        `Azure Local gallery image ${name}`,
        get,
        (value) => value.properties?.provisioningState,
        { interval: "10 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure. Everything but tags is immutable (diff replaces), so the
      // PUT only runs when the gallery image is missing.
      if (observed === undefined) {
        yield* hci.GalleryImagesCreateOrUpdate({
          ...where,
          location,
          tags,
          extendedLocation: toExtendedLocation(news.extendedLocation),
          properties: {
            imagePath: news.imagePath,
            containerId: news.containerId,
            osType: news.osType,
            cloudInitDataSource: news.cloudInitDataSource,
            hyperVGeneration: news.hyperVGeneration,
            identifier: news.identifier,
            version: news.version,
          },
        });
        observed = yield* settle;
      }

      // Sync tags against the observed gallery image.
      if (tagsDiffer(observed.tags, tags)) {
        yield* hci.UpdateGalleryImage({ ...where, tags });
        observed = yield* settle;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hci.DeleteGalleryImage({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          galleryImageName: output.galleryImageName,
        }),
      );
      yield* waitUntilGone(
        `Azure Local gallery image ${output.galleryImageName}`,
        getGalleryImage(
          subscriptionId,
          output.resourceGroup,
          output.galleryImageName,
        ),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
