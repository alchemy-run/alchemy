import * as mnf from "@distilled.cloud/azure/managednetworkfabric";
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
  waitUntilGone,
} from "../Arm.ts";
import { AzureEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  createFabricName,
  differs,
  FABRIC_NAMESPACE,
  sameArm,
  waitFabricProvisioned,
} from "./Common.ts";

export interface NetworkFabricControllerProps {
  /**
   * Resource group the network fabric controller is created in. Changing it replaces the
   * network fabric controller.
   */
  resourceGroup: string;
  /**
   * Name of the network fabric controller. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing it replaces the network fabric controller.
   */
  name?: string;
  /**
   * Azure location of the network fabric controller. Changing it replaces the network fabric controller.
   * Network Fabric resources are offered in `eastus`, `southcentralus`,
   * `westus3`, `australiaeast`, `uaenorth`, `uksouth`, and `northeurope`.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * Controller SKU (`Basic`, `Standard`, `HighPerformance`). Changing it
   * replaces the controller.
   */
  nfcSku?: mnf.NetworkFabricControllerPropertiesInput["nfcSku"];
  /**
   * IPv4 address space of the controller's managed network, e.g.
   * `10.0.0.0/19`. Changing it replaces the controller.
   */
  ipv4AddressSpace?: string;
  /**
   * IPv6 address space of the controller's managed network. Changing it
   * replaces the controller.
   */
  ipv6AddressSpace?: string;
  /**
   * Name and location of the managed resource group the controller
   * creates. Changing it replaces the controller.
   */
  managedResourceGroupConfiguration?: mnf.NetworkFabricControllerPropertiesInput["managedResourceGroupConfiguration"];
  /**
   * Whether the workload management network is enabled (`True`/`False`).
   * Changing it replaces the controller.
   */
  isWorkloadManagementNetworkEnabled?: mnf.NetworkFabricControllerPropertiesInput["isWorkloadManagementNetworkEnabled"];
  /**
   * ExpressRoute circuits (ID + authorization key) for infrastructure
   * traffic. Authorization keys are not returned by Azure, so changes are
   * detected against the previous props.
   */
  infrastructureExpressRouteConnections?: mnf.NetworkFabricControllerPropertiesInput["infrastructureExpressRouteConnections"];
  /**
   * ExpressRoute circuits (ID + authorization key) for workload traffic.
   * Changes are detected against the previous props.
   */
  workloadExpressRouteConnections?: mnf.NetworkFabricControllerPropertiesInput["workloadExpressRouteConnections"];
  /**
   * Free-form description. Azure cannot update it in place, so changing
   * it replaces the resource.
   */
  annotation?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface NetworkFabricController extends Resource<
  "Azure.ManagedNetworkFabric.NetworkFabricController",
  NetworkFabricControllerProps,
  {
    /** Name of the network fabric controller. */
    networkFabricControllerName: string;
    /** ARM resource ID of the network fabric controller. */
    networkFabricControllerId: string;
    /** Resource group that holds the network fabric controller. */
    resourceGroup: string;
    /** Location of the network fabric controller. */
    location: string;
    /** Network Fabrics managed by the controller. */
    networkFabricIds: string[];
    /** Tenant internet gateways of the controller. */
    tenantInternetGatewayIds: string[];
    /** Description of the network fabric controller. */
    annotation: string | undefined;
    /** Provisioning state, e.g. `Succeeded`. */
    provisioningState: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Operator Nexus Network Fabric Controller — the Azure-hosted
 * control plane that manages one or more on-premises Network Fabrics over
 * dedicated ExpressRoute circuits. Provisioning takes 45-90 minutes and needs
 * ExpressRoute circuits connected to an Operator Nexus site.
 *
 * @see https://learn.microsoft.com/azure/operator-nexus/concepts-network-fabric-controller
 *
 * ### Creating a Controller
 * **Example:** Controller over two ExpressRoute circuits
 * ```typescript
 * const group = yield* Azure.Resources.ResourceGroup("fabric");
 * const nfc = yield* Azure.ManagedNetworkFabric.NetworkFabricController("nfc", {
 *   resourceGroup: group.resourceGroupName,
 *   ipv4AddressSpace: "10.0.0.0/19",
 *   nfcSku: "Standard",
 *   infrastructureExpressRouteConnections: [
 *     { expressRouteCircuitId: infraCircuitId, expressRouteAuthorizationKey: infraKey },
 *   ],
 *   workloadExpressRouteConnections: [
 *     { expressRouteCircuitId: workloadCircuitId, expressRouteAuthorizationKey: workloadKey },
 *   ],
 * });
 * ```
 *
 * @resource
 */
export const NetworkFabricController = Resource<NetworkFabricController>(
  "Azure.ManagedNetworkFabric.NetworkFabricController",
);

type Observed = mnf.GetNetworkFabricControllerResponse;

const getNetworkFabricController = (
  subscriptionId: string,
  resourceGroupName: string,
  networkFabricControllerName: string,
) =>
  orUndefinedIfNotFound(
    mnf.GetNetworkFabricController({
      subscriptionId,
      resourceGroupName,
      networkFabricControllerName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  observed: Observed,
): NetworkFabricController["Attributes"] => {
  const p = observed.properties;
  return {
    networkFabricControllerName: name,
    networkFabricControllerId: observed.id ?? "",
    resourceGroup,
    location: observed.location,
    networkFabricIds: [...(p?.networkFabricIds ?? [])],
    tenantInternetGatewayIds: [...(p?.tenantInternetGatewayIds ?? [])],
    annotation: p?.annotation,
    provisioningState: p?.provisioningState,
    tags: userTags(observed.tags),
  };
};

export const NetworkFabricControllerProvider = () =>
  Provider.succeed(NetworkFabricController, {
    stables: [
      "networkFabricControllerName",
      "networkFabricControllerId",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* mnf
        .ListNetworkFabricControllerBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage(
              "ListNetworkFabricControllerBySubscription",
              page,
            ),
          ),
        );
      return (page.value ?? []).flatMap((item) => {
        const group = resourceGroupOf(item.id);
        return hasAnyAlchemyTag(item.tags) &&
          group !== undefined &&
          item.name !== undefined
          ? [toAttrs(group, item.name, item)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.networkFabricControllerName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        (olds !== undefined &&
          (differs(news.nfcSku, olds.nfcSku) ||
            differs(news.ipv4AddressSpace, olds.ipv4AddressSpace) ||
            differs(news.ipv6AddressSpace, olds.ipv6AddressSpace) ||
            differs(
              news.managedResourceGroupConfiguration,
              olds.managedResourceGroupConfiguration,
            ) ||
            differs(
              news.isWorkloadManagementNetworkEnabled,
              olds.isWorkloadManagementNetworkEnabled,
            ) ||
            differs(news.annotation, olds.annotation)))
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
        output?.networkFabricControllerName ??
        olds?.name ??
        (yield* createFabricName(id));
      const observed = yield* getNetworkFabricController(
        subscriptionId,
        resourceGroup,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output, olds }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, FABRIC_NAMESPACE);
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.networkFabricControllerName ??
        (yield* createFabricName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        networkFabricControllerName: name,
      };
      const label = `network fabric controller ${name}`;
      const get = getNetworkFabricController(
        subscriptionId,
        resourceGroup,
        name,
      );

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* mnf.CreateNetworkFabricController({
          ...where,
          location,
          tags,
          properties: {
            nfcSku: news.nfcSku,
            ipv4AddressSpace: news.ipv4AddressSpace,
            ipv6AddressSpace: news.ipv6AddressSpace,
            managedResourceGroupConfiguration:
              news.managedResourceGroupConfiguration,
            isWorkloadManagementNetworkEnabled:
              news.isWorkloadManagementNetworkEnabled,
            infrastructureExpressRouteConnections:
              news.infrastructureExpressRouteConnections,
            workloadExpressRouteConnections:
              news.workloadExpressRouteConnections,
            annotation: news.annotation,
          },
        });
      }
      observed = yield* waitFabricProvisioned(label, get, {
        interval: "30 seconds",
        times: 200,
      });

      // Sync mutable aspects against observed state; send only the delta.
      // Secrets are not returned by GET: compare against the last props
      // (sent on create; not observable after adoption).
      const secretDelta = {
        infrastructureExpressRouteConnections:
          olds !== undefined &&
          differs(
            news.infrastructureExpressRouteConnections,
            olds.infrastructureExpressRouteConnections,
          )
            ? news.infrastructureExpressRouteConnections
            : undefined,
        workloadExpressRouteConnections:
          olds !== undefined &&
          differs(
            news.workloadExpressRouteConnections,
            olds.workloadExpressRouteConnections,
          )
            ? news.workloadExpressRouteConnections
            : undefined,
      };
      const secretsChanged = Object.values(secretDelta).some(
        (value) => value !== undefined,
      );
      const tagsChanged = tagsDiffer(observed.tags, tags);
      if (secretsChanged || tagsChanged) {
        yield* mnf.UpdateNetworkFabricController({
          ...where,
          tags: tagsChanged ? tags : undefined,
          properties: secretsChanged ? secretDelta : undefined,
        });
        observed = yield* waitFabricProvisioned(label, get, {
          interval: "30 seconds",
          times: 200,
        });
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const where = {
        subscriptionId,
        resourceGroupName: output.resourceGroup,
        networkFabricControllerName: output.networkFabricControllerName,
      };
      const label = `network fabric controller ${output.networkFabricControllerName}`;
      const get = getNetworkFabricController(
        subscriptionId,
        output.resourceGroup,
        output.networkFabricControllerName,
      );
      yield* ignoreNotFound(mnf.DeleteNetworkFabricController(where));
      yield* waitUntilGone(label, get, { interval: "30 seconds", times: 200 });
    }),

    nuke: {
      dependsOn: ["Azure.Resources.ResourceGroup"],
    },
  });
