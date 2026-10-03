import * as sqlvm from "@distilled.cloud/azure/sqlvirtualmachine";
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
  waitForProvisioned,
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { isGroupOwnedByStack, lower, matchesObserved } from "./common.ts";

export interface AvailabilityGroupListenerProps {
  /** Resource group of the SQL VM group. Changing it replaces the listener. */
  resourceGroup: string;
  /**
   * Name of the parent `SqlVirtualMachineGroup`. Changing it replaces the
   * listener.
   */
  sqlVirtualMachineGroup: string;
  /**
   * Listener name; also the DNS name clients connect to (at most 15
   * characters). If omitted, a unique name is generated. Changing it
   * replaces the listener.
   */
  name?: string;
  /**
   * Name of the Always On availability group the listener fronts. Changing
   * it replaces the listener.
   */
  availabilityGroupName: string;
  /**
   * Load balancer configurations (single-subnet clusters): the internal load
   * balancer, the listener's private IP, probe port, and the SQL VM
   * instances behind it. Set this or `multiSubnetIpConfigurations`.
   */
  loadBalancerConfigurations?: sqlvm.LoadBalancerConfiguration[];
  /**
   * One private IP per SQL VM instance (multi-subnet clusters, no load
   * balancer). Set this or `loadBalancerConfigurations`.
   */
  multiSubnetIpConfigurations?: sqlvm.MultiSubnetIpConfiguration[];
  /**
   * Create the availability group if it does not exist yet.
   * @default false
   */
  createDefaultAvailabilityGroupIfNotExist?: boolean;
  /**
   * Listener port.
   * @default 1433
   */
  port?: number;
  /** Replica roles, commit and failover modes of the availability group. */
  availabilityGroupConfiguration?: sqlvm.AgConfiguration;
}

export interface AvailabilityGroupListener extends Resource<
  "Azure.SqlVirtualMachine.AvailabilityGroupListener",
  AvailabilityGroupListenerProps,
  {
    /** Name of the listener. */
    availabilityGroupListenerName: string;
    /** ARM resource ID of the listener. */
    availabilityGroupListenerId: string;
    /** Resource group of the SQL VM group. */
    resourceGroup: string;
    /** Name of the parent SQL VM group. */
    sqlVirtualMachineGroup: string;
    /** Name of the availability group the listener fronts. */
    availabilityGroupName: string | undefined;
    /** Listener port. */
    port: number | undefined;
  },
  never,
  Providers
> {}

/**
 * An availability group listener — the virtual network name and IP that
 * clients use to reach the primary replica of a SQL Server Always On
 * availability group running on the SQL VMs of a `SqlVirtualMachineGroup`.
 *
 * Requires a group whose SQL VMs are domain-joined and registered with the
 * group, plus an internal load balancer (single subnet) or one IP per
 * replica subnet (multi-subnet).
 *
 * @see https://learn.microsoft.com/azure/azure-sql/virtual-machines/windows/availability-group-az-commandline-configure
 *
 * ### Creating a Listener
 * **Example:** Load-balanced listener for a single-subnet cluster
 * ```typescript
 * const listener = yield* Azure.SqlVirtualMachine.AvailabilityGroupListener("ag", {
 *   resourceGroup: group.resourceGroupName,
 *   sqlVirtualMachineGroup: cluster.sqlVirtualMachineGroupName,
 *   availabilityGroupName: "ag1",
 *   port: 1433,
 *   loadBalancerConfigurations: [
 *     {
 *       loadBalancerResourceId: ilb.loadBalancerId,
 *       privateIpAddress: { ipAddress: "10.0.1.50", subnetResourceId: subnet.subnetId },
 *       probePort: 59999,
 *       sqlVirtualMachineInstances: [sql1.sqlVirtualMachineId, sql2.sqlVirtualMachineId],
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Multi-subnet listener without a load balancer
 * ```typescript
 * yield* Azure.SqlVirtualMachine.AvailabilityGroupListener("ag", {
 *   resourceGroup: group.resourceGroupName,
 *   sqlVirtualMachineGroup: cluster.sqlVirtualMachineGroupName,
 *   availabilityGroupName: "ag1",
 *   multiSubnetIpConfigurations: [
 *     {
 *       privateIpAddress: { ipAddress: "10.0.1.50", subnetResourceId: subnet1.subnetId },
 *       sqlVirtualMachineInstance: sql1.sqlVirtualMachineId,
 *     },
 *     {
 *       privateIpAddress: { ipAddress: "10.0.2.50", subnetResourceId: subnet2.subnetId },
 *       sqlVirtualMachineInstance: sql2.sqlVirtualMachineId,
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const AvailabilityGroupListener = Resource<AvailabilityGroupListener>(
  "Azure.SqlVirtualMachine.AvailabilityGroupListener",
);

type Observed = sqlvm.GetAvailabilityGroupListenerResponse;

const createListenerName = (id: string) =>
  createPhysicalName({ id, maxLength: 15, lowercase: true, delimiter: "-" });

const getListener = (
  subscriptionId: string,
  resourceGroupName: string,
  sqlVirtualMachineGroupName: string,
  availabilityGroupListenerName: string,
) =>
  orUndefinedIfNotFound(
    sqlvm.GetAvailabilityGroupListener({
      subscriptionId,
      resourceGroupName,
      sqlVirtualMachineGroupName,
      availabilityGroupListenerName,
      _expand: "*",
    }),
  );

const toAttrs = (
  resourceGroup: string,
  sqlVirtualMachineGroup: string,
  name: string,
  listener: Observed,
): AvailabilityGroupListener["Attributes"] => ({
  availabilityGroupListenerName: name,
  availabilityGroupListenerId: listener.id ?? "",
  resourceGroup,
  sqlVirtualMachineGroup,
  availabilityGroupName: listener.properties?.availabilityGroupName,
  port: listener.properties?.port,
});

export const AvailabilityGroupListenerProvider = () =>
  Provider.succeed(AvailabilityGroupListener, {
    stables: [
      "availabilityGroupListenerName",
      "availabilityGroupListenerId",
      "resourceGroup",
      "sqlVirtualMachineGroup",
    ],

    // Listeners vanish with their group, which `list` already covers.
    list: () => Effect.succeed([]),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        lower(news.resourceGroup) !== lower(output.resourceGroup) ||
        lower(news.sqlVirtualMachineGroup) !==
          lower(output.sqlVirtualMachineGroup) ||
        (news.name !== undefined &&
          lower(news.name) !== lower(output.availabilityGroupListenerName)) ||
        lower(news.availabilityGroupName) !==
          lower(output.availabilityGroupName)
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const group =
        output?.sqlVirtualMachineGroup ?? olds?.sqlVirtualMachineGroup;
      if (resourceGroup === undefined || group === undefined) return undefined;
      const name =
        output?.availabilityGroupListenerName ??
        olds?.name ??
        (yield* createListenerName(id));
      const observed = yield* getListener(
        subscriptionId,
        resourceGroup,
        group,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, group, name, observed);
      return (yield* isGroupOwnedByStack(subscriptionId, resourceGroup, group))
        ? attrs
        : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ensureRegistered(subscriptionId, "Microsoft.SqlVirtualMachine");
      const resourceGroup = news.resourceGroup;
      const group = news.sqlVirtualMachineGroup;
      const name =
        news.name ??
        output?.availabilityGroupListenerName ??
        (yield* createListenerName(id));
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        sqlVirtualMachineGroupName: group,
        availabilityGroupListenerName: name,
      };
      const get = getListener(subscriptionId, resourceGroup, group, name);
      const desired: sqlvm.AvailabilityGroupListenerPropertiesInput = {
        availabilityGroupName: news.availabilityGroupName,
        loadBalancerConfigurations: news.loadBalancerConfigurations,
        multiSubnetIpConfigurations: news.multiSubnetIpConfigurations,
        createDefaultAvailabilityGroupIfNotExist:
          news.createDefaultAvailabilityGroupIfNotExist,
        port: news.port ?? 1433,
        availabilityGroupConfiguration: news.availabilityGroupConfiguration,
      };

      // Observe.
      let observed = yield* get;

      // Ensure + sync: the PUT is a full upsert; only send it on drift.
      // `createDefaultAvailabilityGroupIfNotExist` is a create-time hint.
      const { createDefaultAvailabilityGroupIfNotExist: _, ...comparable } =
        desired;
      if (
        observed === undefined ||
        !matchesObserved(comparable, observed.properties)
      ) {
        yield* sqlvm.AvailabilityGroupListenersCreateOrUpdate({
          ...where,
          properties: desired,
        });
      }
      // Creating the listener configures the cluster role on the VMs.
      observed = yield* waitForProvisioned(
        `availability group listener ${name}`,
        get,
        (listener) => listener.properties?.provisioningState,
        { interval: "10 seconds", times: 60 },
      );

      return toAttrs(resourceGroup, group, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        sqlvm.DeleteAvailabilityGroupListener({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          sqlVirtualMachineGroupName: output.sqlVirtualMachineGroup,
          availabilityGroupListenerName: output.availabilityGroupListenerName,
        }),
      );
      yield* waitUntilGone(
        `availability group listener ${output.availabilityGroupListenerName}`,
        getListener(
          subscriptionId,
          output.resourceGroup,
          output.sqlVirtualMachineGroup,
          output.availabilityGroupListenerName,
        ),
        { interval: "10 seconds", times: 60 },
      );
    }),

    nuke: {
      dependsOn: [
        "Azure.Resources.ResourceGroup",
        "Azure.SqlVirtualMachine.SqlVirtualMachineGroup",
      ],
    },
  });
