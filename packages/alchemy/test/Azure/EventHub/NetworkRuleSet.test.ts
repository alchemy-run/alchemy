import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as eventhub from "@distilled.cloud/azure/eventhub";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getRuleSet = (resourceGroupName: string, namespaceName: string) =>
  Effect.gen(function* () {
    return yield* eventhub.GetNamespaceNetworkRuleSet({
      subscriptionId: yield* subscription,
      resourceGroupName,
      namespaceName,
    });
  });

const program = (
  firewall:
    | { ipRules: string[]; trustedServiceAccessEnabled: boolean }
    | undefined,
) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    // IP firewall rules need a Standard namespace.
    const namespace = yield* Azure.EventHub.Namespace("Events", {
      resourceGroup: group.resourceGroupName,
      sku: "Standard",
    });
    if (firewall) {
      yield* Azure.EventHub.NetworkRuleSet("Firewall", {
        resourceGroup: group.resourceGroupName,
        namespace: namespace.namespaceName,
        defaultAction: "Deny",
        trustedServiceAccessEnabled: firewall.trustedServiceAccessEnabled,
        ipRules: firewall.ipRules.map((ipMask) => ({ ipMask })),
      });
    }
    return { group, namespace };
  });

// Standard namespace (~$0.03/hour) for a few minutes: well under $0.05.
test.provider(
  "configure, update, and reset a namespace network rule set",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, namespace } = yield* stack.deploy(
        program({
          ipRules: ["203.0.113.0/24"],
          trustedServiceAccessEnabled: false,
        }),
      );
      const observe = getRuleSet(
        group.resourceGroupName,
        namespace.namespaceName,
      );
      const created = yield* observe;
      expect(created.properties?.defaultAction).toEqual("Deny");
      expect(created.properties?.ipRules?.map((r) => r.ipMask)).toEqual([
        "203.0.113.0/24",
      ]);

      // In-place: another IP range and trusted services.
      yield* stack.deploy(
        program({
          ipRules: ["203.0.113.0/24", "198.51.100.7"],
          trustedServiceAccessEnabled: true,
        }),
      );
      const updated = yield* observe;
      expect(
        [...(updated.properties?.ipRules ?? []).map((r) => r.ipMask)].sort(),
      ).toEqual(["198.51.100.7", "203.0.113.0/24"]);
      expect(updated.properties?.trustedServiceAccessEnabled).toEqual(true);

      // Removing the resource resets the firewall (there is no DELETE).
      yield* stack.deploy(program(undefined));
      const reset = yield* observe;
      expect(reset.properties?.defaultAction).toEqual("Allow");
      expect(reset.properties?.ipRules ?? []).toEqual([]);
      expect(reset.properties?.trustedServiceAccessEnabled ?? false).toEqual(
        false,
      );

      yield* stack.destroy();
      expect(yield* waitGone(observe)).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
