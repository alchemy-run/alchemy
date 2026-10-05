import * as Azure from "@/Azure";
import { ensureRegistered } from "@/Azure/Arm";
import * as Test from "@/Test/Alchemy";
import * as elastic from "@distilled.cloud/azure/elastic";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import {
  location,
  logLevel,
  subscription,
  tags,
  userInfo,
  waitGone,
} from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getMonitor = (resourceGroupName: string, monitorName: string) =>
  Effect.gen(function* () {
    return yield* elastic.GetMonitor({
      subscriptionId: yield* subscription,
      resourceGroupName,
      monitorName,
    });
  });

const program = (props: {
  tags: Record<string, string>;
  monitoringStatus?: "Enabled" | "Disabled";
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", { location });
    const monitor = yield* Azure.Elastic.Monitor("Monitor", {
      resourceGroup: group.resourceGroupName,
      location,
      userInfo,
      monitoringStatus: props.monitoringStatus,
      tags: props.tags,
    });
    return { group, monitor };
  });

// Subscribes to the Elastic Cloud pay-as-you-go Marketplace plan and
// provisions a hosted Elastic deployment (~$0.50-1/hour while it exists,
// billed by Elastic). Provisioning ~10-50 minutes. The free trial cannot
// purchase Marketplace SaaS plans; run only with AZURE_TEST_PAID=1.
test.provider.skipIf(!runPaidOnly)(
  "create, update, replace, and delete an elastic monitor",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, monitor } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      expect(monitor.monitorId).not.toEqual("");
      const observed = yield* getMonitor(
        group.resourceGroupName,
        monitor.monitorName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");
      expect(monitor.kibanaServiceUrl).toBeDefined();

      // In place: tags.
      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.monitor.monitorId).toEqual(monitor.monitorId);
      const patched = yield* getMonitor(
        group.resourceGroupName,
        monitor.monitorName,
      );
      expect(patched.tags?.env).toEqual("prod");

      // Replacement: monitoring status cannot be patched.
      const replaced = yield* stack.deploy(
        program({ tags: { env: "prod" }, monitoringStatus: "Disabled" }),
      );
      expect(replaced.monitor.monitorName).not.toEqual(monitor.monitorName);
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
  { tags, timeout: 7_200_000 },
);

// Probe: the free trial rejects the Elastic Marketplace purchase before
// any monitor is created. Skipped on paid subscriptions.
test.provider.skipIf(runPaidOnly)(
  "free trial rejects the elastic marketplace purchase",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { group } = yield* stack.deploy(
        Effect.gen(function* () {
          const group = yield* Azure.Resources.ResourceGroup("Group", {
            location,
          });
          return { group };
        }),
      );
      const subscriptionId = yield* subscription;
      yield* ensureRegistered(subscriptionId, "Microsoft.Elastic");
      const error = yield* elastic
        .CreateMonitor({
          subscriptionId,
          resourceGroupName: group.resourceGroupName,
          monitorName: "alchemy-elastic-probe",
          location,
          sku: { name: "ess-consumption-2024_Monthly" },
          properties: { monitoringStatus: "Enabled", userInfo },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("MarketplacePurchaseNotEligible");
      expect(
        yield* waitGone(
          getMonitor(group.resourceGroupName, "alchemy-elastic-probe"),
        ),
      ).toEqual("gone");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);
