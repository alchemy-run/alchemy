import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";
import { spokeVnet, standardHub } from "./wanFixtures.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConnection = (
  resourceGroupName: string,
  virtualHubName: string,
  connectionName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetHubVirtualNetworkConnection({
      subscriptionId,
      resourceGroupName,
      virtualHubName,
      connectionName,
    }),
  );

const program = (enableInternetSecurity: boolean) =>
  Effect.gen(function* () {
    const { group, wan, hub } = yield* standardHub;
    const spoke = yield* spokeVnet(group.resourceGroupName, "10.1.0.0/16");
    const connection = yield* Azure.Network.HubVirtualNetworkConnection(
      "SpokeConnection",
      {
        resourceGroup: group.resourceGroupName,
        virtualHub: hub.virtualHubName,
        remoteVirtualNetworkId: spoke.virtualNetworkId,
        enableInternetSecurity,
      },
    );
    return { group, wan, hub, spoke, connection };
  });

// Needs a Standard hub (~$0.25/hour, 15-30 min to provision) plus the
// connection (~$0.05/hour): ≈$0.40 and ~45 minutes per run.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a hub virtual network connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, hub, spoke, connection } = yield* stack.deploy(
        program(false),
      );
      expect(connection.remoteVirtualNetworkId?.toLowerCase()).toEqual(
        spoke.virtualNetworkId.toLowerCase(),
      );
      const observed = yield* getConnection(
        group.resourceGroupName,
        hub.virtualHubName,
        connection.connectionName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.properties?.enableInternetSecurity).toEqual(false);

      const updated = yield* stack.deploy(program(true));
      expect(updated.connection.connectionId).toEqual(connection.connectionId);
      const reobserved = yield* getConnection(
        group.resourceGroupName,
        hub.virtualHubName,
        connection.connectionName,
      );
      expect(reobserved.properties?.enableInternetSecurity).toEqual(true);

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getConnection(
            group.resourceGroupName,
            hub.virtualHubName,
            connection.connectionName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 7_200_000 },
);
