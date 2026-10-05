import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { getTrafficController, logLevel, tags, untilGone } from "./util.ts";

const { test } = Test.make({ providers: Azure.providers() });

const groupOnly = Effect.gen(function* () {
  const group = yield* Azure.Resources.ResourceGroup("Group", {
    location: "eastus",
  });
  return { group };
});

const withController = (props: {
  name?: string;
  tags: Record<string, string>;
}) =>
  Effect.gen(function* () {
    const { group } = yield* groupOnly;
    const controller = yield* Azure.ServiceNetworking.TrafficController(
      "Controller",
      {
        resourceGroup: group.resourceGroupName,
        name: props.name,
        tags: props.tags,
      },
    );
    return { group, controller };
  });

// Cost: a traffic controller bills ~$0.017/hour; two generations for a few
// minutes each (< $0.05). ~5-10 minutes.
test.provider(
  "create, update tags, replace, and delete a traffic controller",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // Create.
      const { group, controller } = yield* stack.deploy(
        withController({ tags: { env: "test" } }),
      );
      const rg = group.resourceGroupName;
      expect(controller.tags).toEqual({ env: "test" });
      expect(controller.location).toEqual("eastus");
      const observed = yield* getTrafficController(
        rg,
        controller.trafficControllerName,
      );
      expect(observed.properties?.provisioningState).toEqual("Succeeded");
      expect(observed.tags?.["alchemy::id"]).toEqual("Controller");
      expect(observed.id?.toLowerCase()).toEqual(
        controller.trafficControllerId.toLowerCase(),
      );

      // In-place update: tags.
      const updated = yield* stack.deploy(
        withController({ tags: { env: "prod" } }),
      );
      expect(updated.controller.trafficControllerName).toEqual(
        controller.trafficControllerName,
      );
      expect(
        (yield* getTrafficController(rg, controller.trafficControllerName)).tags
          ?.env,
      ).toEqual("prod");

      // Replacement: an explicit name.
      const replaced = yield* stack.deploy(
        withController({ name: "alchemy-test-agc-renamed", tags: {} }),
      );
      expect(replaced.controller.trafficControllerName).toEqual(
        "alchemy-test-agc-renamed",
      );
      expect(
        (yield* getTrafficController(rg, "alchemy-test-agc-renamed")).properties
          ?.provisioningState,
      ).toEqual("Succeeded");
      expect(
        yield* untilGone(
          getTrafficController(rg, controller.trafficControllerName),
        ),
      ).toEqual("gone");

      // Delete.
      yield* stack.deploy(groupOnly);
      expect(
        yield* untilGone(getTrafficController(rg, "alchemy-test-agc-renamed")),
      ).toEqual("gone");

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
