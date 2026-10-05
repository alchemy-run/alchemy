import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const allowListed = !!process.env.AZURE_TEST_SERVICE_GATEWAYS;

const getGateway = (resourceGroupName: string, serviceGatewayName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetServiceGateway({
      subscriptionId,
      resourceGroupName,
      serviceGatewayName,
    }),
  );

const program = (props: { tags: Record<string, string> }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      addressPrefixes: ["10.0.0.0/16"],
    });
    const subnet = yield* Azure.Network.Subnet("Targets", {
      resourceGroup: group.resourceGroupName,
      virtualNetwork: vnet.virtualNetworkName,
      addressPrefix: "10.0.1.0/24",
    });
    const gateway = yield* Azure.Network.ServiceGateway("Gateway", {
      resourceGroup: group.resourceGroupName,
      virtualNetworkId: vnet.virtualNetworkId,
      routeTarget: { subnetId: subnet.subnetId },
      tags: props.tags,
    });
    return { group, vnet, subnet, gateway };
  });

// Service gateways need the Microsoft.Network/AllowServiceGateways preview
// feature, which is allow-listed by Microsoft (self-registration fails with
// "The feature 'AllowServiceGateways' does not support registration").
// Without it ARM answers "Subscription X is not registered for feature
// Microsoft.Network/AllowServiceGateways". Probe the typed rejection.
test.provider.skipIf(allowListed)(
  "service gateway creation is rejected without the preview feature",
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
      const sub = yield* subscriptionId;
      const error = yield* network
        .ServiceGatewaysCreateOrUpdate({
          subscriptionId: sub,
          resourceGroupName: group.resourceGroupName,
          serviceGatewayName: "probe",
          location: "eastus",
          sku: { name: "Standard", tier: "Regional" },
          properties: {
            virtualNetwork: {
              id: `/subscriptions/${sub}/resourceGroups/${group.resourceGroupName}/providers/Microsoft.Network/virtualNetworks/probe`,
            },
          },
        })
        .pipe(Effect.flip);
      expect(error._tag).toEqual("SubscriptionFeatureNotRegistered");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 300_000 },
);

// Service gateways are preview; the Standard SKU bills per hour (cents
// for a few minutes). Needs the AllowServiceGateways feature: run with
// AZURE_TEST_PAID=1 and AZURE_TEST_SERVICE_GATEWAYS=1 on an allow-listed
// subscription.
test.provider.skipIf(!runPaidOnly || !allowListed)(
  "create, update, and delete a service gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, gateway } = yield* stack.deploy(
        program({ tags: { env: "test" } }),
      );
      const observed = yield* getGateway(
        group.resourceGroupName,
        gateway.serviceGatewayName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(program({ tags: { env: "prod" } }));
      expect(updated.gateway.serviceGatewayId).toEqual(
        gateway.serviceGatewayId,
      );
      const reobserved = yield* getGateway(
        group.resourceGroupName,
        gateway.serviceGatewayName,
      );
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getGateway(group.resourceGroupName, gateway.serviceGatewayName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
