import * as Azure from "@/Azure";
import { ensureRegistered } from "@/Azure/Arm";
import * as Test from "@/Test/Alchemy";
import * as networkfunction from "@distilled.cloud/azure/networkfunction";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPolicy = (
  resourceGroupName: string,
  azureTrafficCollectorName: string,
  collectorPolicyName: string,
) =>
  Effect.flatMap(subscription, (subscriptionId) =>
    networkfunction.GetCollectorPolicy({
      subscriptionId,
      resourceGroupName,
      azureTrafficCollectorName,
      collectorPolicyName,
    }),
  );

const program = (props: {
  bothCircuits: boolean;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // Both circuits stay deployed across every step. Collector policies
    // reject circuits under 1 Gbps (`CollectorPolicyCircuitBandwidthNotSupported`).
    const primary = yield* Azure.Network.ExpressRouteCircuit("Primary", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      serviceProviderName: "Equinix",
      peeringLocation: "Washington DC",
      bandwidthInMbps: 1000,
    });
    const secondary = yield* Azure.Network.ExpressRouteCircuit("Secondary", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      serviceProviderName: "Equinix",
      peeringLocation: "Washington DC",
      bandwidthInMbps: 1000,
    });
    const collector = yield* Azure.NetworkFunction.AzureTrafficCollector(
      "Collector",
      { resourceGroup: group.resourceGroupName, location: "eastus" },
    );
    const policy = yield* Azure.NetworkFunction.CollectorPolicy("Policy", {
      resourceGroup: group.resourceGroupName,
      azureTrafficCollector: collector.azureTrafficCollectorName,
      location: collector.location,
      ingestionSourceIds: props.bothCircuits
        ? [primary.circuitId, secondary.circuitId]
        : [primary.circuitId],
      tags: props.tags,
    });
    return { group, primary, secondary, collector, policy };
  });

// Needs two 1 Gbps ExpressRoute circuits (≈ $0.60/hour each, billed from
// creation) plus the collector (≈ $0.60/hour); ≈ $1-2 and ~25 minutes per
// run. Not runnable on the free trial.
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete a collector policy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, primary, collector, policy } = yield* stack.deploy(
        program({ bothCircuits: false, tags: { env: "test" } }),
      );
      const get = () =>
        getPolicy(
          group.resourceGroupName,
          collector.azureTrafficCollectorName,
          policy.collectorPolicyName,
        );
      const observed = yield* get();
      expect(
        observed.properties?.ingestionPolicy?.ingestionSources?.map((s) =>
          s.resourceId?.toLowerCase(),
        ),
      ).toEqual([primary.circuitId.toLowerCase()]);
      expect(
        observed.properties?.emissionPolicies?.[0]?.emissionDestinations,
      ).toEqual([{ destinationType: "AzureMonitor" }]);
      expect(observed.tags?.env).toEqual("test");

      // In-place: add a circuit and change tags.
      const updated = yield* stack.deploy(
        program({ bothCircuits: true, tags: { env: "updated" } }),
      );
      expect(updated.policy.collectorPolicyId).toEqual(
        policy.collectorPolicyId,
      );
      const reobserved = yield* get();
      expect(
        reobserved.properties?.ingestionPolicy?.ingestionSources?.length,
      ).toEqual(2);
      expect(reobserved.tags?.env).toEqual("updated");

      yield* stack.destroy();
      expect(yield* waitGone(get())).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 2_700_000 },
);

// Ungated, free probe: a missing policy reads as the typed
// `ResourceNotFound`, and writing a policy under a missing collector fails
// with the typed `NotFound` (ARM's parent-not-found 404).
test.provider(
  "collector policy reads and writes against a missing collector are typed",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location: "eastus",
          });
          return { group };
        }),
      );
      const subscriptionId = yield* subscription;
      yield* ensureRegistered(subscriptionId, "Microsoft.NetworkFunction");
      const getError = yield* getPolicy(
        group.resourceGroupName,
        "missing-collector",
        "missing-policy",
      ).pipe(Effect.flip);
      expect(getError._tag).toEqual("ResourceNotFound");
      const putError = yield* networkfunction
        .CollectorPoliciesCreateOrUpdate({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          azureTrafficCollectorName: "missing-collector",
          collectorPolicyName: "missing-policy",
          location: "eastus",
          properties: {
            ingestionPolicy: {
              ingestionType: "IPFIX",
              ingestionSources: [
                {
                  sourceType: "Resource",
                  resourceId: `/subscriptions/${subscriptionId}/resourceGroups/${group.resourceGroupName}/providers/Microsoft.Network/expressRouteCircuits/missing`,
                },
              ],
            },
            emissionPolicies: [
              {
                emissionType: "IPFIX",
                emissionDestinations: [{ destinationType: "AzureMonitor" }],
              },
            ],
          },
        })
        .pipe(Effect.flip);
      expect(putError._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
