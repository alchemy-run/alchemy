import * as standbypool from "@distilled.cloud/azure/standbypool";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import * as Provider from "alchemy/Provider";
import type { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import {
  collectAll,
  desiredTags,
  ensureRegistered,
  hasAnyAlchemyTag,
  ignoreNotFound,
  isOwned,
  orUndefinedIfNotFound,
  resourceGroupOf,
  tagsDiffer,
  userTags,
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { GroupedResource } from "../StackResourceGroup.ts";
import { createStandbyPoolName, lower, sameLocation } from "./common.ts";

export type StandbyVirtualMachineState = "Running" | "Deallocated" | "Hibernated" | "Mix";

export interface VirtualMachinePoolProps {
  /**
   * Resource group the pool is created in. Changing it replaces the pool.
   * @default the stack's resource group (`<stack>-<stage>`)
   */
  resourceGroup: string;
  /**
   * Pool name: 3-24 letters, digits, and hyphens. If omitted, a unique name
   * is generated from the app, stage, and logical ID. Changing it replaces
   * the pool.
   * @default a unique name generated from the app, stage, and logical ID
   */
  name?: string;
  /**
   * Azure location. Must match the scale set's location. Changing it
   * replaces the pool.
   * @default the `Azure.Location` layer, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the Flexible-orchestration virtual machine scale set the pool
   * feeds, e.g. `scaleSet.virtualMachineScaleSetId`.
   * @default not attached
   */
  attachedVirtualMachineScaleSetId?: string;
  /**
   * State the standby VMs are kept in. `Deallocated` VMs only bill for
   * disks; `Mix` uses {@link vmStateDistribution}.
   * @default "Deallocated"
   */
  virtualMachineState?: StandbyVirtualMachineState;
  /**
   * Percentages of standby VMs per state; only with `virtualMachineState: "Mix"`.
   * @default not set
   */
  vmStateDistribution?: {
    /**
     * Percentage of VMs kept running.
     * @default 0
     */
    runningPercent?: number;
    /**
     * Percentage of VMs kept deallocated.
     * @default 0
     */
    deallocatedPercent?: number;
    /**
     * Percentage of VMs kept hibernated.
     * @default 0
     */
    hibernatedPercent?: number;
  };
  /** Maximum number of standby VMs in the pool. */
  maxReadyCapacity: number;
  /**
   * Desired minimum number of standby VMs; cannot exceed `maxReadyCapacity`.
   * @default Azure's default
   */
  minReadyCapacity?: number;
  /**
   * Delay after VM provisioning before the VM is available, as an ISO 8601
   * duration (e.g. `PT2S`).
   * @default no delay
   */
  postProvisioningDelay?: string;
  /**
   * Let Azure size the pool dynamically from usage forecasts.
   * @default false
   */
  dynamicSizing?: boolean;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   * @default {}
   */
  tags?: Record<string, string>;
}

export interface VirtualMachinePool extends Resource<
  "Azure.StandbyPool.VirtualMachinePool",
  VirtualMachinePoolProps,
  {
    /** Name of the pool. */
    standbyVirtualMachinePoolName: string;
    /** ARM resource ID of the pool. */
    standbyVirtualMachinePoolId: string;
    /** Resource group that holds the pool. */
    resourceGroup: string;
    /** Location of the pool. */
    location: string;
    /** Last provisioning state reported by Azure. */
    provisioningState: string | undefined;
    /** Scale set the pool is attached to. */
    attachedVirtualMachineScaleSetId: string | undefined;
    /** State the standby VMs are kept in. */
    virtualMachineState: string | undefined;
    /** Maximum number of standby VMs. */
    maxReadyCapacity: number | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure standby virtual machine pool
 * (`Microsoft.StandbyPool/standbyVirtualMachinePools`). It keeps
 * pre-provisioned VMs ready (running, deallocated, or hibernated) for a
 * Flexible-orchestration scale set, so scale-out picks up a warm VM instead
 * of creating one. See the
 * [Azure docs](https://learn.microsoft.com/azure/virtual-machine-scale-sets/standby-pools-overview).
 *
 * The pool itself is free. Standby VMs bill like scale-set VMs, and
 * `Deallocated` ones only bill for their disks.
 *
 * :::caution
 * The "Standby Pool Resource Provider" service principal needs `Virtual
 * Machine Contributor`, `Network Contributor`, and `Managed Identity
 * Operator` on the resource group to fill the pool.
 * :::
 *
 * :::caution
 * Changing `resourceGroup`, `name`, or `location` replaces the pool. A scale
 * set attaches to one standby pool at a time, so Alchemy deletes the old pool
 * first when the scale set stays the same. Alchemy updates every other prop
 * in place.
 * :::
 *
 * ### Creating a Pool
 * **Example:** Keep two deallocated VMs ready
 * ```typescript
 * const vnet = yield* Azure.Network.VirtualNetwork("vnet", {
 *   addressPrefixes: ["10.0.0.0/16"],
 * });
 * const subnet = yield* Azure.Network.Subnet("vms", {
 *   virtualNetwork: vnet.virtualNetworkName,
 *   addressPrefix: "10.0.1.0/24",
 * });
 * const scaleSet = yield* Azure.Compute.VirtualMachineScaleSet("web", {
 *   vmSize: "Standard_F1als_v7",
 *   capacity: 1,
 *   subnetId: subnet.subnetId,
 *   adminUsername: "azureuser",
 *   sshPublicKeys: ["ssh-ed25519 AAAAC3Nza... me@example.com"],
 * });
 * const pool = yield* Azure.StandbyPool.VirtualMachinePool("web-pool", {
 *   attachedVirtualMachineScaleSetId: scaleSet.virtualMachineScaleSetId,
 *   virtualMachineState: "Deallocated",
 *   maxReadyCapacity: 2,
 * });
 * ```
 *
 * ### Mixed States
 * **Example:** Half running, half deallocated
 * ```typescript
 * const pool = yield* Azure.StandbyPool.VirtualMachinePool("web-pool", {
 *   attachedVirtualMachineScaleSetId: scaleSet.virtualMachineScaleSetId,
 *   virtualMachineState: "Mix",
 *   vmStateDistribution: { runningPercent: 50, deallocatedPercent: 50 },
 *   maxReadyCapacity: 4,
 *   minReadyCapacity: 2,
 * });
 * ```
 *
 * @resource
 */
export const VirtualMachinePool = GroupedResource<VirtualMachinePool>(
  "Azure.StandbyPool.VirtualMachinePool",
);

const getPool = (
  subscriptionId: string,
  resourceGroupName: string,
  standbyVirtualMachinePoolName: string,
) =>
  orUndefinedIfNotFound(
    standbypool.GetStandbyVirtualMachinePool({
      subscriptionId,
      resourceGroupName,
      standbyVirtualMachinePoolName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Pick<
    standbypool.GetStandbyVirtualMachinePoolResponse,
    "id" | "location" | "properties" | "tags"
  >,
): VirtualMachinePool["Attributes"] => ({
  standbyVirtualMachinePoolName: name,
  standbyVirtualMachinePoolId: observed.id ?? "",
  resourceGroup,
  location: observed.location ?? "",
  provisioningState: observed.properties?.provisioningState,
  attachedVirtualMachineScaleSetId: observed.properties?.attachedVirtualMachineScaleSetId,
  virtualMachineState: observed.properties?.virtualMachineState,
  maxReadyCapacity: observed.properties?.elasticityProfile?.maxReadyCapacity,
  tags: userTags(observed.tags),
});

const toProperties = (
  props: VirtualMachinePoolProps,
): standbypool.StandbyVirtualMachinePoolResourcePropertiesInput => ({
  virtualMachineState: props.virtualMachineState ?? "Deallocated",
  elasticityProfile: {
    maxReadyCapacity: props.maxReadyCapacity,
    ...(props.minReadyCapacity !== undefined ? { minReadyCapacity: props.minReadyCapacity } : {}),
    ...(props.postProvisioningDelay !== undefined
      ? { postProvisioningDelay: props.postProvisioningDelay }
      : {}),
    ...(props.dynamicSizing !== undefined
      ? { dynamicSizing: { enabled: props.dynamicSizing } }
      : {}),
  },
  ...(props.vmStateDistribution !== undefined
    ? { vmStateDistribution: props.vmStateDistribution }
    : {}),
  ...(props.attachedVirtualMachineScaleSetId !== undefined
    ? {
        attachedVirtualMachineScaleSetId: props.attachedVirtualMachineScaleSetId,
      }
    : {}),
});

/** Whether the observed pool spec matches the desired props. */
const specInSync = (
  props: VirtualMachinePoolProps,
  observed: standbypool.StandbyVirtualMachinePoolResourceProperties | undefined,
) => {
  if (observed === undefined) return false;
  const elasticity = observed.elasticityProfile;
  const distribution = props.vmStateDistribution;
  return (
    lower(observed.virtualMachineState) === lower(props.virtualMachineState ?? "Deallocated") &&
    elasticity?.maxReadyCapacity === props.maxReadyCapacity &&
    (props.minReadyCapacity === undefined ||
      elasticity?.minReadyCapacity === props.minReadyCapacity) &&
    (props.postProvisioningDelay === undefined ||
      elasticity?.postProvisioningDelay === props.postProvisioningDelay) &&
    (props.dynamicSizing === undefined ||
      (elasticity?.dynamicSizing?.enabled ?? false) === props.dynamicSizing) &&
    (distribution === undefined ||
      ((distribution.runningPercent === undefined ||
        observed.vmStateDistribution?.runningPercent === distribution.runningPercent) &&
        (distribution.deallocatedPercent === undefined ||
          observed.vmStateDistribution?.deallocatedPercent === distribution.deallocatedPercent) &&
        (distribution.hibernatedPercent === undefined ||
          observed.vmStateDistribution?.hibernatedPercent === distribution.hibernatedPercent))) &&
    lower(observed.attachedVirtualMachineScaleSetId) ===
      lower(props.attachedVirtualMachineScaleSetId)
  );
};

export const VirtualMachinePoolProvider = () =>
  Provider.succeed(VirtualMachinePool, {
    stables: [
      "standbyVirtualMachinePoolName",
      "standbyVirtualMachinePoolId",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(standbypool.ListStandbyVirtualMachinePoolBySubscription, {
        subscriptionId,
      });
      return (page.value ?? []).flatMap((observed) => {
        const group = resourceGroupOf(observed.id);
        return hasAnyAlchemyTag(observed.tags) && group !== undefined && observed.name !== undefined
          ? [toAttrs(group, observed.name, observed)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.standbyVirtualMachinePoolName)) ||
        (news.location !== undefined && !sameLocation(news.location, output.location))
      ) {
        // A scale set attaches to one standby pool at a time.
        const sameScaleSet =
          news.attachedVirtualMachineScaleSetId !== undefined &&
          lower(news.attachedVirtualMachineScaleSetId) ===
            lower(output.attachedVirtualMachineScaleSetId);
        return sameScaleSet
          ? ({ action: "replace", deleteFirst: true } as const)
          : ({ action: "replace" } as const);
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      if (resourceGroup === undefined) return undefined;
      const name =
        output?.standbyVirtualMachinePoolName ?? olds?.name ?? (yield* createStandbyPoolName(id));
      const observed = yield* getPool(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.StandbyPool");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.standbyVirtualMachinePoolName ?? (yield* createStandbyPoolName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const get = getPool(subscriptionId, resourceGroup, name);

      // Observe.
      const observed = yield* get;

      // Ensure + sync. ARM replaces the spec and tag map on PUT, so any
      // observed drift is one full write followed by a provisioning wait.
      if (
        observed === undefined ||
        !specInSync(news, observed.properties) ||
        tagsDiffer(observed.tags, tags)
      ) {
        yield* standbypool.StandbyVirtualMachinePoolsCreateOrUpdate({
          subscriptionId,
          resourceGroupName: resourceGroup,
          standbyVirtualMachinePoolName: name,
          location,
          tags,
          properties: toProperties(news),
        });
      }

      const final = yield* waitForProvisioned(
        `standby virtual machine pool ${name}`,
        get,
        (pool) => pool.properties?.provisioningState,
        { interval: "5 seconds", times: 120 },
      );
      return toAttrs(resourceGroup, name, final);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        standbypool.DeleteStandbyVirtualMachinePool({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          standbyVirtualMachinePoolName: output.standbyVirtualMachinePoolName,
        }),
      );
      // Deleting the pool also deletes its standby VMs.
      yield* waitUntilGone(
        `standby virtual machine pool ${output.standbyVirtualMachinePoolName}`,
        getPool(subscriptionId, output.resourceGroup, output.standbyVirtualMachinePoolName),
        { interval: "5 seconds", times: 120 },
      );
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup", "Azure.Compute.VirtualMachineScaleSet"],
    },
  });
