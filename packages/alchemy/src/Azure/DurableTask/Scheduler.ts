import * as durabletask from "@distilled.cloud/azure/durabletask";
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

export type SchedulerSkuName = "Dedicated" | "Consumption";

export interface SchedulerProps {
  /**
   * Resource group the scheduler is created in. Changing it replaces the
   * scheduler.
   */
  resourceGroup: string;
  /**
   * Scheduler name: 3-64 letters, digits, and hyphens. If omitted, a unique
   * name is generated from the app, stage, and logical ID. Changing it
   * replaces the scheduler.
   */
  name?: string;
  /**
   * Azure location of the scheduler. Schedulers are only offered in a subset
   * of regions (not `eastus`; e.g. `eastus2`, `westus2`, `northeurope`), and
   * the Consumption SKU in fewer still. Changing it replaces the scheduler.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Billing tier. `Consumption` is billed per action; `Dedicated` reserves
   * capacity units. Switching tiers is not supported in place, so changing
   * it replaces the scheduler.
   * @default "Consumption"
   */
  sku?: SchedulerSkuName;
  /**
   * Capacity units of a `Dedicated` scheduler (scale out/in; 3 or more
   * enables zone redundancy where supported). Ignored for `Consumption`.
   * @default 1 for `Dedicated`
   */
  capacity?: number;
  /**
   * IPv4/IPv6 addresses or CIDR ranges allowed to reach the scheduler
   * endpoint. `["0.0.0.0/0"]` allows every address.
   * @default ["0.0.0.0/0"]
   */
  ipAllowlist?: string[];
  /**
   * Whether the public endpoint accepts traffic.
   * @default Azure's default (`Enabled`)
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface Scheduler extends Resource<
  "Azure.DurableTask.Scheduler",
  SchedulerProps,
  {
    /** Name of the scheduler. */
    schedulerName: string;
    /** ARM resource ID of the scheduler; use it as a role-assignment scope. */
    schedulerId: string;
    /** Resource group that holds the scheduler. */
    resourceGroup: string;
    /** Location of the scheduler. */
    location: string;
    /**
     * gRPC endpoint of the scheduler, used by Durable Functions and the
     * Durable Task SDKs (`Endpoint=...` in the connection string).
     */
    endpoint: string;
    /** Billing tier. */
    sku: string;
    /** Capacity units (Dedicated only). */
    capacity: number | undefined;
    /** Whether the SKU configuration is zone redundant (`None` or `Zone`). */
    redundancyState: string | undefined;
    /** IP allow list. */
    ipAllowlist: string[];
    /** Public network access (`Enabled` or `Disabled`). */
    publicNetworkAccess: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A Durable Task Scheduler — the managed backend that stores and dispatches
 * orchestrations and activities for Durable Functions and the Durable Task
 * SDKs. Workloads connect to its `endpoint` with a Microsoft Entra identity
 * that holds the `Durable Task Data Contributor` role on the scheduler.
 *
 * @see https://learn.microsoft.com/azure/azure-functions/durable/durable-task-scheduler/durable-task-scheduler
 *
 * ### Creating a Scheduler
 * **Example:** Consumption scheduler
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("app");
 * const scheduler = yield* Azure.DurableTask.Scheduler("orchestrations", {
 *   resourceGroup: group.resourceGroupName,
 * });
 * ```
 *
 * **Example:** Dedicated scheduler with an IP allow list
 * ```typescript
 * const scheduler = yield* Azure.DurableTask.Scheduler("orchestrations", {
 *   resourceGroup: group.resourceGroupName,
 *   sku: "Dedicated",
 *   capacity: 1,
 *   ipAllowlist: ["203.0.113.0/24"],
 * });
 * ```
 *
 * ### Adding a Task Hub
 * **Example:** Scheduler with a task hub
 * ```typescript
 * const hub = yield* Azure.DurableTask.TaskHub("default", {
 *   resourceGroup: group.resourceGroupName,
 *   scheduler: scheduler.schedulerName,
 * });
 * ```
 *
 * @resource
 */
export const Scheduler = Resource<Scheduler>("Azure.DurableTask.Scheduler");

type ObservedScheduler = durabletask.GetSchedulerResponse;

const createSchedulerName = (id: string) =>
  createPhysicalName({ id, maxLength: 64, lowercase: true, delimiter: "-" });

export const getScheduler = (
  subscriptionId: string,
  resourceGroupName: string,
  schedulerName: string,
) =>
  orUndefinedIfNotFound(
    durabletask.GetScheduler({
      subscriptionId,
      resourceGroupName,
      schedulerName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  scheduler: ObservedScheduler | durabletask.Scheduler,
): Scheduler["Attributes"] => ({
  schedulerName: name,
  schedulerId: scheduler.id ?? "",
  resourceGroup,
  location: scheduler.location,
  endpoint: scheduler.properties?.endpoint ?? "",
  sku: scheduler.properties?.sku.name ?? "",
  capacity: scheduler.properties?.sku.capacity,
  redundancyState: scheduler.properties?.sku.redundancyState,
  ipAllowlist: [...(scheduler.properties?.ipAllowlist ?? [])],
  publicNetworkAccess: scheduler.properties?.publicNetworkAccess,
  tags: userTags(scheduler.tags),
});

const lower = (value: string | undefined) => value?.toLowerCase();

const sameList = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && [...a].sort().join(",") === [...b].sort().join(",");

export const SchedulerProvider = () =>
  Provider.succeed(Scheduler, {
    stables: [
      "schedulerName",
      "schedulerId",
      "resourceGroup",
      "location",
      "endpoint",
      "sku",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* durabletask
        .ListSchedulerBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListSchedulerBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((scheduler) => {
        const group = resourceGroupOf(scheduler.id);
        return hasAnyAlchemyTag(scheduler.tags) &&
          group !== undefined &&
          scheduler.name !== undefined
          ? [toAttrs(group, scheduler.name, scheduler)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.schedulerName)) ||
        (news.location !== undefined &&
          lower(news.location)?.replaceAll(" ", "") !==
            lower(output.location)?.replaceAll(" ", "")) ||
        (news.sku ?? "Consumption") !== output.sku
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
        output?.schedulerName ?? olds?.name ?? (yield* createSchedulerName(id));
      const observed = yield* getScheduler(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.DurableTask");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ?? output?.schedulerName ?? (yield* createSchedulerName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const skuName = news.sku ?? "Consumption";
      const capacity =
        skuName === "Dedicated" ? (news.capacity ?? 1) : undefined;
      const ipAllowlist = news.ipAllowlist ?? ["0.0.0.0/0"];
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        schedulerName: name,
      };
      const label = `durable task scheduler ${name}`;
      const get = getScheduler(subscriptionId, resourceGroup, name);
      const waitReady = waitForProvisioned(
        label,
        get,
        (scheduler) => scheduler.properties?.provisioningState,
        { interval: "5 seconds", times: 120 },
      );

      // Observe.
      let observed = yield* get;

      // Ensure. Creation is a long-running operation.
      if (observed === undefined) {
        yield* durabletask.SchedulersCreateOrUpdate({
          ...where,
          location,
          tags,
          properties: {
            ipAllowlist,
            sku: { name: skuName, capacity },
            publicNetworkAccess: news.publicNetworkAccess,
          },
        });
      }
      observed = yield* waitReady;

      // Sync mutable aspects against observed state; PATCH only the delta.
      const props = observed.properties;
      const changed: durabletask.SchedulerPropertiesUpdateInput = {};
      if (!sameList(props?.ipAllowlist ?? [], ipAllowlist)) {
        changed.ipAllowlist = ipAllowlist;
      }
      if (
        news.publicNetworkAccess !== undefined &&
        props?.publicNetworkAccess !== news.publicNetworkAccess
      ) {
        changed.publicNetworkAccess = news.publicNetworkAccess;
      }
      if (capacity !== undefined && props?.sku.capacity !== capacity) {
        changed.sku = { capacity };
      }
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (Object.keys(changed).length > 0 || tagsChanged) {
        yield* durabletask.UpdateScheduler({
          ...where,
          properties: Object.keys(changed).length > 0 ? changed : undefined,
          tags: tagsChanged ? tags : undefined,
        });
        observed = yield* waitReady;
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        durabletask.DeleteScheduler({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          schedulerName: output.schedulerName,
        }),
      );
      yield* waitUntilGone(
        `durable task scheduler ${output.schedulerName}`,
        getScheduler(
          subscriptionId,
          output.resourceGroup,
          output.schedulerName,
        ),
        { interval: "5 seconds", times: 120 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
