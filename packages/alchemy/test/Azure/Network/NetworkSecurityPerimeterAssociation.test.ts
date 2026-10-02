import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getPerimeter = (
  resourceGroupName: string,
  networkSecurityPerimeterName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetNetworkSecurityPerimeter({
      subscriptionId,
      resourceGroupName,
      networkSecurityPerimeterName,
    }),
  );

const getAssociation = (
  resourceGroupName: string,
  networkSecurityPerimeterName: string,
  associationName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetNetworkSecurityPerimeterAssociation({
      subscriptionId,
      resourceGroupName,
      networkSecurityPerimeterName,
      associationName,
    }),
  );

// Perimeters are free; the empty Standard_LRS storage account costs nothing.
const program = (accessMode: "Learning" | "Enforced") =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const perimeter = yield* Azure.Network.NetworkSecurityPerimeter(
      "Perimeter",
      {
        resourceGroup: group.resourceGroupName,
      },
    );
    const profile = yield* Azure.Network.NetworkSecurityPerimeterProfile(
      "Default",
      {
        resourceGroup: group.resourceGroupName,
        networkSecurityPerimeter: perimeter.networkSecurityPerimeterName,
      },
    );
    const account = yield* Azure.Storage.StorageAccount("Data", {
      resourceGroup: group.resourceGroupName,
    });
    const association =
      yield* Azure.Network.NetworkSecurityPerimeterAssociation("Storage", {
        resourceGroup: group.resourceGroupName,
        networkSecurityPerimeter: perimeter.networkSecurityPerimeterName,
        privateLinkResourceId: account.storageAccountId,
        profileId: profile.profileId,
        accessMode,
      });
    return { group, perimeter, account, association };
  });

test.provider(
  "create, update, and delete a perimeter association",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, perimeter, account, association } = yield* stack.deploy(
        program("Learning"),
      );
      expect(association.accessMode).toEqual("Learning");
      expect(association.privateLinkResourceId?.toLowerCase()).toEqual(
        account.storageAccountId.toLowerCase(),
      );

      const updated = yield* stack.deploy(program("Enforced"));
      expect(updated.association.associationId).toEqual(
        association.associationId,
      );
      const observed = yield* getAssociation(
        group.resourceGroupName,
        perimeter.networkSecurityPerimeterName,
        association.associationName,
      );
      expect(observed.properties?.accessMode).toEqual("Enforced");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getPerimeter(
            group.resourceGroupName,
            perimeter.networkSecurityPerimeterName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
