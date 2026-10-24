import * as Azure from "@alchemy.run/azure";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";
import { standardHub } from "./wanFixtures.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getGateway = (resourceGroupName: string, expressRouteGatewayName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetExpressRouteGateway({
      subscriptionId,
      resourceGroupName,
      expressRouteGatewayName,
    }),
  );

const program = (props: { allowNonVirtualWanTraffic: boolean; env: string }) =>
  Effect.gen(function* () {
    const { group, wan, hub } = yield* standardHub;
    const gateway = yield* Azure.Network.ExpressRouteGateway("Er", {
      resourceGroup: group.resourceGroupName,
      virtualHubId: hub.virtualHubId,
      minScaleUnits: 1,
      allowNonVirtualWanTraffic: props.allowNonVirtualWanTraffic,
      tags: { env: props.env },
    });
    return { group, wan, hub, gateway };
  });

// ~$1.50/run, over an hour: a Standard hub (~$0.25/hour, 15-30 min) plus
// an ExpressRoute gateway (~$0.42/hour per scale unit, 30+ min).
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a Virtual WAN ExpressRoute gateway",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, hub, gateway } = yield* stack.deploy(
        program({ allowNonVirtualWanTraffic: false, env: "test" }),
      );
      expect(gateway.virtualHubId?.toLowerCase()).toEqual(hub.virtualHubId.toLowerCase());
      const observed = yield* getGateway(group.resourceGroupName, gateway.expressRouteGatewayName);
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.autoScaleConfiguration?.bounds?.min).toEqual(1);
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(
        program({ allowNonVirtualWanTraffic: true, env: "prod" }),
      );
      expect(updated.gateway.expressRouteGatewayId).toEqual(gateway.expressRouteGatewayId);
      const reobserved = yield* getGateway(
        group.resourceGroupName,
        gateway.expressRouteGatewayName,
      );
      expect(reobserved.properties?.allowNonVirtualWanTraffic).toEqual(true);
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(getGateway(group.resourceGroupName, gateway.expressRouteGatewayName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 10_800_000 },
);
