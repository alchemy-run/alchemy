import * as Azure from "@alchemy.run/azure";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Test from "alchemy/Test/Alchemy";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";
import { standardHub } from "./wanFixtures.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConnection = (
  resourceGroupName: string,
  expressRouteGatewayName: string,
  connectionName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetExpressRouteConnection({
      subscriptionId,
      resourceGroupName,
      expressRouteGatewayName,
      connectionName,
    }),
  );

const program = (circuitPeeringId: string, routingWeight: number) =>
  Effect.gen(function* () {
    const { group, hub } = yield* standardHub;
    const gateway = yield* Azure.Network.ExpressRouteGateway("Er", {
      resourceGroup: group.resourceGroupName,
      virtualHubId: hub.virtualHubId,
    });
    const connection = yield* Azure.Network.ExpressRouteConnection("Dc", {
      resourceGroup: group.resourceGroupName,
      expressRouteGateway: gateway.expressRouteGatewayName,
      expressRouteCircuitPeeringId: circuitPeeringId,
      routingWeight,
    });
    return { group, hub, gateway, connection };
  });

// ~$2/run, over an hour: a Standard hub (~$0.25/hour) + an ExpressRoute
// gateway (~$0.42/hour, 30+ min) + a circuit that a connectivity provider
// has provisioned with private peering (AZURE_TEST_ER_RESOURCE_GROUP,
// AZURE_TEST_ER_CIRCUIT). There is no cheap ungated probe: the rejection
// for an unprovisioned circuit comes only from a provisioned ExpressRoute
// gateway. Run with AZURE_TEST_PAID=1 and the circuit variables set.
test.provider.skipIf(!runPaidOnly || !process.env.AZURE_TEST_ER_CIRCUIT)(
  "create, update, and delete a Virtual WAN ExpressRoute connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const subscription = yield* subscriptionId;
      const resourceGroup = process.env.AZURE_TEST_ER_RESOURCE_GROUP ?? "";
      const circuit = process.env.AZURE_TEST_ER_CIRCUIT ?? "";
      const peeringId = `/subscriptions/${subscription}/resourceGroups/${resourceGroup}/providers/Microsoft.Network/expressRouteCircuits/${circuit}/peerings/AzurePrivatePeering`;

      const { group, gateway, connection } = yield* stack.deploy(program(peeringId, 0));
      expect(connection.expressRouteCircuitPeeringId?.toLowerCase()).toEqual(
        peeringId.toLowerCase(),
      );
      const observed = yield* getConnection(
        group.resourceGroupName,
        gateway.expressRouteGatewayName,
        connection.connectionName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");

      const updated = yield* stack.deploy(program(peeringId, 10));
      expect(updated.connection.connectionId).toEqual(connection.connectionId);
      const reobserved = yield* getConnection(
        group.resourceGroupName,
        gateway.expressRouteGatewayName,
        connection.connectionName,
      );
      expect(reobserved.properties?.routingWeight).toEqual(10);

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getConnection(
            group.resourceGroupName,
            gateway.expressRouteGatewayName,
            connection.connectionName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 10_800_000 },
);
