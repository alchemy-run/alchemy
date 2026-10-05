import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cosmos from "@distilled.cloud/azure/cosmos_db";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { runExpensive } from "../gates.ts";
import { logLevel, subscriptionId, waitGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

/**
 * Central US rejects dedicated gateway scale-out ("ServiceUnavailable:
 * Sorry, we are currently experiencing high demand in this region");
 * West US 2 creates and resizes in ~2 minutes.
 */
const LOCATION = "westus2";

const getService = (
  resourceGroupName: string,
  accountName: string,
  serviceName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    cosmos.GetService({
      subscriptionId,
      resourceGroupName,
      accountName,
      serviceName,
    }),
  );

const program = (props: { instanceCount: number }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: LOCATION,
    });
    // Dedicated compute requires a provisioned-throughput account.
    const account = yield* Azure.CosmosDB.DatabaseAccount("Account", {
      resourceGroup: group.resourceGroupName,
      location: LOCATION,
    });
    const service = yield* Azure.CosmosDB.Service("Gateway", {
      resourceGroup: group.resourceGroupName,
      account: account.accountName,
      serviceType: "SqlDedicatedGateway",
      instanceSize: "Cosmos.D4s",
      instanceCount: props.instanceCount,
    });
    return { group, account, service };
  });

// Dedicated gateway D4s instances bill ~$0.36/h each and take ~10-20 min
// to provision or resize; one run (1 → 2 → delete) is ~40-60 min and
// ~$0.50. Gated as expensive.
test.provider.skipIf(!runExpensive)(
  "create, scale, and delete a Cosmos DB dedicated gateway service",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, account, service } = yield* stack.deploy(
        program({ instanceCount: 1 }),
      );
      expect(service.serviceName).toEqual("SqlDedicatedGateway");
      expect(service.status).toEqual("Running");
      const observed = yield* getService(
        group.resourceGroupName,
        account.accountName,
        "SqlDedicatedGateway",
      );
      expect(observed.properties?.instanceCount).toEqual(1);

      // In-place update: instance count.
      const updated = yield* stack.deploy(program({ instanceCount: 2 }));
      expect(updated.service.serviceId).toEqual(service.serviceId);
      expect(updated.service.instanceCount).toEqual(2);
      const reobserved = yield* getService(
        group.resourceGroupName,
        account.accountName,
        "SqlDedicatedGateway",
      );
      expect(reobserved.properties?.instanceCount).toEqual(2);

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getService(
            group.resourceGroupName,
            account.accountName,
            "SqlDedicatedGateway",
          ),
          120,
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:cosmosdb", "live"],
    timeout: 3_600_000,
  },
);
