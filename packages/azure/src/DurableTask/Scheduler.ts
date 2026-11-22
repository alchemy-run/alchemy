import * as durabletask from "@distilled.cloud/azure/durabletask";
import { Unowned } from "alchemy/AdoptPolicy";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
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

export type SchedulerSkuName = "Dedicated" | "Consumption";

export interface SchedulerProps {
  /**
   * Resource group the scheduler is created in. Changing it replaces the
   * scheduler.
   * @default the stack's resource group (`Azure.resourceGroup(...)`, else `<stack>-<stage>`)
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
   * Changing it scales the scheduler in place.
   * @default 1 for `Dedicated`
   */
  capacity?: number;
  /**
   * IPv4/IPv6 addresses or CIDR ranges allowed to reach the scheduler
   * endpoint. `["0.0.0.0/0"]` allows every address. Changing it updates the
   * scheduler in place.
   * @default ["0.0.0.0/0"]
   */
  ipAllowlist?: string[];
  /**
   * Whether the public endpoint accepts traffic. Changing it updates the
   * scheduler in place.
   * @default Azure's default (`Enabled`)
   */
  publicNetworkAccess?: "Enabled" | "Disabled";
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically. Changing them updates the
   * scheduler in place.
   * @default {}
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
 * A Durable Task Scheduler (`Microsoft.DurableTask/schedulers`): the
 * managed backend that stores and dispatches orchestrations and activities
 * for Durable Functions and the Durable Task SDKs. Workloads connect to its
 * `endpoint` with a Microsoft Entra identity that holds the
 * **Durable Task Data Contributor** role on the scheduler or one of its
 * task hubs. There are no keys.
 *
 * You rarely declare one for Effect workflows:
 * `Azure.Functions.WorkflowFunction` creates a scheduler and task hub for
 * its runs. Declare one to run the Durable Task SDKs on another host, to
 * share a scheduler, or to pick the Dedicated tier yourself.
 *
 * Alchemy registers the `Microsoft.DurableTask` resource provider on the
 * subscription if needed, defaults to the Consumption tier, and allows
 * every IP address (`0.0.0.0/0`) unless you set `ipAllowlist`. Creation is
 * a long-running operation; Alchemy waits up to 10 minutes for it.
 * Destroy deletes the scheduler with its task hubs and all orchestration
 * state, and also waits up to 10 minutes. Azure keeps listing a deleted
 * scheduler in its resource group for 5-15 minutes; destroying the stack's
 * resource group waits for it.
 *
 * :::caution[Schedulers are not offered in `eastus`]
 * The default location falls back to `eastus`, where creation fails. Set
 * `location` (or the stack's `Azure.location(...)`) to a region that offers
 * schedulers, e.g. `eastus2`, `westus2`, or `northeurope`. The Consumption
 * tier is offered in fewer regions still.
 * :::
 *
 * :::caution[Changing `name`, `location`, `sku`, or `resourceGroup` replaces the scheduler]
 * Alchemy creates a new, empty scheduler with a new `endpoint` and deletes
 * the old one with its task hubs and every orchestration's state and
 * history. `capacity`, `ipAllowlist`, `publicNetworkAccess`, and `tags`
 * update in place.
 * :::
 *
 * @see https://learn.microsoft.com/azure/azure-functions/durable/durable-task-scheduler/durable-task-scheduler
 *
 * ### Creating a Scheduler
 * **Example:** Consumption scheduler
 * ```typescript
 * const scheduler = yield* Azure.DurableTask.Scheduler("orchestrations", {
 *   location: "westus2",
 * });
 * ```
 *
 * **Example:** Dedicated scheduler with a fixed name
 * ```typescript
 * const scheduler = yield* Azure.DurableTask.Scheduler("orchestrations", {
 *   name: "shop-orchestrations",
 *   location: "northeurope",
 *   sku: "Dedicated",
 *   capacity: 1,
 *   tags: { team: "shop" },
 * });
 * ```
 *
 * ### Scaling a Dedicated Scheduler
 * `capacity` is the number of capacity units. Three or more make the
 * scheduler zone redundant where the region supports it; read
 * `redundancyState` to check. `Consumption` ignores it.
 *
 * **Example:** Zone-redundant scheduler
 * ```typescript
 * const scheduler = yield* Azure.DurableTask.Scheduler("orchestrations", {
 *   location: "westus2",
 *   sku: "Dedicated",
 *   capacity: 3,
 * });
 * // scheduler.redundancyState is "Zone" when the region supports it
 * ```
 *
 * **Example:** Scale out in place
 * ```diff
 *  const scheduler = yield* Azure.DurableTask.Scheduler("orchestrations", {
 *    location: "westus2",
 *    sku: "Dedicated",
 * -  capacity: 1,
 * +  capacity: 3,
 *  });
 * ```
 *
 * ### Network Access
 * **Example:** Only allow your own network
 * ```typescript
 * const scheduler = yield* Azure.DurableTask.Scheduler("orchestrations", {
 *   location: "westus2",
 *   ipAllowlist: ["203.0.113.0/24", "198.51.100.7"],
 * });
 * ```
 *
 * **Example:** Turn off the public endpoint
 * ```typescript
 * // Clients then reach the scheduler only through an Azure.Network.PrivateEndpoint.
 * const scheduler = yield* Azure.DurableTask.Scheduler("orchestrations", {
 *   location: "westus2",
 *   publicNetworkAccess: "Disabled",
 * });
 * ```
 *
 * ### Task Hubs and Retention
 * A task hub holds one app's orchestrations. A retention policy purges
 * finished orchestrations after a number of days.
 *
 * **Example:** Scheduler with a task hub
 * ```typescript
 * const scheduler = yield* Azure.DurableTask.Scheduler("orchestrations", {
 *   location: "westus2",
 * });
 * const hub = yield* Azure.DurableTask.TaskHub("default", {
 *   scheduler: scheduler.schedulerName,
 * });
 * ```
 *
 * **Example:** Keep finished orchestrations 7 days, failures 30 days
 * ```typescript
 * yield* Azure.DurableTask.RetentionPolicy("retention", {
 *   scheduler: scheduler.schedulerName,
 *   retentionPolicies: [
 *     { retentionPeriodInDays: 7 },
 *     { retentionPeriodInDays: 30, orchestrationState: "Failed" },
 *   ],
 * });
 * ```
 *
 * ### Granting Access
 * Grant **Durable Task Data Contributor** on `schedulerId` for every task
 * hub, or on a task hub's `taskHubId` for one. Then connect with an
 * identity-based connection string.
 *
 * **Example:** Let a user-assigned identity use one task hub
 * ```typescript
 * const scheduler = yield* Azure.DurableTask.Scheduler("orchestrations", {
 *   location: "westus2",
 * });
 * const hub = yield* Azure.DurableTask.TaskHub("default", {
 *   scheduler: scheduler.schedulerName,
 * });
 * const worker = yield* Azure.ManagedIdentity.UserAssignedIdentity("worker", {
 *   location: "westus2",
 * });
 * yield* Azure.Authorization.RoleAssignment("worker-uses-hub", {
 *   scope: hub.taskHubId,
 *   roleDefinitionId: Azure.Authorization.BuiltInRole.DurableTaskDataContributor,
 *   principalId: worker.principalId,
 *   principalType: "ServicePrincipal",
 * });
 * const connection = Output.interpolate`Endpoint=${scheduler.endpoint};Authentication=ManagedIdentity;ClientID=${worker.clientId};TaskHub=${hub.taskHubName}`;
 * ```
 *
 * ### Binding to a runtime
 * For Effect workflows, `Azure.Functions.WorkflowFunction` creates a
 * Consumption scheduler (in `schedulerLocation`) and a task hub, and
 * grants its managed identity **Durable Task Data Contributor** on the hub.
 * `Azure.Functions.DurableEngine` grants a calling runtime the same role on
 * the hub of each host it runs workflows on, and nothing wider. A caller
 * that isn't an Azure host (a Cloudflare Worker, an AWS Lambda) gets an
 * Entra service principal with the role.
 *
 * **Example:** A workflow function and its scheduler
 * ```typescript
 * export class OrderWorkflows extends Azure.Functions.WorkflowFunction<OrderWorkflows>()(
 *   "OrderWorkflows",
 *   { workflows: [PlaceOrder], schedulerLocation: "westus2", schedulerSku: "Dedicated" },
 * ) {}
 *
 * export default OrderWorkflows.make({ main: import.meta.url, location: "westus2" }, PlaceOrderLive);
 * ```
 *
 * **Example:** Start runs from another Function
 * ```typescript
 * export default class Api extends Azure.Functions.Function<Api>()(
 *   "Api",
 *   { main: import.meta.url, location: "westus2" },
 *   Effect.gen(function* () {
 *     const placeOrder = yield* Workflows.RunWorkflow(PlaceOrder);
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const run = yield* placeOrder.start({ orderId: "o-1" });
 *         return HttpServerResponse.text(run.executionId);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Azure.Functions.DurableEngine(OrderWorkflows))),
 * ) {}
 * ```
 *
 * ### Runtime Operations
 * **Example:** Start, read, signal, and interrupt a run
 * ```typescript
 * // init
 * const placeOrder = yield* Workflows.RunWorkflow(PlaceOrder);
 *
 * // runtime
 * const started = yield* placeOrder.start({ orderId: "o-1" }); // same key returns the same run
 * const run = placeOrder.get(started.executionId);
 * const status = yield* run.status; // Running, Completed, Failed, …
 * yield* run.signal(Approval, "agent-7"); // Approval: a DurableDeferred the workflow awaits
 * yield* run.interrupt;
 * ```
 *
 * **Example:** Open a host's runs in the scheduler dashboard
 * ```typescript
 * const { scheduler, taskHub } = yield* OrderWorkflows.durableTask;
 * return { endpoint: scheduler.endpoint, dashboard: taskHub.dashboardUrl };
 * ```
 *
 * @resource
 */
export const Scheduler = GroupedResource<Scheduler>("Azure.DurableTask.Scheduler");

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
    stables: ["schedulerName", "schedulerId", "resourceGroup", "location", "endpoint", "sku"],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* collectAll(durabletask.ListSchedulerBySubscription, { subscriptionId });
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
        (news.name !== undefined && lower(news.name) !== lower(output.schedulerName)) ||
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
      const name = output?.schedulerName ?? olds?.name ?? (yield* createSchedulerName(id));
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
      const name = news.name ?? output?.schedulerName ?? (yield* createSchedulerName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const skuName = news.sku ?? "Consumption";
      const capacity = skuName === "Dedicated" ? (news.capacity ?? 1) : undefined;
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
        getScheduler(subscriptionId, output.resourceGroup, output.schedulerName),
        { interval: "5 seconds", times: 120 },
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
