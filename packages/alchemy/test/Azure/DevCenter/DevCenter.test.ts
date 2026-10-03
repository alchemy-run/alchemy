import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as devcenter from "@distilled.cloud/azure/devcenter";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getDevCenter = (resourceGroupName: string, devCenterName: string) =>
  Effect.gen(function* () {
    return yield* devcenter.GetDevCenter({
      subscriptionId: yield* subscription,
      resourceGroupName,
      devCenterName,
    });
  });

const program = (props: {
  location: string;
  displayName: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const center = yield* Azure.DevCenter.DevCenter("Center", {
      resourceGroup: group.resourceGroupName,
      location: props.location,
      identity: { type: "SystemAssigned" },
      displayName: props.displayName,
      tags: props.tags,
    });
    return { group, center };
  });

// Dev centers are free; ~1-3 minutes per create.
test.provider(
  "create, update, replace, and delete a dev center",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, center } = yield* stack.deploy(
        program({ location: "eastus", displayName: "One", tags: { a: "1" } }),
      );
      expect(center.devCenterUri).toBeDefined();
      expect(center.principalId).toBeDefined();
      expect(center.identityType).toEqual("SystemAssigned");
      const observed = yield* getDevCenter(
        group.resourceGroupName,
        center.devCenterName,
      );
      expect(observed.properties?.displayName).toEqual("One");
      expect(observed.tags?.a).toEqual("1");
      expect(observed.tags?.["alchemy::id"]).toEqual("Center");

      // In place: display name and tags.
      const updated = yield* stack.deploy(
        program({ location: "eastus", displayName: "Two", tags: { a: "2" } }),
      );
      expect(updated.center.devCenterId).toEqual(center.devCenterId);
      const reobserved = yield* getDevCenter(
        group.resourceGroupName,
        center.devCenterName,
      );
      expect(reobserved.properties?.displayName).toEqual("Two");
      expect(reobserved.tags?.a).toEqual("2");

      // Replacement: the location is immutable.
      const replaced = yield* stack.deploy(
        program({ location: "westus3", displayName: "Two", tags: { a: "2" } }),
      );
      expect(replaced.center.devCenterName).not.toEqual(center.devCenterName);
      expect(replaced.center.location).toEqual("westus3");
      expect(
        yield* waitGone(
          getDevCenter(group.resourceGroupName, center.devCenterName),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getDevCenter(group.resourceGroupName, replaced.center.devCenterName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
