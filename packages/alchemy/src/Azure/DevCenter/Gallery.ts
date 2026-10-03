import * as devcenter from "@distilled.cloud/azure/devcenter";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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
import {
  createDevCenterName,
  devCenterOwnedByStage,
  sameArm,
} from "./Common.ts";

export interface GalleryProps {
  /** Resource group of the dev center. Changing it replaces the gallery attachment. */
  resourceGroup: string;
  /** Name of the dev center. Changing it replaces the gallery attachment. */
  devCenter: string;
  /**
   * Gallery name within the dev center (`Default` is reserved for the
   * built-in marketplace gallery). If omitted, a unique name is generated
   * from the app, stage, and logical ID. Changing it replaces the
   * attachment.
   */
  name?: string;
  /**
   * ARM resource ID of the Azure Compute Gallery to attach. The dev
   * center's identity needs Contributor (or Compute Gallery Image Reader
   * and Reader) on it. Changing it replaces the attachment.
   */
  galleryResourceId: string;
}

export interface Gallery extends Resource<
  "Azure.DevCenter.Gallery",
  GalleryProps,
  {
    /** Name of the gallery in the dev center. */
    galleryName: string;
    /** ARM resource ID of the dev center gallery. */
    galleryId: string;
    /** Name of the dev center. */
    devCenter: string;
    /** Resource group of the dev center. */
    resourceGroup: string;
    /** ARM resource ID of the backing Azure Compute Gallery. */
    galleryResourceId: string;
  },
  never,
  Providers
> {}

/**
 * Attaches an Azure Compute Gallery to a dev center so dev box
 * definitions can use its custom images
 * (`{devCenterId}/galleries/{name}/images/{image}`).
 *
 * Galleries have no tags; Alchemy treats one as owned when its dev
 * center carries this stack's ownership tags.
 *
 * @see https://learn.microsoft.com/azure/dev-box/how-to-configure-azure-compute-gallery
 *
 * ### Attaching a Compute Gallery
 * **Example:** Grant the dev center access, then attach the gallery
 * ```typescript
 * const center = yield* Azure.DevCenter.DevCenter("center", {
 *   resourceGroup: group.resourceGroupName,
 *   identity: { type: "SystemAssigned" },
 * });
 * const access = yield* Azure.Authorization.RoleAssignment("gallery-access", {
 *   scope: computeGalleryId,
 *   // Contributor
 *   roleDefinitionId: "b24988ac-6180-42a0-ab88-20f7382dd24c",
 *   principalId: center.principalId,
 *   principalType: "ServicePrincipal",
 * });
 * const gallery = yield* Azure.DevCenter.Gallery("images", {
 *   resourceGroup: group.resourceGroupName,
 *   devCenter: center.devCenterName,
 *   galleryResourceId: computeGalleryId,
 * });
 * ```
 *
 * @resource
 */
export const Gallery = Resource<Gallery>("Azure.DevCenter.Gallery");

type Observed = devcenter.GetGalleryResponse;

const getGallery = (
  subscriptionId: string,
  resourceGroupName: string,
  devCenterName: string,
  galleryName: string,
) =>
  orUndefinedIfNotFound(
    devcenter.GetGallery({
      subscriptionId,
      resourceGroupName,
      devCenterName,
      galleryName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  devCenter: string,
  name: string,
  observed: Observed,
): Gallery["Attributes"] => ({
  galleryName: name,
  galleryId: observed.id ?? "",
  devCenter,
  resourceGroup,
  galleryResourceId: observed.properties?.galleryResourceId ?? "",
});

/** Gallery names allow letters, digits, underscores, and periods. */
const createGalleryName = Effect.fn(function* (id: string) {
  return (yield* createDevCenterName(id, 63)).replace(/-/g, "_");
});

export const GalleryProvider = () =>
  Provider.succeed(Gallery, {
    stables: [
      "galleryName",
      "galleryId",
      "devCenter",
      "resourceGroup",
      "galleryResourceId",
    ],

    // Galleries live inside a dev center; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.devCenter, output.devCenter) ||
        (news.name !== undefined && !sameArm(news.name, output.galleryName)) ||
        !sameArm(news.galleryResourceId, output.galleryResourceId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const devCenter = output?.devCenter ?? olds?.devCenter;
      if (resourceGroup === undefined || devCenter === undefined) {
        return undefined;
      }
      const name =
        output?.galleryName ?? olds?.name ?? (yield* createGalleryName(id));
      const observed = yield* getGallery(
        subscriptionId,
        resourceGroup,
        devCenter,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, devCenter, name, observed);
      return (yield* devCenterOwnedByStage(
        subscriptionId,
        resourceGroup,
        devCenter,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.DevCenter");
      const { resourceGroup, devCenter } = news;
      const name =
        news.name ?? output?.galleryName ?? (yield* createGalleryName(id));
      const get = getGallery(subscriptionId, resourceGroup, devCenter, name);

      // Observe; existence-only (no PATCH), so ensure is the whole reconcile.
      const observed = yield* get;
      if (observed === undefined) {
        yield* devcenter.GalleriesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          devCenterName: devCenter,
          galleryName: name,
          properties: { galleryResourceId: news.galleryResourceId },
        }).pipe(
          // A fresh role assignment for the dev center's identity takes a
          // few minutes to propagate to the Dev Center RP.
          Effect.retry({
            while: (e) => e._tag === "DevCenterNotAuthorizedToGallery",
            schedule: Schedule.spaced("10 seconds"),
            times: 30,
          }),
        );
      }
      const fresh = yield* waitForProvisioned(
        `dev center gallery ${name}`,
        get,
        (value) => value.properties?.provisioningState,
        { interval: "5 seconds", times: 72 },
      );
      return toAttrs(resourceGroup, devCenter, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        devcenter.DeleteGallery({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          devCenterName: output.devCenter,
          galleryName: output.galleryName,
        }),
      );
      yield* waitUntilGone(
        `dev center gallery ${output.galleryName}`,
        getGallery(
          subscriptionId,
          output.resourceGroup,
          output.devCenter,
          output.galleryName,
        ),
        { interval: "5 seconds", times: 72 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.DevCenter.DevCenter", "Azure.Resources.ResourceGroup"],
    },
  });
