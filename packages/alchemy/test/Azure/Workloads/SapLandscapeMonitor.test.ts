import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as workloads from "@distilled.cloud/azure/workloads";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, monitorStack, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getLandscape = (resourceGroupName: string, monitorName: string) =>
  Effect.gen(function* () {
    return yield* workloads.GetSapLandscapeMonitor({
      subscriptionId: yield* subscription,
      resourceGroupName,
      monitorName,
    });
  });

const program = (green: number) =>
  Effect.gen(function* () {
    const { group, monitor } = yield* monitorStack({});
    const landscape = yield* Azure.Workloads.SapLandscapeMonitor("Landscape", {
      resourceGroup: group.resourceGroupName,
      monitor: monitor.monitorName,
      landscape: [{ name: "Production", topSid: ["S4P"] }],
      sapApplication: [{ name: "ERP", topSid: ["S4P", "S4Q"] }],
      topMetricsThresholds: [
        { name: "Instance Availability", green, yellow: 75, red: 50 },
      ],
    });
    return { group, monitor, landscape };
  });

// Needs an AMS monitor (~$0.25/hour, 10-20 minutes to create, ~10-30 to
// delete). Runs only with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete the landscape monitor configuration",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, monitor, landscape } = yield* stack.deploy(program(90));
      expect(landscape.landscape).toEqual([
        { name: "Production", topSid: ["S4P"] },
      ]);
      const observed = yield* getLandscape(
        group.resourceGroupName,
        monitor.monitorName,
      );
      expect(observed.properties?.topMetricsThresholds?.[0]?.green).toEqual(90);

      // In place: thresholds are PATCHed.
      const updated = yield* stack.deploy(program(95));
      expect(updated.landscape.sapLandscapeMonitorId).toEqual(
        landscape.sapLandscapeMonitorId,
      );
      const reobserved = yield* getLandscape(
        group.resourceGroupName,
        monitor.monitorName,
      );
      expect(reobserved.properties?.topMetricsThresholds?.[0]?.green).toEqual(
        95,
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(getLandscape(group.resourceGroupName, monitor.monitorName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 5_400_000 },
);

// Ungated probe (free: one empty resource group): the landscape monitor of
// a monitor that does not exist reads and deletes as the typed `NotFound`
// the provider treats as "absent".
test.provider(
  "the landscape monitor of a missing monitor reads as a typed not-found",
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
      const error = yield* getLandscape(group.resourceGroupName, "missing").pipe(
        Effect.flip,
      );
      expect(error._tag).toEqual("NotFound");
      const deleteError = yield* Effect.gen(function* () {
        return yield* workloads.DeleteSapLandscapeMonitor({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          monitorName: "missing",
        });
      }).pipe(Effect.flip);
      expect(deleteError._tag).toEqual("NotFound");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);
