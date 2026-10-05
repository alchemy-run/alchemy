import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as workloads from "@distilled.cloud/azure/workloads";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import {
  AMS_LOCATION,
  logLevel,
  monitorStack,
  subscription,
  tags,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getMonitor = (resourceGroupName: string, monitorName: string) =>
  Effect.gen(function* () {
    return yield* workloads.GetMonitor({
      subscriptionId: yield* subscription,
      resourceGroupName,
      monitorName,
    });
  });

// An AMS monitor deploys an Elastic Premium function app, storage account,
// key vault and Log Analytics workspace into its managed resource group:
// ~$0.25/hour, 10-20 minutes per create (twice here, for the replacement)
// plus ~10 minutes per delete. Runs only with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "create, update tags, replace, and delete a monitor",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, subnet, monitor } = yield* stack.deploy(
        monitorStack({ monitorTags: { env: "test" } }),
      );
      expect(monitor.provisioningState).toEqual("Succeeded");
      expect(monitor.routingPreference).toEqual("Default");
      expect(monitor.managedResourceGroupName).toBeDefined();
      const observed = yield* getMonitor(
        group.resourceGroupName,
        monitor.monitorName,
      );
      expect(observed.properties?.monitorSubnet?.toLowerCase()).toEqual(
        subnet.subnetId.toLowerCase(),
      );
      expect(observed.tags?.env).toEqual("test");
      expect(observed.tags?.["alchemy::id"]).toEqual("Ams");

      // In place: tags are PATCHed.
      const updated = yield* stack.deploy(
        monitorStack({ monitorTags: { env: "prod" } }),
      );
      expect(updated.monitor.monitorId).toEqual(monitor.monitorId);
      const reobserved = yield* getMonitor(
        group.resourceGroupName,
        monitor.monitorName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      // Replacement: the routing preference is immutable.
      const replaced = yield* stack.deploy(
        monitorStack({
          monitorTags: { env: "prod" },
          routingPreference: "RouteAll",
        }),
      );
      expect(replaced.monitor.monitorName).not.toEqual(monitor.monitorName);
      const replacedObserved = yield* getMonitor(
        group.resourceGroupName,
        replaced.monitor.monitorName,
      );
      expect(replacedObserved.properties?.routingPreference).toEqual(
        "RouteAll",
      );
      expect(
        yield* waitGone(
          getMonitor(group.resourceGroupName, monitor.monitorName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getMonitor(group.resourceGroupName, replaced.monitor.monitorName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 14_400_000 },
);

// Free, but slow: ARM accepts a monitor whose subnet does not exist, the
// managed deployment fails after ~4 minutes (`ArmOperationFailed` for the
// missing VNet, or `AppServicePlanDeploymentFailed` when the plan step
// fails first), and deleting the failed monitor takes 80-125 minutes. The provider surfaces the recorded error instead of
// hanging. Runs only with AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "a monitor in a missing subnet fails provisioning with a typed error",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const error = yield* stack
        .deploy(
          Effect.gen(function* () {
            const group = yield* Azure.Resources.ResourceGroup("Group", {
              location: AMS_LOCATION,
            });
            const subscriptionId = yield* subscription;
            const monitor = yield* Azure.Workloads.Monitor("Ams", {
              resourceGroup: group.resourceGroupName,
              location: AMS_LOCATION,
              monitorSubnet: Output.interpolate`/subscriptions/${subscriptionId}/resourceGroups/${group.resourceGroupName}/providers/Microsoft.Network/virtualNetworks/missing/subnets/missing`,
            });
            return { group, monitor };
          }),
        )
        .pipe(Effect.flip);
      expect(error._tag).toEqual("Azure.ProvisioningFailed");
      expect(JSON.stringify(error)).toMatch(
        /ArmOperationFailed|AppServicePlanDeploymentFailed/,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 14_400_000 },
);

// Ungated probe (free: one empty resource group): a missing monitor reads
// as the typed `ResourceNotFound` and deletes idempotently.
test.provider(
  "a missing monitor reads as a typed not-found and deletes idempotently",
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
      const error = yield* getMonitor(group.resourceGroupName, "missing").pipe(
        Effect.flip,
      );
      expect(error._tag).toEqual("ResourceNotFound");
      yield* Effect.gen(function* () {
        return yield* workloads.DeleteMonitor({
          subscriptionId: yield* subscription,
          resourceGroupName: group.resourceGroupName,
          monitorName: "missing",
        });
      });

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);
