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

/** Destination a collector policy emits flow records to. */
export type CollectorPolicyEmissionDestination = "AzureMonitor";

export interface CollectorPolicyProps {
  /** Resource group of the parent collector. Changing it replaces the policy. */
  resourceGroup: string;
  /**
   * Name of the parent `Azure.NetworkFunction.AzureTrafficCollector`.
   * Changing it replaces the policy.
   */
  azureTrafficCollector: string;
  /**
   * Policy name: 1-80 letters, digits, `_`, `.`, and `-`. If omitted, a
   * unique name is generated from the app, stage, and logical ID. Changing
   * it replaces the policy.
   */
  name?: string;
  /**
   * Azure location of the policy; must equal the collector's location.
   * Changing it replaces the policy.
   * @default the `Azure.Location` layer, else the profile location, else `eastus`
   */
  location?: string;
  /**
   * ARM IDs of the ExpressRoute circuits whose IPFIX flow records the
   * policy ingests. Updated in place.
   */
  ingestionSourceIds: string[];
  /**
   * Destinations the sampled flow records are emitted to (IPFIX). Updated
   * in place.
   * @default ["AzureMonitor"]
   */
  emissionDestinations?: CollectorPolicyEmissionDestination[];
  /**
   * User tags. Alchemy ownership tags (`alchemy::stack`, `alchemy::stage`,
   * `alchemy::id`) are merged in automatically.
   */
  tags?: Record<string, string>;
}

export interface CollectorPolicy extends Resource<
  "Azure.NetworkFunction.CollectorPolicy",
  CollectorPolicyProps,
  {
    /** Name of the policy. */
    collectorPolicyName: string;
    /** ARM resource ID of the policy. */
    collectorPolicyId: string;
    /** Name of the parent collector. */
    azureTrafficCollector: string;
    /** Resource group of the parent collector. */
    resourceGroup: string;
    /** Location of the policy. */
    location: string;
    /** ARM IDs of the ExpressRoute circuits the policy ingests. */
    ingestionSourceIds: string[];
    /** Destinations the flow records are emitted to. */
    emissionDestinations: string[];
    /** Provisioning state (`Succeeded`, `Updating`, `Deleting`, `Failed`). */
    provisioningState: string | undefined;
    /** Opaque ETag that changes whenever the policy is updated. */
    etag: string | undefined;
    /** User tags (Alchemy ownership tags stripped). */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * A collector policy on an Azure Traffic Collector — ingests sampled
 * IPFIX flow records from ExpressRoute circuits and emits them to Azure
 * Monitor (Log Analytics).
 *
 * Ingestion sources, emission destinations, and tags update in place;
 * the collector, resource group, name, and location replace the policy.
 *
 * @see https://learn.microsoft.com/azure/expressroute/how-to-configure-traffic-collector
 *
 * ### Collecting Circuit Flow Logs
 * **Example:** Emit a circuit's flows to Azure Monitor
 * ```typescript
 * const policy = yield* Azure.NetworkFunction.CollectorPolicy("circuit", {
 *   resourceGroup: group.resourceGroupName,
 *   azureTrafficCollector: collector.azureTrafficCollectorName,
 *   location: collector.location,
 *   ingestionSourceIds: [circuit.circuitId],
 * });
 * ```
 *
 * ### Monitoring Several Circuits
 * **Example:** One policy for two circuits
 * ```typescript
 * yield* Azure.NetworkFunction.CollectorPolicy("circuits", {
 *   resourceGroup: group.resourceGroupName,
 *   azureTrafficCollector: collector.azureTrafficCollectorName,
 *   location: collector.location,
 *   ingestionSourceIds: [primary.circuitId, secondary.circuitId],
 *   emissionDestinations: ["AzureMonitor"],
 *   tags: { team: "network" },
 * });
 * ```
 *
 * @resource
 */
export const CollectorPolicy = Resource<CollectorPolicy>(
  "Azure.NetworkFunction.CollectorPolicy",
);

const getPolicy = (
  subscriptionId: string,
  resourceGroupName: string,
  azureTrafficCollectorName: string,
  collectorPolicyName: string,
) =>
  orUndefinedIfNotFound(
    networkfunction.GetCollectorPolicy({
      subscriptionId,
      resourceGroupName,
      azureTrafficCollectorName,
      collectorPolicyName,
    }),
  );

type ObservedPolicy =
  | networkfunction.GetCollectorPolicyResponse
  | networkfunction.CollectorPolicy;

const sourcesOf = (policy: ObservedPolicy) =>
  (policy.properties?.ingestionPolicy?.ingestionSources ?? []).flatMap(
    (source) => (source.resourceId === undefined ? [] : [source.resourceId]),
  );

const destinationsOf = (policy: ObservedPolicy) =>
  (policy.properties?.emissionPolicies ?? []).flatMap((emission) =>
    (emission.emissionDestinations ?? []).flatMap((destination) =>
      destination.destinationType === undefined
        ? []
        : [destination.destinationType],
    ),
  );

/** Order-insensitive, case-insensitive comparison of string sets. */
const sameSet = (a: ReadonlyArray<string>, b: ReadonlyArray<string>) => {
  const norm = (values: ReadonlyArray<string>) =>
    [...new Set(values.map((value) => value.toLowerCase()))].sort().join("\n");
  return norm(a) === norm(b);
};

const toAttrs = (
  resourceGroup: string,
  collector: string,
  name: string,
  policy: ObservedPolicy,
): CollectorPolicy["Attributes"] => ({
  collectorPolicyName: name,
  collectorPolicyId: policy.id ?? "",
  azureTrafficCollector: collector,
  resourceGroup,
  location: policy.location,
  ingestionSourceIds: sourcesOf(policy),
  emissionDestinations: destinationsOf(policy),
  provisioningState: policy.properties?.provisioningState,
  etag: policy.etag,
  tags: userTags(policy.tags),
});

/** Collector name from a policy's ARM ID, e.g. for `list` results. */
const collectorOf = (armId: string | undefined) =>
  armId?.match(/\/azureTrafficCollectors\/([^/]+)/i)?.[1];

export const CollectorPolicyProvider = () =>
  Provider.succeed(CollectorPolicy, {
    stables: [
      "collectorPolicyName",
      "collectorPolicyId",
      "azureTrafficCollector",
      "resourceGroup",
      "location",
    ],

    list: Effect.fn(function* () {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const collectors = yield* networkfunction
        .ListAzureTrafficCollectorsBySubscription({ subscriptionId })
        .pipe(
          Effect.flatMap((page) =>
            requireSinglePage("ListAzureTrafficCollectorsBySubscription", page),
          ),
        );
      const pages = yield* Effect.forEach(
        (collectors.value ?? []).flatMap((collector) => {
          const group = resourceGroupOf(collector.id);
          return group !== undefined && collector.name !== undefined
            ? [{ group, name: collector.name }]
            : [];
        }),
        ({ group, name }) =>
          orUndefinedIfNotFound(
            networkfunction
              .ListCollectorPolicies({
                subscriptionId,
                resourceGroupName: group,
                azureTrafficCollectorName: name,
              })
              .pipe(
                Effect.flatMap((page) =>
                  requireSinglePage("ListCollectorPolicies", page),
                ),
              ),
          ),
        { concurrency: 4 },
      );
      return pages.flatMap((page) =>
        (page?.value ?? []).flatMap((policy) => {
          const group = resourceGroupOf(policy.id);
          const collector = collectorOf(policy.id);
          return hasAnyAlchemyTag(policy.tags) &&
            group !== undefined &&
            collector !== undefined &&
            policy.name !== undefined
            ? [toAttrs(group, collector, policy.name, policy)]
            : [];
        }),
      );
    }),

    diff: Effect.fn(function* ({ news, output }) {
      if (!isResolved(news) || output === undefined) return undefined;
      if (
        !sameArm(news.resourceGroup, output.resourceGroup) ||
        !sameArm(news.azureTrafficCollector, output.azureTrafficCollector) ||
        (news.name !== undefined &&
          !sameArm(news.name, output.collectorPolicyName)) ||
        (news.location !== undefined &&
          !sameArm(news.location, output.location))
      ) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      const resourceGroup = output?.resourceGroup ?? olds?.resourceGroup;
      const collector =
        output?.azureTrafficCollector ?? olds?.azureTrafficCollector;
      if (resourceGroup === undefined || collector === undefined) {
        return undefined;
      }
      const name =
        output?.collectorPolicyName ??
        olds?.name ??
        (yield* createNetworkFunctionName(id));
      const observed = yield* getPolicy(
        subscriptionId,
        resourceGroup,
        collector,
        name,
      );
      if (observed === undefined) return undefined;
      const attrs = toAttrs(resourceGroup, collector, name, observed);
      return (yield* isOwned(id, observed.tags)) ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* AzureEnvironment.current;
      const { subscriptionId } = env;
      yield* ensureRegistered(subscriptionId, "Microsoft.NetworkFunction");
      const resourceGroup = news.resourceGroup;
      const collector = news.azureTrafficCollector;
      const name =
        news.name ??
        output?.collectorPolicyName ??
        (yield* createNetworkFunctionName(id));
      const location = news.location ?? output?.location ?? env.location;
      const tags = yield* desiredTags(id, news.tags);
      const destinations = news.emissionDestinations ?? ["AzureMonitor"];
      const where = {
        subscriptionId,
        resourceGroupName: resourceGroup,
        azureTrafficCollectorName: collector,
        collectorPolicyName: name,
      };
      const put = networkfunction.CollectorPoliciesCreateOrUpdate({
        ...where,
        location,
        tags,
        properties: {
          ingestionPolicy: {
            ingestionType: "IPFIX",
            ingestionSources: news.ingestionSourceIds.map((resourceId) => ({
              sourceType: "Resource",
              resourceId,
            })),
          },
          emissionPolicies: [
            {
              emissionType: "IPFIX",
              emissionDestinations: destinations.map((destinationType) => ({
                destinationType,
              })),
            },
          ],
        },
      });
      const get = getPolicy(subscriptionId, resourceGroup, collector, name);
      const label = `collector policy ${name}`;
      const policyDiffers = (policy: ObservedPolicy) =>
        !sameSet(sourcesOf(policy), news.ingestionSourceIds) ||
        !sameSet(destinationsOf(policy), destinations);

      // Observe.
      let observed = yield* get;

      // Ensure.
      if (observed === undefined) {
        yield* put;
      }
      observed = yield* waitForProvisioned(
        label,
        get,
        (policy) => policy.properties?.provisioningState,
        COLLECTOR_BUDGET,
      );

      // Sync ingestion/emission policies (full PUT carries the tags too).
      if (policyDiffers(observed)) {
        yield* put;
        observed = yield* waitForProvisioned(
          label,
          get,
          (policy) =>
            policyDiffers(policy)
              ? "Updating"
              : policy.properties?.provisioningState,
          COLLECTOR_BUDGET,
        );
      }

      // Sync tags against observed state.
      if (tagsDiffer(observed.tags, tags)) {
        yield* networkfunction.UpdateCollectorPolicyTags({ ...where, tags });
        observed = yield* waitForProvisioned(
          label,
          get,
          (policy) =>
            tagsDiffer(policy.tags, tags)
              ? "Updating"
              : policy.properties?.provisioningState,
          COLLECTOR_BUDGET,
        );
      }

      return toAttrs(resourceGroup, collector, name, observed);
    }),

    delete: Effect.fn(function* ({ output }) {
      const { subscriptionId } = yield* AzureEnvironment.current;
      yield* ignoreNotFound(
        networkfunction.DeleteCollectorPolicy({
          subscriptionId,
          resourceGroupName: output.resourceGroup,
          azureTrafficCollectorName: output.azureTrafficCollector,
          collectorPolicyName: output.collectorPolicyName,
        }),
      );
      yield* waitUntilGone(
        `collector policy ${output.collectorPolicyName}`,
        getPolicy(
          subscriptionId,
          output.resourceGroup,
          output.azureTrafficCollector,
          output.collectorPolicyName,
        ),
        COLLECTOR_BUDGET,
      );
    }),

    // A policy must be gone before its collector can be deleted.
    nuke: {
      dependsOn: [
        "Azure.NetworkFunction.AzureTrafficCollector",
        "Azure.Resources.ResourceGroup",
      ],
    },
  });
