import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as servicebus from "@distilled.cloud/azure/servicebus";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { runExpensive } from "../gates.ts";

const { test } = Test.make({ providers: Azure.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const getAlias = (
  resourceGroupName: string,
  namespaceName: string,
  alias: string,
) =>
  Effect.gen(function* () {
    const { subscriptionId } = yield* Azure.AzureEnvironment.current;
    return yield* servicebus.GetDisasterRecoveryConfig({
      subscriptionId,
      resourceGroupName,
      namespaceName,
      alias,
    });
  });

const aliasGone = (
  resourceGroupName: string,
  namespaceName: string,
  alias: string,
) =>
  getAlias(resourceGroupName, namespaceName, alias).pipe(
    Effect.as("found" as const),
    Effect.catchTag(
      ["ResourceNotFound", "ResourceGroupNotFound", "NotFound"],
      () => Effect.succeed("gone" as const),
    ),
    Effect.repeat({
      schedule: Schedule.spaced("10 seconds"),
      until: (status) => status === "gone",
      times: 30,
    }),
  );

const program = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  const primary = yield* Azure.ServiceBus.Namespace("Primary", {
    resourceGroup: group.resourceGroupName,
    location: "eastus",
    sku: "Premium",
    capacity: 1,
  });
  const secondary = yield* Azure.ServiceBus.Namespace("Secondary", {
    resourceGroup: group.resourceGroupName,
    location: "westus",
    sku: "Premium",
    capacity: 1,
  });
  const geoDr = yield* Azure.ServiceBus.DisasterRecoveryConfig("GeoDr", {
    resourceGroup: group.resourceGroupName,
    namespace: primary.namespaceName,
    partnerNamespace: secondary.namespaceId,
  });
  return { group, primary, secondary, geoDr };
});

// Two Premium namespaces (1 MU each, ~$0.93/h each, billed per started
// hour) => ~$1.90 per run; Premium provisioning + pairing ~10-20 minutes.
// Gated behind AZURE_TEST_EXPENSIVE=1.
test.provider.skipIf(!runExpensive)(
  "pair, verify, break, and delete a service bus geo-dr alias",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, primary, secondary, geoDr } = yield* stack.deploy(program);
      const rg = group.resourceGroupName;
      expect(geoDr.alias.length).toBeLessThanOrEqual(50);
      expect(geoDr.alias).toMatch(/^[a-z]/);
      const observed = yield* getAlias(rg, primary.namespaceName, geoDr.alias);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.role).toEqual("Primary");
      expect(observed.properties?.partnerNamespace?.toLowerCase()).toEqual(
        secondary.namespaceId.toLowerCase(),
      );

      // Idempotent redeploy keeps the pairing.
      const again = yield* stack.deploy(program);
      expect(again.geoDr.disasterRecoveryConfigId).toEqual(
        geoDr.disasterRecoveryConfigId,
      );

      yield* stack.destroy();
      expect(yield* aliasGone(rg, primary.namespaceName, geoDr.alias)).toEqual(
        "gone",
      );
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:servicebus", "live"],
    timeout: 1_800_000,
  },
);
