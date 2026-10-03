import * as Azure from "@/Azure";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as resourcemover from "@distilled.cloud/azure/resourcemover";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getMoveResource = (
  resourceGroupName: string,
  moveCollectionName: string,
  moveResourceName: string,
) =>
  Effect.gen(function* () {
    return yield* resourcemover.GetMoveResource({
      subscriptionId: yield* subscription,
      resourceGroupName,
      moveCollectionName,
      moveResourceName,
    });
  });

const program = (props: { source: "First" | "Second"; targetName: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const collection = yield* Azure.ResourceMover.MoveCollection("Moves", {
      resourceGroup: group.resourceGroupName,
      location: "eastus2",
      sourceRegion: "eastus",
      targetRegion: "westus2",
    });
    // The collection's identity reads the source and writes a link onto it.
    const grant = yield* Azure.Authorization.RoleAssignment(
      "MoverContributor",
      {
        scope: group.resourceGroupId,
        roleDefinitionId: Azure.Authorization.BuiltInRole.Contributor,
        principalId: collection.principalId,
        principalType: "ServicePrincipal",
      },
    );
    // Both NSGs stay deployed across the replacement step.
    const first = yield* Azure.Network.NetworkSecurityGroup("First", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
    });
    const second = yield* Azure.Network.NetworkSecurityGroup("Second", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
    });
    const source = props.source === "First" ? first : second;
    const moveResource = yield* Azure.ResourceMover.MoveResource("MoveNsg", {
      resourceGroup: group.resourceGroupName,
      // Ordered after the grant on create, and deleted before it: Azure
      // adds and removes the move resource with the collection's identity.
      moveCollection: Output.map(
        Output.all(collection.moveCollectionName, grant.roleAssignmentId),
        ([name]: [string, string]) => name,
      ),
      sourceId: source.networkSecurityGroupId,
      resourceSettings: {
        resourceType: "Microsoft.Network/networkSecurityGroups",
        targetResourceName: props.targetName,
      },
    });
    return { group, collection, source, moveResource };
  });

// Move collections, move resources, and NSGs are free; ~1-2 minutes.
test.provider(
  "create, update, replace, and delete a move resource",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, collection, source, moveResource } = yield* stack.deploy(
        program({ source: "First", targetName: "moved-nsg-a" }),
      );
      const get = (name: string) =>
        getMoveResource(
          group.resourceGroupName,
          collection.moveCollectionName,
          name,
        );
      expect(moveResource.sourceId.toLowerCase()).toEqual(
        source.networkSecurityGroupId.toLowerCase(),
      );
      const observed = yield* get(moveResource.moveResourceName);
      expect(observed.properties?.resourceSettings?.targetResourceName).toEqual(
        "moved-nsg-a",
      );
      expect(observed.properties?.sourceId.toLowerCase()).toEqual(
        source.networkSecurityGroupId.toLowerCase(),
      );

      // In-place: rename the target.
      const updated = yield* stack.deploy(
        program({ source: "First", targetName: "moved-nsg-b" }),
      );
      expect(updated.moveResource.moveResourceId).toEqual(
        moveResource.moveResourceId,
      );
      expect(updated.moveResource.resourceSettings?.targetResourceName).toEqual(
        "moved-nsg-b",
      );
      const reobserved = yield* get(moveResource.moveResourceName);
      expect(
        reobserved.properties?.resourceSettings?.targetResourceName,
      ).toEqual("moved-nsg-b");

      // Replacement: the source resource is immutable.
      const replaced = yield* stack.deploy(
        program({ source: "Second", targetName: "moved-nsg-b" }),
      );
      expect(replaced.moveResource.moveResourceName).not.toEqual(
        moveResource.moveResourceName,
      );
      const replacedObserved = yield* get(
        replaced.moveResource.moveResourceName,
      );
      expect(replacedObserved.properties?.sourceId.toLowerCase()).toEqual(
        replaced.source.networkSecurityGroupId.toLowerCase(),
      );
      expect(yield* waitGone(get(moveResource.moveResourceName))).toEqual(
        "gone",
      );

      yield* stack.destroy();
      expect(
        yield* waitGone(get(replaced.moveResource.moveResourceName)),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
