import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";
import { standardHub } from "./wanFixtures.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getTable = (
  resourceGroupName: string,
  virtualHubName: string,
  routeTableName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetHubRouteTable({
      subscriptionId,
      resourceGroupName,
      virtualHubName,
      routeTableName,
    }),
  );

const program = (labels: string[]) =>
  Effect.gen(function* () {
    const { group, wan, hub } = yield* standardHub;
    const table = yield* Azure.Network.HubRouteTable("Spokes", {
      resourceGroup: group.resourceGroupName,
      virtualHub: hub.virtualHubName,
      labels,
    });
    return { group, wan, hub, table };
  });

// Needs a Standard hub (~$0.25/hour, 15-30 min to provision): ≈$0.30 and
// ~40 minutes per run.
test.provider.skipIf(!runExpensive)(
  "create, update, and delete a hub route table",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, hub, table } = yield* stack.deploy(program(["spokes"]));
      expect(table.labels).toEqual(["spokes"]);
      const observed = yield* getTable(
        group.resourceGroupName,
        hub.virtualHubName,
        table.routeTableName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");

      const updated = yield* stack.deploy(program(["spokes", "blue"]));
      expect(updated.table.routeTableId).toEqual(table.routeTableId);
      const reobserved = yield* getTable(
        group.resourceGroupName,
        hub.virtualHubName,
        table.routeTableName,
      );
      expect([...(reobserved.properties?.labels ?? [])].sort()).toEqual([
        "blue",
        "spokes",
      ]);

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getTable(
            group.resourceGroupName,
            hub.virtualHubName,
            table.routeTableName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
