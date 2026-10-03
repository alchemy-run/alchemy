import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as devcenter from "@distilled.cloud/azure/devcenter";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscription, tags, waitGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getEnvironmentType = (
  resourceGroupName: string,
  devCenterName: string,
  environmentTypeName: string,
) =>
  Effect.gen(function* () {
    return yield* devcenter.GetEnvironmentType({
      subscriptionId: yield* subscription,
      resourceGroupName,
      devCenterName,
      environmentTypeName,
    });
  });

const program = (props: {
  name?: string;
  displayName: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const center = yield* Azure.DevCenter.DevCenter("Center", {
      resourceGroup: group.resourceGroupName,
      location: "eastus",
    });
    const environmentType = yield* Azure.DevCenter.EnvironmentType(
      "EnvironmentType",
      {
        resourceGroup: group.resourceGroupName,
        devCenter: center.devCenterName,
        name: props.name,
        displayName: props.displayName,
        tags: props.tags,
      },
    );
    return { group, center, environmentType };
  });

// Dev centers and environment types are free; ~10 minutes in total (the
// dev center create and delete dominate), $0.
test.provider(
  "create, update, replace, and delete an environment type",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, center, environmentType } = yield* stack.deploy(
        program({ displayName: "One", tags: { a: "1" } }),
      );
      expect(environmentType.devCenter).toEqual(center.devCenterName);
      const observed = yield* getEnvironmentType(
        group.resourceGroupName,
        center.devCenterName,
        environmentType.environmentTypeName,
      );
      expect(observed.id).toEqual(environmentType.environmentTypeId);
      expect(observed.properties?.displayName).toEqual("One");
      expect(observed.tags?.a).toEqual("1");
      expect(observed.tags?.["alchemy::id"]).toEqual("EnvironmentType");

      // In place: display name and tags.
      const updated = yield* stack.deploy(
        program({ displayName: "Two", tags: { a: "2" } }),
      );
      expect(updated.environmentType.environmentTypeId).toEqual(
        environmentType.environmentTypeId,
      );
      const reobserved = yield* getEnvironmentType(
        group.resourceGroupName,
        center.devCenterName,
        environmentType.environmentTypeName,
      );
      expect(reobserved.properties?.displayName).toEqual("Two");
      expect(reobserved.tags?.a).toEqual("2");

      // Replacement: the name is immutable.
      const replaced = yield* stack.deploy(
        program({ name: "staging", displayName: "Two", tags: { a: "2" } }),
      );
      expect(replaced.environmentType.environmentTypeName).toEqual("staging");
      expect(
        yield* waitGone(
          getEnvironmentType(
            group.resourceGroupName,
            center.devCenterName,
            environmentType.environmentTypeName,
          ),
        ),
      ).toEqual("gone");

      yield* stack.destroy();
      expect(
        yield* waitGone(
          getEnvironmentType(
            group.resourceGroupName,
            center.devCenterName,
            "staging",
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
