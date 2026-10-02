import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as eventhub from "@distilled.cloud/azure/eventhub";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConfig = (
  resourceGroupName: string,
  namespaceName: string,
  alias: string,
) =>
  Effect.gen(function* () {
    return yield* eventhub.GetDisasterRecoveryConfig({
      subscriptionId: yield* subscription,
      resourceGroupName,
      namespaceName,
      alias,
    });
  });

const program = (props: { secondary: "Secondary" | "Standby" }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // Geo-DR needs Standard namespaces in two regions.
    const primary = yield* Azure.EventHub.Namespace("Primary", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
      sku: "Standard",
    });
    // Both secondaries stay deployed across the replacement step.
    const secondary = yield* Azure.EventHub.Namespace("Secondary", {
      resourceGroup: group.resourceGroupName,
      location: "westus2",
      sku: "Standard",
    });
    const standby = yield* Azure.EventHub.Namespace("Standby", {
      resourceGroup: group.resourceGroupName,
      location: "westus2",
      sku: "Standard",
    });
    const partner = props.secondary === "Secondary" ? secondary : standby;
    const geoDr = yield* Azure.EventHub.DisasterRecoveryConfig("GeoDr", {
      resourceGroup: group.resourceGroupName,
      namespace: primary.namespaceName,
      partnerNamespace: partner.namespaceId,
    });
    return { group, primary, secondary, standby, geoDr };
  });

// Three Standard namespaces (~$0.03/hour each) for ~10-15 minutes: ~$0.03.
test.provider(
  "pair, re-pair (replace), and unpair two namespaces",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, primary, secondary, geoDr } = yield* stack.deploy(
        program({ secondary: "Secondary" }),
      );
      const get = (alias: string) =>
        getConfig(group.resourceGroupName, primary.namespaceName, alias);
      expect(geoDr.role).toEqual("Primary");
      const observed = yield* get(geoDr.alias);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.role).toEqual("Primary");
      expect(observed.properties?.partnerNamespace?.toLowerCase()).toEqual(
        secondary.namespaceId.toLowerCase(),
      );
      // The secondary sees the same alias in the Secondary role.
      const mirrored = yield* getConfig(
        group.resourceGroupName,
        secondary.namespaceName,
        geoDr.alias,
      );
      expect(mirrored.properties?.role).toEqual("Secondary");

      // Replacement: a different partner namespace.
      const replaced = yield* stack.deploy(program({ secondary: "Standby" }));
      expect(replaced.geoDr.role).toEqual("Primary");
      const replacedObserved = yield* get(replaced.geoDr.alias);
      expect(
        replacedObserved.properties?.partnerNamespace?.toLowerCase(),
      ).toEqual(replaced.standby.namespaceId.toLowerCase());

      yield* stack.destroy();
      expect(yield* waitGone(get(replaced.geoDr.alias))).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
