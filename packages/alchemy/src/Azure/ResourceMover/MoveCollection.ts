import * as resourcemover from "@distilled.cloud/azure/resourcemover";
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

export type MoveCollectionMoveType = "RegionToRegion" | "RegionToZone";

export type MoveCollectionIdentityType = "None" | "SystemAssigned";

export interface MoveCollectionProps {
  /**
   * Resource group the move collection is created in. Changing it replaces
   * the collection.
   */
  resourceGroup: string;
  /**
   * Name of the move collection. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the collection.
   */
  name?: string;
  /**
   * Azure location that stores the collection's metadata (for example
   * `eastus2`). Changing it replaces the collection.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Kind of move: `RegionToRegion` moves resources between regions;
   * `RegionToZone` moves regional VMs into an availability zone. Changing it
   * replaces the collection.
   * @default "RegionToRegion"
   */
  moveType?: MoveCollectionMoveType;
  /**
   * Region the resources are moved from (`RegionToRegion` only). Changing it
   * replaces the collection.
   */
  sourceRegion?: string;
  /**
   * Region the resources are moved to (`RegionToRegion` only). Changing it
   * replaces the collection.
   */
  targetRegion?: string;
  /**
   * Region in which a regional-to-zonal VM move runs (`RegionToZone` only).
   * Changing it replaces the collection.
   */
  moveRegion?: string;
  /**
   * Version of the move collection. If omitted, Azure picks its current
   * version. Changing it replaces the collection.
   */
  version?: string;
  /**
   * Managed identity of the collection. Resource Mover uses a
   * system-assigned identity to prepare and move resources; it needs
   * Contributor and User Access Administrator on the subscription to do so.
   * @default "SystemAssigned"
   */
  identityType?: MoveCollectionIdentityType;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface MoveCollection extends Resource<
  "Azure.ResourceMover.MoveCollection",
  MoveCollectionProps,
  {
    /** Name of the move collection. */
    moveCollectionName: string;
    /** Resource group that holds the move collection. */
    resourceGroup: string;
    /** ARM resource ID of the move collection. */
    moveCollectionId: string;
    /** Location that stores the collection's metadata. */
    location: string;
    /** Kind of move (`RegionToRegion` or `RegionToZone`). */
    moveType: string;
    /** Region resources are moved from. */
    sourceRegion: string | undefined;
    /** Region resources are moved to. */
    targetRegion: string | undefined;
    /** Region a regional-to-zonal move runs in. */
    moveRegion: string | undefined;
    /** Version of the move collection. */
    version: string | undefined;
    /** Managed identity type of the collection. */
    identityType: string;
    /**
     * Object ID of the collection's system-assigned identity, for role
     * assignments that let Resource Mover read, prepare, and move
     * resources. Empty when the collection has no identity.
     */
    principalId: string;
    /** Microsoft Entra tenant of the collection's identity (empty if none). */
    tenantId: string;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Resource Mover move collection — the container that groups the
 * resources moved together from one region to another (or from a region
 * into an availability zone).
 *
 * The collection is free; the prepare/move/commit actions that drive a
 * move are imperative operations outside the IaC lifecycle.
 *
 * @see https://learn.microsoft.com/azure/resource-mover/overview
 *
 * ### Creating a Move Collection
 * **Example:** Region-to-region collection
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("moves", {
 *   location: "eastus2",
 * });
 * const collection = yield* Azure.ResourceMover.MoveCollection("eastToWest", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "eastus2",
 *   sourceRegion: "eastus",
 *   targetRegion: "westus2",
 * });
 * ```
 *
 * **Example:** Regional-to-zonal VM move
 * ```typescript
 * const collection = yield* Azure.ResourceMover.MoveCollection("toZone", {
 *   resourceGroup: group.resourceGroupName,
 *   moveType: "RegionToZone",
 *   moveRegion: "eastus",
 * });
 * ```
 *
 * ### Granting the Collection Access
 * **Example:** Let Resource Mover's identity act on the subscription
 * ```typescript
 * yield* Azure.Authorization.RoleAssignment("moverContributor", {
 *   scope: `/subscriptions/${subscriptionId}`,
 *   roleDefinitionId: Azure.Authorization.BuiltInRole.Contributor,
 *   principalId: collection.principalId,
 *   principalType: "ServicePrincipal",
 * });
 * ```
 *
 * @resource
 */
export const MoveCollection = Resource<MoveCollection>(
  "Azure.ResourceMover.MoveCollection",
);

const getCollection = (
  subscriptionId: string,
  resourceGroupName: string,
  moveCollectionName: string,
) =>
  orUndefinedIfNotFound(
    resourcemover.GetMoveCollection({
      subscriptionId,
      resourceGroupName,
      moveCollectionName,
    }),
  );

/** Physical name of a move collection: letters, digits, `-` and `_`. */
const createMoveCollectionName = (id: string) =>
  createPhysicalName({ id, maxLength: 64 });

const sameRegion = (a: string | undefined, b: string | undefined) =>
  (a ?? "").replaceAll(" ", "").toLowerCase() ===
  (b ?? "").replaceAll(" ", "").toLowerCase();

const toAttrs = (
  resourceGroup: string,
  name: string,
  collection: resourcemover.MoveCollection,
): MoveCollection["Attributes"] => ({
  moveCollectionName: name,
  resourceGroup,
  moveCollectionId: collection.id ?? "",
  location: collection.location ?? "",
  moveType: collection.properties?.moveType ?? "RegionToRegion",
  sourceRegion: collection.properties?.sourceRegion,
  targetRegion: collection.properties?.targetRegion,
  moveRegion: collection.properties?.moveRegion,
  version: collection.properties?.version,
  identityType: collection.identity?.type ?? "None",
  principalId: collection.identity?.principalId ?? "",
  tenantId: collection.identity?.tenantId ?? "",
  provisioningState: collection.properties?.provisioningState,
  tags: userTags(collection.tags),
});

export const MoveCollectionProvider = () =>
  Provider.succeed(MoveCollection, {
    stables: [
      "moveCollectionName",
      "resourceGroup",
      "moveCollectionId",
      "location",
      "moveType",
      "sourceRegion",
      "targetRegion",
      "moveRegion",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* resourcemover
        .MoveCollectionsListMoveCollectionsBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage(
              "MoveCollectionsListMoveCollectionsBySubscription",
              page,
            ),
          ),
        );
      return (page.value ?? []).flatMap((collection) => {
        const group = resourceGroupOf(collection.id);
        return hasAnyAlchemyTag(collection.tags) &&
          group !== undefined &&
          collection.name !== undefined
          ? [toAttrs(group, collection.name, collection)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !==
            output.moveCollectionName.toLowerCase()) ||
        (news.location !== undefined &&
          !sameRegion(news.location, output.location)) ||
        (news.moveType ?? "RegionToRegion") !== output.moveType ||
        (news.sourceRegion !== undefined &&
          !sameRegion(news.sourceRegion, output.sourceRegion)) ||
        (news.targetRegion !== undefined &&
          !sameRegion(news.targetRegion, output.targetRegion)) ||
        (news.moveRegion !== undefined &&
          !sameRegion(news.moveRegion, output.moveRegion)) ||
        (news.version !== undefined && news.version !== output.version)
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
        output?.moveCollectionName ??
        olds?.name ??
        (yield* createMoveCollectionName(id));
      const observed = yield* getCollection(
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
      yield* ensureRegistered(subscriptionId, "Microsoft.Migrate");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.moveCollectionName ??
        (yield* createMoveCollectionName(id));
      const location = news.location ?? output?.location ?? env.location;
      const identityType = news.identityType ?? "SystemAssigned";
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        moveCollectionName: name,
      };
      const get = getCollection(subscriptionId, resourceGroup, name);

      // Observe.
      const observed = yield* get;

      if (observed === undefined) {
        // Ensure: the PUT is synchronous but may report `Creating`.
        yield* resourcemover.CreateMoveCollection({
          ...where,
          location,
          tags,
          identity: { type: identityType },
          properties: {
            moveType: news.moveType ?? "RegionToRegion",
            sourceRegion: news.sourceRegion,
            targetRegion: news.targetRegion,
            moveRegion: news.moveRegion,
            version: news.version,
          },
        });
      } else {
        // Sync identity and tags against the observed collection.
        const identityChanged =
          (observed.identity?.type ?? "None") !== identityType;
        const tagsChanged = tagsDiffer(observed.tags, tags);
        if (identityChanged || tagsChanged) {
          yield* resourcemover.UpdateMoveCollection({
            ...where,
            ...(tagsChanged ? { tags } : {}),
            ...(identityChanged ? { identity: { type: identityType } } : {}),
          });
        }
      }

      const fresh = yield* waitForProvisioned(
        `move collection ${name}`,
        get,
        (collection) => collection.properties?.provisioningState,
      );
      return toAttrs(resourceGroup, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        resourcemover.DeleteMoveCollection({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          moveCollectionName: output.moveCollectionName,
        }),
      );
      yield* waitUntilGone(
        `move collection ${output.moveCollectionName}`,
        getCollection(
          subscriptionId,
          output.resourceGroup,
          output.moveCollectionName,
        ),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
