import * as compute from "@distilled.cloud/azure/compute";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  ensureRegistered,
  ignoreNotFound,
  orUndefinedIfNotFound,
  ProvisioningFailed,
  stackAndStage,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  canonical,
  createComputeName,
  sameId,
  waitComputeGone,
  waitComputeProvisioned,
} from "./common.ts";

export interface RestorePointProps {
  /**
   * Resource group of the restore point collection. Changing it replaces
   * the restore point.
   */
  resourceGroup: string;
  /**
   * Name of the restore point collection. Changing it replaces the restore
   * point.
   */
  restorePointCollection: string;
  /**
   * Name of the restore point. If omitted, a unique name is generated from
   * the app, stage, and logical ID. Changing it replaces the restore point.
   */
  name?: string;
  /**
   * Consistency of the snapshot. `ApplicationConsistent` needs a running
   * VM with the guest agent. Changing it replaces the restore point.
   * @default Azure's default (`ApplicationConsistent` when supported, else `CrashConsistent`)
   */
  consistencyMode?:
    | "CrashConsistent"
    | "FileSystemConsistent"
    | "ApplicationConsistent";
  /**
   * ARM IDs of managed disks to leave out. Changing them replaces the
   * restore point.
   */
  excludeDiskIds?: string[];
  /**
   * ARM ID of a restore point in another region to copy. Changing it
   * replaces the restore point.
   */
  sourceRestorePointId?: string;
  /**
   * Minutes the snapshots stay in instant-access storage. Changing it
   * replaces the restore point.
   */
  instantAccessDurationMinutes?: number;
}

export interface RestorePoint extends Resource<
  "Azure.Compute.RestorePoint",
  RestorePointProps,
  {
    /** Name of the restore point. */
    restorePointName: string;
    /** ARM resource ID of the restore point. */
    restorePointId: string;
    /** Name of the restore point collection. */
    restorePointCollection: string;
    /** Resource group of the collection. */
    resourceGroup: string;
    /** Consistency the snapshot was taken with. */
    consistencyMode: string | undefined;
    /** Time the restore point was taken (ISO 8601). */
    timeCreated: string | undefined;
    /** Provisioning state (`Succeeded` once the snapshots exist). */
    provisioningState: string | undefined;
  },
  never,
  Providers
> {}

/**
 * A restore point of an Azure VM — point-in-time snapshots of the VM's
 * disks plus its configuration, inside a `RestorePointCollection`.
 * Restore points are immutable: changing any input takes a new one.
 * Restore points have no tags; ownership follows the parent collection's
 * Alchemy tags. VMs on NVMe-only sizes (e.g. the v6/v7 families) cannot
 * take restore points: the create ends in `Failed`.
 *
 * @see https://learn.microsoft.com/azure/virtual-machines/virtual-machines-create-restore-points
 *
 * ### Taking a Restore Point
 * **Example:** Crash-consistent snapshot of all disks
 * ```typescript
 * const point = yield* Azure.Compute.RestorePoint("nightly", {
 *   resourceGroup: group.resourceGroupName,
 *   restorePointCollection: collection.restorePointCollectionName,
 *   consistencyMode: "CrashConsistent",
 * });
 * ```
 *
 * **Example:** Snapshot that skips a scratch data disk
 * ```typescript
 * yield* Azure.Compute.RestorePoint("os-only", {
 *   resourceGroup: group.resourceGroupName,
 *   restorePointCollection: collection.restorePointCollectionName,
 *   excludeDiskIds: [scratchDiskId],
 * });
 * ```
 *
 * @resource
 */
export const RestorePoint = Resource<RestorePoint>(
  "Azure.Compute.RestorePoint",
);

type Observed = compute.GetRestorePointResponse;

const getPoint = (
  subscriptionId: string,
  resourceGroupName: string,
  restorePointCollectionName: string,
  restorePointName: string,
) =>
  orUndefinedIfNotFound(
    compute.GetRestorePoint({
      subscriptionId,
      resourceGroupName,
      restorePointCollectionName,
      restorePointName,
      _expand: "instanceView",
    }),
  );

const toAttrs = (
  resourceGroup: string,
  collection: string,
  name: string,
  point: Observed,
): RestorePoint["Attributes"] => ({
  restorePointName: name,
  restorePointId: point.id ?? "",
  restorePointCollection: collection,
  resourceGroup,
  consistencyMode: point.properties?.consistencyMode,
  timeCreated: point.properties?.timeCreated,
  provisioningState: point.properties?.provisioningState,
});

const inputKey = (p: RestorePointProps) =>
  canonical({
    consistencyMode: p.consistencyMode,
    excludeDiskIds: (p.excludeDiskIds ?? [])
      .map((id) => id.toLowerCase())
      .sort(),
    sourceRestorePointId: p.sourceRestorePointId?.toLowerCase(),
    instantAccessDurationMinutes: p.instantAccessDurationMinutes,
  });

export const RestorePointProvider = () =>
  Provider.succeed(RestorePoint, {
    stables: [
      "restorePointName",
      "restorePointId",
      "restorePointCollection",
      "resourceGroup",
      "consistencyMode",
      "timeCreated",
    ],

    // Restore points are deleted with their collection.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameId(news.resourceGroup, output.resourceGroup) ||
        !sameId(news.restorePointCollection, output.restorePointCollection) ||
        (news.name !== undefined && news.name !== output.restorePointName) ||
        (olds !== undefined && inputKey(news) !== inputKey(olds))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const collection =
        output?.restorePointCollection ?? olds?.restorePointCollection;
      if (resourceGroup === undefined || collection === undefined) {
        return undefined;
      }
      const name =
        output?.restorePointName ??
        olds?.name ??
        (yield* createComputeName(id));
      const observed = yield* getPoint(
        subscriptionId,
        resourceGroup,
        collection,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, collection, name, observed);
      // No tags on restore points: the parent's stack/stage tags mark
      // ownership.
      const parent = yield* orUndefinedIfNotFound(
        compute.GetRestorePointCollection({
          subscriptionId,
          resourceGroupName: resourceGroup,
          restorePointCollectionName: collection,
        }),
      );
      const { stack, stage } = yield* stackAndStage;
      const owned =
        parent?.tags?.["alchemy::stack"] === stack &&
        parent?.tags?.["alchemy::stage"] === stage;
      return owned ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Compute");
      const resourceGroup = news.resourceGroup;
      const collection = news.restorePointCollection;
      const name =
        news.name ?? output?.restorePointName ?? (yield* createComputeName(id));
      const get = getPoint(subscriptionId, resourceGroup, collection, name);

      // Observe; restore points are existence-only (no sync step).
      const observed = yield* get;
      if (observed === undefined) {
        yield* compute.CreateRestorePoint({
          subscriptionId,
          resourceGroupName: resourceGroup,
          restorePointCollectionName: collection,
          restorePointName: name,
          properties: {
            consistencyMode: news.consistencyMode,
            excludeDisks: news.excludeDiskIds?.map((diskId) => ({
              id: diskId,
            })),
            sourceRestorePoint:
              news.sourceRestorePointId === undefined
                ? undefined
                : { id: news.sourceRestorePointId },
            instantAccessDurationMinutes: news.instantAccessDurationMinutes,
          },
        });
      }
      const ready = yield* waitComputeProvisioned(
        `restore point ${name}`,
        get,
        {
          interval: "5 seconds",
          times: 120,
        },
      ).pipe(
        // Surface Azure's reason (instance view statuses) on failure.
        Effect.catchTag("Azure.ProvisioningFailed", (failure) =>
          get.pipe(
            Effect.flatMap((point) =>
              Effect.fail(
                new ProvisioningFailed({
                  resource: failure.resource,
                  state: failure.state,
                  message: `${failure.message}: ${(
                    point?.properties?.instanceView?.statuses ?? []
                  )
                    .map((status) => status.message ?? status.code)
                    .join("; ")}`,
                }),
              ),
            ),
          ),
        ),
      );
      return toAttrs(resourceGroup, collection, name, ready);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        compute.DeleteRestorePoint({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          restorePointCollectionName: output.restorePointCollection,
          restorePointName: output.restorePointName,
        }),
      );
      yield* waitComputeGone(
        `restore point ${output.restorePointName}`,
        getPoint(
          subscriptionId,
          output.resourceGroup,
          output.restorePointCollection,
          output.restorePointName,
        ),
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Compute.RestorePointCollection",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
