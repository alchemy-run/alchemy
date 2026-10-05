import * as Azure from "@/Azure";
import { ensureRegistered } from "@/Azure/Arm";
import * as Test from "@/Test/Alchemy";
import * as networkfunction from "@distilled.cloud/azure/networkfunction";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getCollector = (
  resourceGroupName: string,
  azureTrafficCollectorName: string,
) =>
  Effect.flatMap(subscription, (subscriptionId) =>
    networkfunction.GetAzureTrafficCollector({
      subscriptionId,
      resourceGroupName,
      azureTrafficCollectorName,
    }),
  );

const program = (props: { location: string; tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const collector = yield* Azure.NetworkFunction.AzureTrafficCollector(
      "Collector",
      {
        resourceGroup: group.resourceGroupName,
        location: props.location,
        tags: props.tags,
      },
    );
    return { group, collector };
  });

// The collector bills ≈ $0.60/hour of uptime (billed per started hour;
// two collectors across the replacement step ≈ $1.20 per run) and takes
// 5-10 minutes to provision (≈ 25 minutes for the whole lifecycle).
test.provider.skipIf(!runExpensive)(
  "create, update tags, replace, and delete an Azure Traffic Collector",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, collector } = yield* stack.deploy(
        program({ location: "eastus", tags: { env: "test" } }),
      );
      const observed = yield* getCollector(
        group.resourceGroupName,
        collector.azureTrafficCollectorName,
      );
      expect(observed.location.toLowerCase()).toEqual("eastus");
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Collector");
      expect(collector.tags).toEqual({ env: "test" });

      // In-place: tags only.
      const updated = yield* stack.deploy(
        program({ location: "eastus", tags: { env: "updated" } }),
      );
      expect(updated.collector.azureTrafficCollectorId).toEqual(
        collector.azureTrafficCollectorId,
      );
      const reobserved = yield* getCollector(
        group.resourceGroupName,
        collector.azureTrafficCollectorName,
      );
      expect(reobserved.tags?.env).toEqual("updated");

      // Replacement: location is immutable.
      const replaced = yield* stack.deploy(
        program({ location: "westus2", tags: { env: "updated" } }),
      );
      expect(replaced.collector.azureTrafficCollectorName).not.toEqual(
        collector.azureTrafficCollectorName,
      );
      const replacedObserved = yield* getCollector(
        group.resourceGroupName,
        replaced.collector.azureTrafficCollectorName,
      );
      expect(replacedObserved.location.toLowerCase()).toEqual("westus2");
      expect(
        yield* waitGone(
          getCollector(
            group.resourceGroupName,
            collector.azureTrafficCollectorName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getCollector(
            group.resourceGroupName,
            replaced.collector.azureTrafficCollectorName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  // Two 6-minute provisions plus two deletes outlast the default budget.
  { tags, timeout: 2_700_000 },
);

// Ungated, free probe: a missing collector reads as the typed
// `ResourceNotFound` the provider treats as "absent", and an idempotent
// delete of it succeeds.
test.provider(
  "a missing Azure Traffic Collector reads as a typed not-found",
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
      const error = yield* getCollector(
        group.resourceGroupName,
        "missing-collector",
      ).pipe(Effect.flip);
      expect(error._tag).toEqual("ResourceNotFound");
      expect(
        yield* networkfunction
          .DeleteAzureTrafficCollector({
            subscriptionId,
            resourceGroupName: group.resourceGroupName,
            azureTrafficCollectorName: "missing-collector",
          })
          .pipe(Effect.as("deleted")),
      ).toEqual("deleted");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
