import * as batch from "@distilled.cloud/azure/batch";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
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
import { createBatchChildName, matches, sameValue } from "./Common.ts";

export interface BatchPoolIdentityProps {
  /** Identity type. */
  type: "UserAssigned" | "None";
  /** ARM resource IDs of the user-assigned identities. */
  userAssignedIdentityIds?: string[];
}

export interface PoolProps {
  /** Resource group of the Batch account. Changing it replaces the pool. */
  resourceGroup: string;
  /** Name of the Batch account. Changing it replaces the pool. */
  account: string;
  /**
   * Pool name: 1-64 letters, digits, hyphens, and underscores, unique
   * within the account. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the pool.
   */
  name?: string;
  /** Display name of the pool (up to 1024 characters). */
  displayName?: string;
  /**
   * VM size of the compute nodes, e.g. `Standard_D2s_v3`. Changing it
   * replaces the pool.
   */
  vmSize: string;
  /**
   * OS image, node agent SKU, disks, containers, and extensions of the
   * nodes. Changing it replaces the pool.
   */
  virtualMachineConfiguration: batch.VirtualMachineConfiguration;
  /**
   * Pool size: a fixed node count or an autoscale formula.
   * @default fixed scale with 0 dedicated nodes
   */
  scaleSettings?: batch.ScaleSettings;
  /** Virtual network and public IP configuration. Changing it replaces the pool. */
  networkConfiguration?: batch.NetworkConfiguration;
  /**
   * Whether nodes may communicate directly with each other (multi-instance
   * tasks). Changing it replaces the pool.
   * @default "Disabled"
   */
  interNodeCommunication?: "Enabled" | "Disabled";
  /**
   * Task slots per node. Changing it replaces the pool.
   * @default 1
   */
  taskSlotsPerNode?: number;
  /** How tasks are distributed across nodes. */
  taskSchedulingPolicy?: batch.TaskSchedulingPolicy;
  /** User accounts created on each node. Changing it replaces the pool. */
  userAccounts?: batch.UserAccount[];
  /** File systems mounted on each node. Changing it replaces the pool. */
  mountConfiguration?: batch.MountConfiguration[];
  /** Free-form name/value metadata for your own use. */
  metadata?: Record<string, string>;
  /** Task each node runs when it joins the pool (or reboots/reimages). */
  startTask?: batch.StartTask;
  /** Application packages installed on each new node (up to 10). */
  applicationPackages?: batch.ApplicationPackageReference[];
  /** OS upgrade policy of the nodes. */
  upgradePolicy?: batch.UpgradePolicy;
  /** User-assigned identities of the nodes. */
  identity?: BatchPoolIdentityProps;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Pool extends Resource<
  "Azure.Batch.Pool",
  PoolProps,
  {
    /** Name of the pool. */
    poolName: string;
    /** ARM resource ID of the pool. */
    poolId: string;
    /** Name of the Batch account. */
    account: string;
    /** Resource group of the Batch account. */
    resourceGroup: string;
    /** VM size of the nodes. */
    vmSize: string | undefined;
    /** Allocation state: `Steady`, `Resizing`, or `Stopping`. */
    allocationState: string | undefined;
    /** Dedicated nodes currently in the pool. */
    currentDedicatedNodes: number | undefined;
    /** Spot/low-priority nodes currently in the pool. */
    currentLowPriorityNodes: number | undefined;
    /** Error of the last resize, if it failed (e.g. insufficient core quota). */
    resizeError: string | undefined;
    /** Pool metadata. */
    metadata: Record<string, string>;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Batch pool — a set of compute nodes (VMs) that run Batch tasks. Nodes
 * bill as VMs; a pool with zero target nodes is free.
 *
 * Reconcile waits until the pool's allocation settles (`Steady`). A resize
 * that Azure cannot satisfy (e.g. insufficient core quota) settles with
 * `resizeError` set rather than failing the deploy.
 *
 * @see https://learn.microsoft.com/azure/batch/nodes-and-pools
 *
 * ### Creating a Pool
 * **Example:** Empty Ubuntu pool
 * ```typescript
 * const pool = yield* Azure.Batch.Pool("workers", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   vmSize: "Standard_D2s_v3",
 *   virtualMachineConfiguration: {
 *     imageReference: {
 *       publisher: "canonical",
 *       offer: "0001-com-ubuntu-server-jammy",
 *       sku: "22_04-lts",
 *     },
 *     nodeAgentSkuId: "batch.node.ubuntu 22.04",
 *   },
 *   scaleSettings: { fixedScale: { targetDedicatedNodes: 0 } },
 * });
 * ```
 *
 * ### Autoscaling
 * **Example:** Scale on pending tasks
 * ```typescript
 * const pool = yield* Azure.Batch.Pool("workers", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   vmSize: "Standard_D2s_v3",
 *   virtualMachineConfiguration,
 *   scaleSettings: {
 *     autoScale: {
 *       formula: "$TargetDedicatedNodes = min(4, $PendingTasks.GetSample(1));",
 *       evaluationInterval: "PT5M",
 *     },
 *   },
 * });
 * ```
 *
 * ### Start Tasks and Application Packages
 * **Example:** Install an application on every node
 * ```typescript
 * const pool = yield* Azure.Batch.Pool("workers", {
 *   resourceGroup: group.resourceGroupName,
 *   account: account.accountName,
 *   vmSize: "Standard_D2s_v3",
 *   virtualMachineConfiguration,
 *   applicationPackages: [{ id: app.applicationId, version: "1.0.0" }],
 *   startTask: {
 *     commandLine: "/bin/sh -c 'echo ready'",
 *     waitForSuccess: true,
 *   },
 * });
 * ```
 *
 * @resource
 */
export const Pool = Resource<Pool>("Azure.Batch.Pool");

type ObservedPool = batch.GetPoolResponse;

const getPool = (
  subscriptionId: string,
  resourceGroupName: string,
  accountName: string,
  poolName: string,
) =>
  orUndefinedIfNotFound(
    batch.GetPool({ subscriptionId, resourceGroupName, accountName, poolName }),
  );

const toMetadata = (metadata: Record<string, string> | undefined) =>
  Object.entries(metadata ?? {}).map(([name, value]) => ({ name, value }));

const fromMetadata = (items: readonly batch.MetadataItem[] | undefined) =>
  Object.fromEntries((items ?? []).map((item) => [item.name, item.value]));

const toIdentity = (
  identity: BatchPoolIdentityProps,
): batch.BatchPoolIdentityInput => ({
  type: identity.type,
  userAssignedIdentities: identity.userAssignedIdentityIds?.length
    ? Object.fromEntries(identity.userAssignedIdentityIds.map((i) => [i, {}]))
    : undefined,
});

const toAttrs = (
  resourceGroup: string,
  account: string,
  name: string,
  pool: ObservedPool,
): Pool["Attributes"] => {
  const props = pool.properties;
  const errors = props?.resizeOperationStatus?.errors;
  return {
    poolName: name,
    poolId: pool.id ?? "",
    account,
    resourceGroup,
    vmSize: props?.vmSize,
    allocationState: props?.allocationState,
    currentDedicatedNodes: props?.currentDedicatedNodes,
    currentLowPriorityNodes: props?.currentLowPriorityNodes,
    resizeError: errors?.length
      ? errors.map((e) => `${e.code}: ${e.message}`).join("; ")
      : undefined,
    metadata: fromMetadata(props?.metadata),
    tags: userTags(pool.tags),
  };
};

export const PoolProvider = () =>
  Provider.succeed(Pool, {
    stables: ["poolName", "poolId", "account", "resourceGroup"],

    // Pools are deleted with their Batch account.
    list: Effect.fn(function* () {
      return [];
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        news.resourceGroup.toLowerCase() !==
          output.resourceGroup.toLowerCase() ||
        news.account.toLowerCase() !== output.account.toLowerCase() ||
        (news.name !== undefined &&
          news.name.toLowerCase() !== output.poolName.toLowerCase()) ||
        news.vmSize.toLowerCase() !==
          (olds?.vmSize ?? output.vmSize ?? "").toLowerCase() ||
        !sameValue(
          news.virtualMachineConfiguration,
          olds?.virtualMachineConfiguration,
        ) ||
        !sameValue(news.networkConfiguration, olds?.networkConfiguration) ||
        (news.interNodeCommunication ?? "Disabled") !==
          (olds?.interNodeCommunication ?? "Disabled") ||
        (news.taskSlotsPerNode ?? 1) !== (olds?.taskSlotsPerNode ?? 1) ||
        !sameValue(news.userAccounts ?? [], olds?.userAccounts ?? []) ||
        !sameValue(
          news.mountConfiguration ?? [],
          olds?.mountConfiguration ?? [],
        )
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const account = output?.account ?? olds?.account;
      if (resourceGroup === undefined || account === undefined) {
        return undefined;
      }
      const name =
        output?.poolName ?? olds?.name ?? (yield* createBatchChildName(id));
      const observed = yield* getPool(
        subscriptionId,
        resourceGroup,
        account,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, account, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.Batch");
      const { resourceGroup, account } = news;
      const name =
        news.name ?? output?.poolName ?? (yield* createBatchChildName(id));
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        accountName: account,
        poolName: name,
      };
      const label = `batch pool ${name}`;
      const get = getPool(subscriptionId, resourceGroup, account, name);
      const scaleSettings = news.scaleSettings ?? {
        fixedScale: { targetDedicatedNodes: 0 },
      };
      const metadata = toMetadata(news.metadata);

      // Observe.
      let observed = yield* get;

      // Ensure: the PUT is synchronous; node allocation continues async.
      if (observed === undefined) {
        observed = yield* batch.CreatePool({
          ...where,
          tags,
          identity: news.identity ? toIdentity(news.identity) : undefined,
          properties: {
            displayName: news.displayName,
            vmSize: news.vmSize,
            deploymentConfiguration: {
              virtualMachineConfiguration: news.virtualMachineConfiguration,
            },
            scaleSettings,
            networkConfiguration: news.networkConfiguration,
            interNodeCommunication: news.interNodeCommunication,
            taskSlotsPerNode: news.taskSlotsPerNode,
            taskSchedulingPolicy: news.taskSchedulingPolicy,
            userAccounts: news.userAccounts,
            mountConfiguration: news.mountConfiguration,
            metadata: metadata.length > 0 ? metadata : undefined,
            startTask: news.startTask,
            applicationPackages: news.applicationPackages,
            upgradePolicy: news.upgradePolicy,
          },
        });
      }

      // Sync mutable aspects against observed state; PATCH only deltas.
      const props = observed.properties ?? {};
      const changed: batch.PoolPropertiesInput = {};
      if (
        news.displayName !== undefined &&
        props.displayName !== news.displayName
      ) {
        changed.displayName = news.displayName;
      }
      // Switching between fixed and auto scale must not carry the other mode.
      if (
        !matches(scaleSettings, props.scaleSettings) ||
        (scaleSettings.fixedScale === undefined) !==
          (props.scaleSettings?.fixedScale === undefined)
      ) {
        changed.scaleSettings = scaleSettings;
      }
      if (
        news.taskSchedulingPolicy !== undefined &&
        !matches(news.taskSchedulingPolicy, props.taskSchedulingPolicy)
      ) {
        changed.taskSchedulingPolicy = news.taskSchedulingPolicy;
      }
      if (
        !matches(news.metadata ?? {}, fromMetadata(props.metadata)) ||
        !matches(fromMetadata(props.metadata), news.metadata ?? {})
      ) {
        changed.metadata = metadata;
      }
      if (news.startTask !== undefined) {
        if (!matches(news.startTask, props.startTask)) {
          changed.startTask = news.startTask;
        }
      } else if (props.startTask?.commandLine !== undefined) {
        // An empty object removes the start task.
        changed.startTask = {};
      }
      if (
        !matches(
          news.applicationPackages ?? [],
          props.applicationPackages ?? [],
        )
      ) {
        changed.applicationPackages = news.applicationPackages ?? [];
      }
      if (
        news.upgradePolicy !== undefined &&
        !matches(news.upgradePolicy, props.upgradePolicy)
      ) {
        changed.upgradePolicy = news.upgradePolicy;
      }
      const identityChanged =
        news.identity !== undefined &&
        (news.identity.type.toLowerCase() !==
          (observed.identity?.type ?? "None").toLowerCase() ||
          !sameValue(
            (news.identity.userAssignedIdentityIds ?? [])
              .map((i) => i.toLowerCase())
              .sort(),
            Object.keys(observed.identity?.userAssignedIdentities ?? {})
              .map((i) => i.toLowerCase())
              .sort(),
          ));
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (Object.keys(changed).length > 0 || identityChanged || tagsChanged) {
        yield* batch.UpdatePool({
          ...where,
          tags: tagsChanged ? tags : undefined,
          identity:
            identityChanged && news.identity
              ? toIdentity(news.identity)
              : undefined,
          properties: Object.keys(changed).length > 0 ? changed : undefined,
        });
      }

      // Block until the pool exists and its allocation has settled.
      const fresh = yield* waitForProvisioned(
        label,
        get,
        (pool) =>
          pool.properties?.provisioningState === "Deleting"
            ? "Failed"
            : pool.properties?.allocationState === "Steady"
              ? "Succeeded"
              : (pool.properties?.allocationState ?? "Resizing"),
        { interval: "5 seconds", times: 60 },
      );
      return toAttrs(resourceGroup, account, name, fresh);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        batch.DeletePool({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          accountName: output.account,
          poolName: output.poolName,
        }),
      );
      // Pool deletion is asynchronous (`provisioningState: Deleting`).
      yield* waitUntilGone(
        `batch pool ${output.poolName}`,
        getPool(
          subscriptionId,
          output.resourceGroup,
          output.account,
          output.poolName,
        ),
        { interval: "5 seconds", times: 72 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.Batch.Account", "Azure.Resources.ResourceGroup"],
    },
  });
