import * as cs from "@distilled.cloud/azure/containerservice";
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
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { createChildName, sameName } from "./Common.ts";

export interface SnapshotProps {
  /** Resource group of the snapshot. Changing it replaces the snapshot. */
  resourceGroup: string;
  /**
   * Snapshot name. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing it replaces the snapshot.
   */
  name?: string;
  /**
   * Azure location of the snapshot (must match the source pool's).
   * Changing it replaces the snapshot.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM resource ID of the agent pool to snapshot (its node image and
   * configuration). Changing it replaces the snapshot.
   */
  sourceAgentPoolId: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Snapshot extends Resource<
  "Azure.ContainerService.Snapshot",
  SnapshotProps,
  {
    /** Name of the snapshot. */
    snapshotName: string;
    /** ARM resource ID of the snapshot; use as an agent pool's `creationData`. */
    snapshotId: string;
    /** Resource group of the snapshot. */
    resourceGroup: string;
    /** Location of the snapshot. */
    location: string;
    /** ARM resource ID of the source agent pool. */
    sourceAgentPoolId: string;
    /** Kubernetes version captured by the snapshot. */
    kubernetesVersion: string | undefined;
    /** Node image version captured by the snapshot. */
    nodeImageVersion: string | undefined;
    /** OS type of the captured nodes. */
    osType: string | undefined;
    /** OS SKU of the captured nodes. */
    osSku: string | undefined;
    /** VM size of the captured nodes. */
    vmSize: string | undefined;
    /** Whether the captured nodes are FIPS-enabled. */
    enableFIPS: boolean | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An AKS node pool snapshot: the node image and configuration of an agent
 * pool, used to create or upgrade pools to a known-good image.
 *
 * @see https://learn.microsoft.com/azure/aks/node-pool-snapshot
 *
 * ### Snapshotting a Node Pool
 * **Example:** Snapshot the system pool
 * ```typescript
 * const snapshot = yield* Azure.ContainerService.Snapshot("golden", {
 *   resourceGroup: group.resourceGroupName,
 *   sourceAgentPoolId: pool.agentPoolId,
 *   tags: { purpose: "golden-image" },
 * });
 * ```
 *
 * @resource
 */
export const Snapshot = Resource<Snapshot>("Azure.ContainerService.Snapshot");

type ObservedSnapshot = cs.GetSnapshotResponse;

const createSnapshotName = (id: string) => createChildName(id, 80);

const getSnapshot = (
  subscriptionId: string,
  resourceGroupName: string,
  resourceName: string,
) =>
  orUndefinedIfNotFound(
    cs.GetSnapshot({ subscriptionId, resourceGroupName, resourceName }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  snapshot: ObservedSnapshot,
): Snapshot["Attributes"] => {
  const props = snapshot.properties ?? {};
  return {
    snapshotName: name,
    snapshotId: snapshot.id ?? "",
    resourceGroup,
    location: snapshot.location,
    sourceAgentPoolId: props.creationData?.sourceResourceId ?? "",
    kubernetesVersion: props.kubernetesVersion,
    nodeImageVersion: props.nodeImageVersion,
    osType: props.osType,
    osSku: props.osSku,
    vmSize: props.vmSize,
    enableFIPS: props.enableFIPS,
    tags: userTags(snapshot.tags),
  };
};

const lower = (value: string | undefined) => value?.toLowerCase();

export const SnapshotProvider = () =>
  Provider.succeed(Snapshot, {
    stables: [
      "snapshotName",
      "snapshotId",
      "resourceGroup",
      "location",
      "sourceAgentPoolId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* cs
        .ListSnapshots({ subscriptionId })
        .pipe(
          Effect.flatMap((page) => requireSinglePage("ListSnapshots", page)),
        );
      return (page.value ?? []).flatMap((snapshot) => {
        const group = resourceGroupOf(snapshot.id);
        return hasAnyAlchemyTag(snapshot.tags) &&
          group !== undefined &&
          snapshot.name !== undefined
          ? [toAttrs(group, snapshot.name, snapshot)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameName(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined && news.name !== output.snapshotName) ||
        (news.location !== undefined &&
          lower(news.location) !== lower(output.location)) ||
        !sameName(news.sourceAgentPoolId, output.sourceAgentPoolId)
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
        output?.snapshotName ?? olds?.name ?? (yield* createSnapshotName(id));
      const observed = yield* getSnapshot(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.ContainerService");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.snapshotName ?? (yield* createSnapshotName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        resourceName: name,
      };
      const get = getSnapshot(subscriptionId, resourceGroup, name);
      const waitReady = waitForProvisioned(
        `snapshot ${name}`,
        get,
        () => undefined,
        { interval: "5 seconds", times: 36 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure. The snapshot content is immutable.
      if (observed === undefined) {
        yield* cs.SnapshotsCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: {
            snapshotType: "NodePool",
            creationData: { sourceResourceId: news.sourceAgentPoolId },
          },
        });
        observed = yield* waitReady;
      }

      // Sync tags.
      if (tagsDiffer(observed.tags, tags)) {
        yield* cs.UpdateSnapshotTags({ ...where, tags });
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        cs.DeleteSnapshot({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          resourceName: output.snapshotName,
        }),
      );
      yield* waitUntilGone(
        `snapshot ${output.snapshotName}`,
        getSnapshot(subscriptionId, output.resourceGroup, output.snapshotName),
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
