import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as cosmos from "@distilled.cloud/azure/cosmos_db";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  COSMOS_LOCATION,
  logLevel,
  subscriptionId,
  waitGone,
} from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getMember = (
  resourceGroupName: string,
  fleetName: string,
  fleetspaceName: string,
  fleetspaceAccountName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    cosmos.GetFleetspaceAccount({
      subscriptionId,
      resourceGroupName,
      fleetName,
      fleetspaceName,
      fleetspaceAccountName,
    }),
  );

const program = (props: { space: "A" | "B" }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: COSMOS_LOCATION,
    });
    const fleet = yield* Azure.CosmosDB.Fleet("Fleet", {
      resourceGroup: group.resourceGroupName,
      location: COSMOS_LOCATION,
    });
    // Both fleetspaces stay deployed so a replacement never removes the
    // old membership's dependency in the same deploy.
    const spaceA = yield* Azure.CosmosDB.Fleetspace("SpaceA", {
      resourceGroup: group.resourceGroupName,
      fleet: fleet.fleetName,
      dataRegions: [COSMOS_LOCATION],
    });
    const spaceB = yield* Azure.CosmosDB.Fleetspace("SpaceB", {
      resourceGroup: group.resourceGroupName,
      fleet: fleet.fleetName,
      dataRegions: [COSMOS_LOCATION],
    });
    const account = yield* Azure.CosmosDB.DatabaseAccount("Account", {
      resourceGroup: group.resourceGroupName,
      location: COSMOS_LOCATION,
    });
    const member = yield* Azure.CosmosDB.FleetspaceAccount("Member", {
      resourceGroup: group.resourceGroupName,
      fleet: fleet.fleetName,
      fleetspace:
        props.space === "A" ? spaceA.fleetspaceName : spaceB.fleetspaceName,
      databaseAccountId: account.accountId,
      accountLocation: account.location,
    });
    return { group, fleet, spaceA, spaceB, account, member };
  });

// Fleet and fleetspaces without a pool are free; a provisioned-throughput
// account with no databases bills nothing. Account create/delete takes
// ~5-10 min in centralus.
test.provider(
  "add, move, and remove a Cosmos DB account in a fleetspace",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(program({ space: "A" }));
      const rg = created.group.resourceGroupName;
      const fleet = created.fleet.fleetName;
      const { member, account, spaceA, spaceB } = created;
      expect(member.fleetspace).toEqual(spaceA.fleetspaceName);
      expect(member.fleetspaceAccountName).toEqual(account.accountName);
      expect(member.databaseAccountId.toLowerCase()).toEqual(
        account.accountId.toLowerCase(),
      );
      const observed = yield* getMember(
        rg,
        fleet,
        spaceA.fleetspaceName,
        member.fleetspaceAccountName,
      );
      expect(observed.id).toEqual(member.fleetspaceAccountId);
      expect(
        observed.properties?.globalDatabaseAccountProperties?.resourceId?.toLowerCase(),
      ).toEqual(account.accountId.toLowerCase());

      // Re-deploying the same props is a no-op.
      const again = yield* stack.deploy(program({ space: "A" }));
      expect(again.member.fleetspaceAccountId).toEqual(
        member.fleetspaceAccountId,
      );

      // Replacement: moving to another fleetspace re-adds the account there.
      const moved = yield* stack.deploy(program({ space: "B" }));
      expect(moved.member.fleetspace).toEqual(spaceB.fleetspaceName);
      const movedObserved = yield* getMember(
        rg,
        fleet,
        spaceB.fleetspaceName,
        moved.member.fleetspaceAccountName,
      );
      expect(movedObserved.id).toEqual(moved.member.fleetspaceAccountId);
      expect(
        yield* waitGone(
          getMember(
            rg,
            fleet,
            spaceA.fleetspaceName,
            member.fleetspaceAccountName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getMember(
            rg,
            fleet,
            spaceB.fleetspaceName,
            moved.member.fleetspaceAccountName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  {
    tags: ["provider:azure", "provider:azure:cosmosdb", "live"],
    timeout: 900_000,
  },
);
