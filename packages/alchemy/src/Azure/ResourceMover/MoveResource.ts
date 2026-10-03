import * as resourcemover from "@distilled.cloud/azure/resourcemover";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  stackAndStage,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/** Target settings of a moved resource. */
export interface MoveResourceSettings {
  /**
   * ARM type of the resource being moved, e.g.
   * `Microsoft.Network/networkSecurityGroups` or
   * `Microsoft.Compute/virtualMachines`.
   */
  resourceType: string;
  /** Name of the resource in the target region. */
  targetResourceName?: string;
  /** Resource group of the resource in the target region. */
  targetResourceGroupName?: string;
}

/** Overrides the target of one of the moved resource's dependencies. */
export interface MoveResourceDependencyOverride {
  /** ARM ID of the dependent (source) resource. */
  id: string;
  /**
   * ARM ID of the move resource, or of an existing resource in the target
   * region, that replaces the dependency.
   */
  targetId: string;
}

export interface MoveResourceProps {
  /**
   * Resource group of the move collection. Changing it replaces the move
   * resource.
   */
  resourceGroup: string;
  /** Move collection that holds the resource. Changing it replaces the move resource. */
  moveCollection: string;
  /**
   * Name of the move resource. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the move resource.
   */
  name?: string;
  /**
   * ARM ID of the resource to move. It must live in the collection's source
   * region. Changing it replaces the move resource.
   */
  sourceId: string;
  /**
   * ARM ID of an existing resource in the target region to move into
   * instead of creating a new one. Changing it replaces the move resource.
   */
  existingTargetId?: string;
  /** Target settings (name and resource group in the target region). */
  resourceSettings?: MoveResourceSettings;
  /** Overrides for the targets of the resource's dependencies. */
  dependsOnOverrides?: MoveResourceDependencyOverride[];
}

export interface MoveResource extends Resource<
  "Azure.ResourceMover.MoveResource",
  MoveResourceProps,
  {
    /** Name of the move resource. */
    moveResourceName: string;
    /** Move collection that holds the resource. */
    moveCollection: string;
    /** Resource group of the move collection. */
    resourceGroup: string;
    /** ARM resource ID of the move resource. */
    moveResourceId: string;
    /** ARM ID of the resource being moved. */
    sourceId: string;
    /** ARM ID of the moved resource in the target region, once known. */
    targetId: string | undefined;
    /** Existing target resource the move goes into, if any. */
    existingTargetId: string | undefined;
    /** Target settings as Azure reports them. */
    resourceSettings: MoveResourceSettings | undefined;
    /**
     * Move state, e.g. `PreparePending`, `MovePending`, `CommitPending`,
     * `Committed`.
     */
    moveState: string | undefined;
    /** Whether dependencies must be resolved before the move can proceed. */
    isResolveRequired: boolean;
    /** Provisioning state reported by Azure. */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A resource added to an Azure Resource Mover move collection.
 *
 * Adding a resource only registers it for the move; preparing, moving and
 * committing it are imperative actions outside the IaC lifecycle. Move
 * resources have no tags, so Alchemy treats one as owned when its move
 * collection carries this stack's ownership tags.
 *
 * Azure adds the resource with the collection's managed identity, which
 * reads the source and writes a resource link onto it, so that identity
 * needs Contributor on the source resource (and Contributor plus User Access
 * Administrator on the subscription to later prepare and move it). Alchemy
 * re-sends the add while a fresh role assignment propagates.
 *
 * @see https://learn.microsoft.com/azure/resource-mover/overview
 *
 * ### Adding a Resource to a Collection
 * **Example:** Move a network security group to another region
 * ```typescript
 * const collection = yield* Azure.ResourceMover.MoveCollection("eastToWest", {
 *   resourceGroup: group.resourceGroupName,
 *   sourceRegion: "eastus",
 *   targetRegion: "westus2",
 * });
 * // Let the collection's identity read and link the resources to move.
 * const grant = yield* Azure.Authorization.RoleAssignment("moverContributor", {
 *   scope: group.resourceGroupId,
 *   roleDefinitionId: Azure.Authorization.BuiltInRole.Contributor,
 *   principalId: collection.principalId,
 *   principalType: "ServicePrincipal",
 * });
 * const nsg = yield* Azure.Network.NetworkSecurityGroup("web", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "eastus",
 * });
 * yield* Azure.ResourceMover.MoveResource("webNsg", {
 *   resourceGroup: group.resourceGroupName,
 *   // Order after the grant so it exists for the add and outlives the delete.
 *   moveCollection: Output.map(
 *     Output.all(collection.moveCollectionName, grant.roleAssignmentId),
 *     ([name]) => name,
 *   ),
 *   sourceId: nsg.networkSecurityGroupId,
 *   resourceSettings: {
 *     resourceType: "Microsoft.Network/networkSecurityGroups",
 *     targetResourceName: "web-nsg-westus2",
 *   },
 * });
 * ```
 *
 * ### Overriding Dependencies
 * **Example:** Point a dependency at an existing target resource
 * ```typescript
 * yield* Azure.ResourceMover.MoveResource("webNic", {
 *   resourceGroup: group.resourceGroupName,
 *   moveCollection: collection.moveCollectionName,
 *   sourceId: nic.networkInterfaceId,
 *   resourceSettings: {
 *     resourceType: "Microsoft.Network/networkInterfaces",
 *   },
 *   dependsOnOverrides: [
 *     { id: nsg.networkSecurityGroupId, targetId: existingTargetNsgId },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const MoveResource = Resource<MoveResource>(
  "Azure.ResourceMover.MoveResource",
);

const getMoveResource = (
  subscriptionId: string,
  resourceGroupName: string,
  moveCollectionName: string,
  moveResourceName: string,
) =>
  orUndefinedIfNotFound(
    resourcemover.GetMoveResource({
      subscriptionId,
      resourceGroupName,
      moveCollectionName,
      moveResourceName,
    }),
  );

const createMoveResourceName = (id: string) =>
  createPhysicalName({ id, maxLength: 64 });

const sameId = (a: string | undefined, b: string | undefined) =>
  (a ?? "").toLowerCase() === (b ?? "").toLowerCase();

const toSettings = (
  settings: resourcemover.ResourceSettings | undefined,
): MoveResourceSettings | undefined =>
  settings === undefined
    ? undefined
    : {
        resourceType: settings.resourceType,
        ...(settings.targetResourceName !== undefined
          ? { targetResourceName: settings.targetResourceName }
          : {}),
        ...(settings.targetResourceGroupName !== undefined
          ? { targetResourceGroupName: settings.targetResourceGroupName }
          : {}),
      };

const settingsDiffer = (
  observed: resourcemover.ResourceSettings | undefined,
  desired: MoveResourceSettings | undefined,
) =>
  desired !== undefined &&
  (observed === undefined ||
    observed.resourceType.toLowerCase() !==
      desired.resourceType.toLowerCase() ||
    (desired.targetResourceName !== undefined &&
      observed.targetResourceName !== desired.targetResourceName) ||
    (desired.targetResourceGroupName !== undefined &&
      !sameId(
        observed.targetResourceGroupName,
        desired.targetResourceGroupName,
      )));

const overridesKey = (
  overrides: readonly { id?: string; targetId?: string }[] | undefined,
) =>
  (overrides ?? [])
    .map(
      (o) =>
        `${(o.id ?? "").toLowerCase()}=>${(o.targetId ?? "").toLowerCase()}`,
    )
    .sort()
    .join("|");

const toAttrs = (
  resourceGroup: string,
  moveCollection: string,
  name: string,
  observed: resourcemover.MoveResource,
): MoveResource["Attributes"] => ({
  moveResourceName: name,
  moveCollection,
  resourceGroup,
  moveResourceId: observed.id ?? "",
  sourceId: observed.properties?.sourceId ?? "",
  targetId: observed.properties?.targetId,
  existingTargetId: observed.properties?.existingTargetId,
  resourceSettings: toSettings(observed.properties?.resourceSettings),
  moveState: observed.properties?.moveStatus?.moveState,
  isResolveRequired: observed.properties?.isResolveRequired ?? false,
  provisioningState: observed.properties?.provisioningState,
});

/** Whether the move collection carries this stack and stage's tags. */
const collectionOwned = (
  subscriptionId: string,
  resourceGroupName: string,
  moveCollectionName: string,
) =>
  Effect.gen(function* () {
    const collection = yield* orUndefinedIfNotFound(
      resourcemover.GetMoveCollection({
        subscriptionId,
        resourceGroupName,
        moveCollectionName,
      }),
    );
    const { stack, stage } = yield* stackAndStage;
    return (
      collection?.tags?.["alchemy::stack"] === stack &&
      collection?.tags?.["alchemy::stage"] === stage
    );
  });

export const MoveResourceProvider = () =>
  Provider.succeed(MoveResource, {
    stables: [
      "moveResourceName",
      "moveCollection",
      "resourceGroup",
      "moveResourceId",
      "sourceId",
      "existingTargetId",
    ],

    // Move resources live inside a move collection; nuke removes them with it.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.moveCollection.toLowerCase() !==
          output.moveCollection.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.moveResourceName.toLowerCase()) ||
        !sameId(news.sourceId, output.sourceId) ||
        !sameId(news.existingTargetId, output.existingTargetId)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const moveCollection = output?.moveCollection ?? olds?.moveCollection;
      if (resourceGroup === undefined || moveCollection === undefined) {
        return undefined;
      }
      const name =
        output?.moveResourceName ??
        olds?.name ??
        (yield* createMoveResourceName(id));
      const observed = yield* getMoveResource(
        subscriptionId,
        resourceGroup,
        moveCollection,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, moveCollection, name, observed);
      return (yield* collectionOwned(
        subscriptionId,
        resourceGroup,
        moveCollection,
      ))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Migrate");
      const { resourceGroup, moveCollection } = news;
      const name =
        news.name ??
        output?.moveResourceName ??
        (yield* createMoveResourceName(id));
      const get = getMoveResource(
        subscriptionId,
        resourceGroup,
        moveCollection,
        name,
      );

      // Observe.
      const observed = yield* get;

      // Ensure + sync: the PUT is an idempotent upsert of the whole move
      // resource, so send it when missing or when the observed settings or
      // dependency overrides drift from the desired ones.
      const needsPut =
        observed === undefined ||
        settingsDiffer(
          observed.properties?.resourceSettings,
          news.resourceSettings,
        ) ||
        overridesKey(observed.properties?.dependsOnOverrides) !==
          overridesKey(news.dependsOnOverrides);
      const waitReady = waitForProvisioned(
        `move resource ${name}`,
        get,
        (resource) => resource.properties?.provisioningState,
        { interval: "3 seconds", times: 10 },
      );
      const put = resourcemover.CreateMoveResource({
        subscriptionId,
        resourceGroupName: resourceGroup,
        moveCollectionName: moveCollection,
        moveResourceName: name,
        properties: {
          sourceId: news.sourceId,
          existingTargetId: news.existingTargetId,
          resourceSettings: news.resourceSettings,
          dependsOnOverrides: news.dependsOnOverrides,
        },
      });
      // The PUT is accepted (202) and validated asynchronously with the
      // collection's managed identity. A failed validation (typically the
      // identity's role assignment still propagating) leaves no move
      // resource behind, so re-send the PUT until it appears.
      const fresh = needsPut
        ? yield* put.pipe(
            Effect.andThen(waitReady),
            Effect.retry({
              while: (e) => e._tag === "Azure.ProvisioningTimedOut",
              times: 8,
            }),
          )
        : yield* waitReady;
      return toAttrs(resourceGroup, moveCollection, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        resourcemover.DeleteMoveResource({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          moveCollectionName: output.moveCollection,
          moveResourceName: output.moveResourceName,
        }),
      );
      yield* waitUntilGone(
        `move resource ${output.moveResourceName}`,
        getMoveResource(
          subscriptionId,
          output.resourceGroup,
          output.moveCollection,
          output.moveResourceName,
        ),
      );
    }),
  });
