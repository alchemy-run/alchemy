import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runPaidOnly } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";
import { hubNva } from "./nvaFixtures.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getConnection = (
  resourceGroupName: string,
  networkVirtualApplianceName: string,
  connectionName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetNetworkVirtualApplianceConnection({
      subscriptionId,
      resourceGroupName,
      networkVirtualApplianceName,
      connectionName,
    }),
  );

const program = (props: { enableInternetSecurity: boolean }) =>
  Effect.gen(function* () {
    const { group, hub, nva } = yield* hubNva;
    const connection = yield* Azure.Network.NetworkVirtualApplianceConnection(
      "Bgp",
      {
        resourceGroup: group.resourceGroupName,
        networkVirtualAppliance: nva.networkVirtualApplianceName,
        asn: 64512,
        enableInternetSecurity: props.enableInternetSecurity,
        routing: {
          associatedRouteTableId: `${hub.virtualHubId}/hubRouteTables/defaultRouteTable`,
          propagatedLabels: ["default"],
        },
      },
    );
    return { group, nva, connection };
  });

// Needs a marketplace NVA in a Standard hub (blocked on the trial, 30+
// minutes, ~$0.25/hour + vendor licence). Run with AZURE_TEST_PAID=1.
test.provider.skipIf(!runPaidOnly)(
  "create, update, and delete a network virtual appliance connection",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, nva, connection } = yield* stack.deploy(
        program({ enableInternetSecurity: false }),
      );
      const observed = yield* getConnection(
        group.resourceGroupName,
        nva.networkVirtualApplianceName,
        connection.connectionName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");

      yield* stack.deploy(program({ enableInternetSecurity: true }));
      const reobserved = yield* getConnection(
        group.resourceGroupName,
        nva.networkVirtualApplianceName,
        connection.connectionName,
      );
      expect(reobserved.properties?.enableInternetSecurity).toEqual(true);

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getConnection(
            group.resourceGroupName,
            nva.networkVirtualApplianceName,
            connection.connectionName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 10_800_000 },
);
