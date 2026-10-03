import * as networkfunction from "@distilled.cloud/azure/networkfunction";
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
import {
  COLLECTOR_BUDGET,
  createNetworkFunctionName,
  sameArm,
} from "./Common.ts";

export interface AzureTrafficCollectorProps {
  /** Resource group the collector is created in. Changing it replaces the collector. */
  resourceGroup: string;
  /**
   * Collector name: 1-80 letters, digits, `_`, `.`, and `-`. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the collector.
   */
  name?: string;
  /**
   * Azure location of the collector. Must be a region that supports Azure
   * Traffic Collector, in the same geopolitical region as the ExpressRoute
   * circuits it monitors. Changing it replaces the collector.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM ID of the Virtual WAN hub the collector belongs to (for
   * ExpressRoute circuits connected through Virtual WAN). Changing it
   * replaces the collector.
   */
  virtualHubId?: string;
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface AzureTrafficCollector extends Resource<
  "Azure.NetworkFunction.AzureTrafficCollector",
  AzureTrafficCollectorProps,
  {
    /** Name of the collector. */
    azureTrafficCollectorName: string;
    /** ARM resource ID of the collector. */
    azureTrafficCollectorId: string;
    /** Resource group that holds the collector. */
    resourceGroup: string;
    /** Location of the collector. */
    location: string;
    /** ARM ID of the Virtual WAN hub the collector belongs to, if any. */
    virtualHubId: string | undefined;
    /** ARM IDs of the collector policies attached to the collector. */
    collectorPolicyIds: string[];
    /** Provisioning state (`Succeeded`, `Updating`, `Deleting`, `Failed`). */
    provisioningState: string | undefined;
    /** Opaque ETag that changes whenever the collector is updated. */
    etag: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Azure Traffic Collector — samples IPFIX flow records from ExpressRoute
 * circuits and emits them to Azure Monitor (Log Analytics). Attach
 * circuits with `Azure.NetworkFunction.CollectorPolicy`.
 *
 * The collector bills per hour of uptime (≈ $0.60/hour in North America
 * and Europe) plus per GB of processed flow data.
 *
 * @see https://learn.microsoft.com/azure/expressroute/traffic-collector
 *
 * ### Creating a Collector
 * **Example:** Collector in a resource group
 * ```typescript
 * const collector = yield* Azure.NetworkFunction.AzureTrafficCollector("flows", {
 *   resourceGroup: group.resourceGroupName,
 *   location: "eastus",
 * });
 * ```
 *
 * **Example:** Collector on a Virtual WAN hub
 * ```typescript
 * const collector = yield* Azure.NetworkFunction.AzureTrafficCollector("flows", {
 *   resourceGroup: group.resourceGroupName,
 *   virtualHubId: hub.virtualHubId,
 * });
 * ```
 *
 * ### Collecting Circuit Flow Logs
 * **Example:** Emit a circuit's flows to Azure Monitor
 * ```typescript
 * yield* Azure.NetworkFunction.CollectorPolicy("circuit", {
 *   resourceGroup: group.resourceGroupName,
 *   azureTrafficCollector: collector.azureTrafficCollectorName,
 *   location: collector.location,
 *   ingestionSourceIds: [circuit.circuitId],
 * });
 * ```
 *
 * @resource
 */
export const AzureTrafficCollector = Resource<AzureTrafficCollector>(
  "Azure.NetworkFunction.AzureTrafficCollector",
);

const getCollector = (
  subscriptionId: string,
  resourceGroupName: string,
  azureTrafficCollectorName: string,
) =>
  orUndefinedIfNotFound(
    networkfunction.GetAzureTrafficCollector({
      subscriptionId,
      resourceGroupName,
      azureTrafficCollectorName,
    }),
  );

const toAttrs = (
  resourceGroup: string,
  name: string,
  collector:
    | networkfunction.GetAzureTrafficCollectorResponse
    | networkfunction.AzureTrafficCollector,
): AzureTrafficCollector["Attributes"] => ({
  azureTrafficCollectorName: name,
  azureTrafficCollectorId: collector.id ?? "",
  resourceGroup,
  location: collector.location,
  virtualHubId: collector.properties?.virtualHub?.id,
  collectorPolicyIds: (collector.properties?.collectorPolicies ?? []).flatMap(
    (policy) => (policy.id === undefined ? [] : [policy.id]),
  ),
  provisioningState: collector.properties?.provisioningState,
  etag: collector.etag,
  tags: userTags(collector.tags),
});

export const AzureTrafficCollectorProvider = () =>
  Provider.succeed(AzureTrafficCollector, {
    stables: [
      "azureTrafficCollectorName",
      "azureTrafficCollectorId",
      "resourceGroup",
      "location",
      "virtualHubId",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const page = yield* networkfunction
        .ListAzureTrafficCollectorsBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListAzureTrafficCollectorsBySubscription", page),
          ),
        );
      return (page.value ?? []).flatMap((collector) => {
        const group = resourceGroupOf(collector.id);
        return hasAnyAlchemyTag(collector.tags) &&
          group !== undefined &&
          collector.name !== undefined
          ? [toAttrs(group, collector.name, collector)]
          : [];
      });
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.azureTrafficCollectorName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location)) ||
        !sameArm(news.virtualHubId, output.virtualHubId)
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
        output?.azureTrafficCollectorName ??
        olds?.name ??
        (yield* createNetworkFunctionName(id));
      const observed = yield* getCollector(subscriptionId, resourceGroup, name);
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.NetworkFunction");
      const resourceGroup = news.resourceGroup;
      const name =
        news.name ??
        output?.azureTrafficCollectorName ??
        (yield* createNetworkFunctionName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        azureTrafficCollectorName: name,
      };
      const get = getCollector(subscriptionId, resourceGroup, name);
      const label = `Azure Traffic Collector ${name}`;

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* networkfunction.AzureTrafficCollectorsCreateOrUpdate({
          ...where,
          location,
          tags,
          properties:
            news.virtualHubId === undefined
              ? {}
              : { virtualHub: { id: news.virtualHubId } },
        });
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (collector) => collector.properties?.provisioningState,
        COLLECTOR_BUDGET,
      );

      // Sync tags against observed state (the only mutable aspect).
      if (tagsDiffer(observed.tags, tags)) {
        yield* networkfunction.UpdateAzureTrafficCollectorTags({
          ...where,
          tags,
        });
        observed = yield* waitForProvisioned(
          label,
          get,
          (collector) =>
            tagsDiffer(collector.tags, tags)
              ? "Updating"
              : collector.properties?.provisioningState,
          COLLECTOR_BUDGET,
        );
      }

      return toAttrs(resourceGroup, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        networkfunction.DeleteAzureTrafficCollector({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          azureTrafficCollectorName: output.azureTrafficCollectorName,
        }),
      );
      yield* waitUntilGone(
        `Azure Traffic Collector ${output.azureTrafficCollectorName}`,
        getCollector(
          subscriptionId,
          output.resourceGroup,
          output.azureTrafficCollectorName,
        ),
        COLLECTOR_BUDGET,
      );
    }),

    nuke: { dependsOn: ["Azure.Resources.ResourceGroup"] },
  });
