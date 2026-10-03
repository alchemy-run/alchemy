import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConnection = (
  resourceGroupName: string,
  circuitName: string,
  connectionName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetExpressRouteCircuitConnection({
      subscriptionId,
      resourceGroupName,
      circuitName,
      peeringName: "AzurePrivatePeering",
      connectionName,
    }),
  );

// Global Reach links the private peerings of two circuits that a
// connectivity provider has provisioned (AZURE_TEST_ER_RESOURCE_GROUP,
// AZURE_TEST_ER_CIRCUIT, AZURE_TEST_ER_PEER_CIRCUIT_ID). An unprovisioned
// circuit cannot even hold a private peering, so there is no ungated
// probe. Run with AZURE_TEST_PAID=1.
test.provider.skipIf(!runPaidOnly)(
  "create, replace, and delete an ExpressRoute Global Reach connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const resourceGroup = process.env.AZURE_TEST_ER_RESOURCE_GROUP ?? "";
      const circuit = process.env.AZURE_TEST_ER_CIRCUIT ?? "";
      const peerCircuitId = process.env.AZURE_TEST_ER_PEER_CIRCUIT_ID ?? "";
      const program = (addressPrefix: string) =>
        Azure.Network.ExpressRouteCircuitConnection("Reach", {
          resourceGroup,
          circuit,
          peering: "AzurePrivatePeering",
          peerCircuitPeeringId: `${peerCircuitId}/peerings/AzurePrivatePeering`,
          addressPrefix,
        });

      const connection = yield* stack.deploy(program("192.168.100.0/29"));
      const observed = yield* getConnection(
        resourceGroup,
        circuit,
        connection.connectionName,
      );
      expect(observed.properties?.addressPrefix).toEqual("192.168.100.0/29");

      const replaced = yield* stack.deploy(program("192.168.100.8/29"));
      expect(replaced.addressPrefix).toEqual("192.168.100.8/29");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getConnection(resourceGroup, circuit, replaced.connectionName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
