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

export interface MarketplaceGalleryImageProps {
  /** Resource group the marketplace gallery image is created in. Changing it replaces the marketplace gallery image. */
  resourceGroup: string;
  /**
   * Name of the marketplace gallery image. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the marketplace gallery image.
   */
  name?: string;
  /**
   * Azure region of the marketplace gallery image; must match the custom location's region.
   * Changing it replaces the marketplace gallery image.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Arc custom location of the Azure Local cluster that hosts the marketplace gallery image.
   * Changing it replaces the marketplace gallery image.
   */
  extendedLocation: HciExtendedLocation;
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
  /**
   * Marketplace publisher/offer/SKU of the image. Changing it replaces the
   * image.
   */
  identifier?: hci.GalleryImageIdentifier;
  /** Marketplace image version. Changing it replaces the image. */
  version?: hci.GalleryImageVersionInput;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface MarketplaceGalleryImage extends Resource<
  "Azure.AzureStackHCI.MarketplaceGalleryImage",
  MarketplaceGalleryImageProps,
  {
    /** Name of the marketplace gallery image. */
    marketplaceGalleryImageName: string;
    /** Resource group that holds the marketplace gallery image. */
    resourceGroup: string;
    /** ARM resource ID of the marketplace gallery image. */
    marketplaceGalleryImageId: string;
    /** Azure region of the marketplace gallery image. */
    location: string;
    /** ARM ID of the Arc custom location that hosts the marketplace gallery image. */
    customLocationId: string | undefined;
    /** Provisioning state of the marketplace gallery image. */
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
 * An Azure Marketplace VM image downloaded to an Azure Local cluster for
 * creating Arc VMs. Needs an Arc custom location backed by the Arc Resource
 * Bridge of a deployed Azure Local cluster.
 *
 * @see https://learn.microsoft.com/azure/azure-local/manage/virtual-machine-image-azure-marketplace
 *
 * ### Downloading a Marketplace Image
 * **Example:** Windows Server image
 * ```typescript
 * const image = yield* Azure.AzureStackHCI.MarketplaceGalleryImage("ws2022", {
 *   resourceGroup: group.resourceGroupName,
 *   extendedLocation: { name: customLocationId },
 *   osType: "Windows",
 *   hyperVGeneration: "V2",
 *   identifier: {
 *     publisher: "MicrosoftWindowsServer",
 *     offer: "WindowsServer",
 *     sku: "2022-datacenter-azure-edition",
 *   },
 *   version: { name: "20348.2655.240905" },
 * });
 * ```
 *
 * @resource
 */
export const MarketplaceGalleryImage = Resource<MarketplaceGalleryImage>(
  "Azure.AzureStackHCI.MarketplaceGalleryImage",
);

const SPEC_KEYS = [
  "containerId",
  "osType",
  "cloudInitDataSource",
  "hyperVGeneration",
  "identifier",
  "version",
] as const;

const getMarketplaceGalleryImage = (
  subscriptionId: string,
  resourceGroupName: string,
  marketplaceGalleryImageName: string,
) =>
  orUndefinedIfNotFound(
    hci.GetMarketplaceGalleryImage({
      subscriptionId,
      resourceGroupName,
      marketplaceGalleryImageName,
    }),
  );

const createName = (id: string) => createPhysicalName({ id, maxLength: 63 });

const toAttrs = (
  resourceGroup: string,
  name: string,
  value: hci.GetMarketplaceGalleryImageResponse,
): MarketplaceGalleryImage["Attributes"] => ({
  marketplaceGalleryImageName: name,
  resourceGroup,
  marketplaceGalleryImageId: value.id ?? "",
  location: value.location,
  customLocationId: value.extendedLocation?.name,
  provisioningState: value.properties?.provisioningState,
  osType: value.properties?.osType,
  downloadPercent: value.properties?.status?.progressPercentage,
  tags: userTags(value.tags),
});

export const MarketplaceGalleryImageProvider = () =>
  Provider.succeed(MarketplaceGalleryImage, {
    stables: [
      "marketplaceGalleryImageName",
      "resourceGroup",
      "marketplaceGalleryImageId",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* orUndefinedIfNotFound(
        hci
          .ListMarketplaceGalleryImageAll({ subscriptionId })
          .pipe(
            Effect.flatMap((page) =>
              requireSinglePage("ListMarketplaceGalleryImageAll", page),
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
          !sameId(news.name, output.marketplaceGalleryImageName)) ||
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
        output?.marketplaceGalleryImageName ??
        olds?.name ??
        (yield* createName(id));
      const observed = yield* getMarketplaceGalleryImage(
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
        news.name ??
        output?.marketplaceGalleryImageName ??
        (yield* createName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        marketplaceGalleryImageName: name,
      };
      const get = getMarketplaceGalleryImage(
        subscriptionId,
        resourceGroup,
        name,
      );
      const settle = waitForProvisioned(
        `Azure Local marketplace gallery image ${name}`,
        get,
        (value) => value.properties?.provisioningState,
        { interval: "10 seconds", times: 60 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure. Everything but tags is immutable (diff replaces), so the
      // PUT only runs when the marketplace gallery image is missing.
      if (observed === undefined) {
        yield* hci.MarketplaceGalleryImagesCreateOrUpdate({
          ...where,
          location,
          tags,
          extendedLocation: toExtendedLocation(news.extendedLocation),
          properties: {
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

      // Sync tags against the observed marketplace gallery image.
      if (tagsDiffer(observed.tags, tags)) {
        yield* hci.UpdateMarketplaceGalleryImage({ ...where, tags });
        observed = yield* settle;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        hci.DeleteMarketplaceGalleryImage({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          marketplaceGalleryImageName: output.marketplaceGalleryImageName,
        }),
      );
      yield* waitUntilGone(
        `Azure Local marketplace gallery image ${output.marketplaceGalleryImageName}`,
        getMarketplaceGalleryImage(
          subscriptionId,
          output.resourceGroup,
          output.marketplaceGalleryImageName,
        ),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
