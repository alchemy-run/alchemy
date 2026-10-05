import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { runExpensive } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";
import { standardHub } from "./wanFixtures.ts";

const { test } = Test.make({ providers: Azure.providers() });

const FIREWALL = "alchemy-routing-intent-hub-fw";

const getIntent = (
  resourceGroupName: string,
  virtualHubName: string,
  routingIntentName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetRoutingIntent({
      subscriptionId,
      resourceGroupName,
      virtualHubName,
      routingIntentName,
    }),
  );

const firewallId = (sub: string, resourceGroup: string) =>
  `/subscriptions/${sub}/resourceGroups/${resourceGroup}/providers/Microsoft.Network/azureFirewalls/${FIREWALL}`;

const program = (destinations: ("Internet" | "PrivateTraffic")[]) =>
  Effect.gen(function* () {
    const sub = yield* subscriptionId;
    const { group, wan, hub } = yield* standardHub;
    const intent = yield* Azure.Network.RoutingIntent("Intent", {
      resourceGroup: group.resourceGroupName,
      virtualHub: hub.virtualHubName,
      routingPolicies: destinations.map((destination) => ({
        name: `${destination}Policy`,
        destinations: [destination],
        nextHop: Output.map(group.resourceGroupName, (resourceGroup) =>
          firewallId(sub, resourceGroup),
        ),
      })),
    });
    return { group, wan, hub, intent };
  });

// The hub firewall (AzureFirewall does not model hub firewalls) is created
// out of band. Standard hub (~$0.25/hour) + hub firewall (~$1.25/hour),
// 30-60 minutes: ≈$2 per run.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a routing intent",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const sub = yield* subscriptionId;

      const { group, hub } = yield* stack.deploy(standardHub);
      yield* network.AzureFirewallsCreateOrUpdate({
        subscriptionId: sub,
        resourceGroupName: group.resourceGroupName,
        azureFirewallName: FIREWALL,
        location: "eastus",
        properties: {
          sku: { name: "AZFW_Hub", tier: "Standard" },
          virtualHub: { id: hub.virtualHubId },
          hubIPAddresses: { publicIPs: { count: 1 } },
        },
      });
      const getFirewall = network.GetAzureFirewall({
        subscriptionId: sub,
        resourceGroupName: group.resourceGroupName,
        azureFirewallName: FIREWALL,
      });
      yield* getFirewall.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("30 seconds"),
          until: (fw) => fw.properties?.provisioningState === "Succeeded",
          times: 60,
        }),
      );

      const { intent } = yield* stack.deploy(program(["Internet"]));
      expect(intent.policyNames).toEqual(["InternetPolicy"]);

      const updated = yield* stack.deploy(
        program(["Internet", "PrivateTraffic"]),
      );
      expect(updated.intent.routingIntentId).toEqual(intent.routingIntentId);
      const observed = yield* getIntent(
        group.resourceGroupName,
        hub.virtualHubName,
        intent.routingIntentName,
      );
      expect(observed.properties?.routingPolicies?.length).toEqual(2);

      // Remove the intent before the firewall, then the firewall before the
      // hub.
      yield* stack.deploy(standardHub);
      expect(
        yield* untilGone(
          getIntent(
            group.resourceGroupName,
            hub.virtualHubName,
            intent.routingIntentName,
          ),
        ),
      ).toEqual("gone");
      yield* network.DeleteAzureFirewall({
        subscriptionId: sub,
        resourceGroupName: group.resourceGroupName,
        azureFirewallName: FIREWALL,
      });
      expect(
        yield* untilGone(getFirewall).pipe(
          Effect.repeat({
            schedule: Schedule.spaced("30 seconds"),
            until: (status) => status === "gone",
            times: 40,
          }),
        ),
      ).toEqual("gone");
      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 10_800_000 },
);
