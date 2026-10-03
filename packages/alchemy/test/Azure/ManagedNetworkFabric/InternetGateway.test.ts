import * as Azure from "@/Azure";
import * as AdoptPolicy from "@/AdoptPolicy";
import * as Test from "@/Test/Alchemy";
import * as mnf from "@distilled.cloud/azure/managednetworkfabric";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });
// An internet gateway the RP created alongside an Operator Nexus Network
// Fabric Controller: `<resourceGroup>/<name>`.
const [gatewayGroup = "", gatewayName = ""] = (
  process.env.AZURE_NEXUS_INTERNET_GATEWAY ?? ""
).split("/");
const controllerId = process.env.AZURE_NEXUS_NFC_ID ?? "";

const get = (resourceGroupName: string, internetGatewayName: string) =>
  Effect.gen(function* () {
    return yield* mnf.GetInternetGateway({
      subscriptionId: yield* subscription,
      resourceGroupName,
      internetGatewayName,
    });
  });

const program = (props: { withRule: boolean; env: string }) =>
  Effect.gen(function* () {
    const rule = yield* Azure.ManagedNetworkFabric.InternetGatewayRule("Rule", {
      resourceGroup: gatewayGroup,
      location: "eastus",
      ruleProperties: { action: "Allow", addressList: ["10.10.10.10"] },
    });
    const res = yield* Azure.ManagedNetworkFabric.InternetGateway("Gateway", {
      resourceGroup: gatewayGroup,
      name: gatewayName,
      location: "eastus",
      networkFabricControllerId: controllerId,
      type: "Workload",
      internetGatewayRuleId: props.withRule
        ? rule.internetGatewayRuleId
        : undefined,
      tags: { env: props.env },
    }).pipe(AdoptPolicy.adopt());
    return { rule, res };
  });

// Internet gateways are created by the RP together with an Operator Nexus
// Network Fabric Controller (AZURE_NEXUS_NFC_ID, AZURE_NEXUS_INTERNET_GATEWAY),
// which needs ExpressRoute circuits to on-premises Nexus racks; the trial
// cannot create one. The test adopts the gateway, syncs its rule and tags,
// and deletes it: ARM configuration only, ~$0, a few minutes.
test.provider.skipIf(!runPaidOnly || !controllerId || !gatewayName)(
  "adopt, update, and delete an internet gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { res } = yield* stack.deploy(
        program({ withRule: false, env: "one" }),
      );
      const observed = yield* get(gatewayGroup, res.internetGatewayName);
      expect(observed.tags?.env).toEqual("one");
      expect(res.provisioningState).toEqual("Succeeded");

      // In place: attach the rule.
      const updated = yield* stack.deploy(
        program({ withRule: true, env: "two" }),
      );
      expect(updated.res.internetGatewayId).toEqual(res.internetGatewayId);
      const reobserved = yield* get(gatewayGroup, res.internetGatewayName);
      expect(
        reobserved.properties.internetGatewayRuleId?.toLowerCase(),
      ).toEqual(updated.rule.internetGatewayRuleId.toLowerCase());
      expect(reobserved.tags?.env).toEqual("two");

      yield* stack.destroy();
      expect(
        yield* waitGone(get(gatewayGroup, res.internetGatewayName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);

// Ungated probe: the RP never accepts a user PUT of an internet gateway.
// Only a resource group is created ($0, ~1-2 minutes).
test.provider(
  "the RP rejects creating an internet gateway directly",
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
      const resourceGroupName = group.resourceGroupName;
      const base = `/subscriptions/${subscriptionId}/resourceGroups/${resourceGroupName}/providers/Microsoft.ManagedNetworkFabric`;
      const error = yield* mnf
        .CreateInternetGateway({
          subscriptionId,
          resourceGroupName,
          internetGatewayName: "probe",
          location: "eastus",
          properties: {
            networkFabricControllerId: `${base}/networkFabricControllers/nonfc`,
            type: "Workload",
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("BadRequest");
      expect(error.message).toContain(
        "InternetGateways get created when a Network Fabric Controller is created",
      );

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
