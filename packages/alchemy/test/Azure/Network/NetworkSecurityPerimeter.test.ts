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

// Network security perimeters are free.
const program = (env: string) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const perimeter = yield* Azure.Network.NetworkSecurityPerimeter(
      "Perimeter",
      {
        resourceGroup: group.resourceGroupName,
        tags: { env },
      },
    );
    return { group, perimeter };
  });

test.provider(
  "create, update, and delete a network security perimeter",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, perimeter } = yield* stack.deploy(program("test"));
      expect(perimeter.perimeterGuid).toBeDefined();
      expect(
        (yield* getPerimeter(
          group.resourceGroupName,
          perimeter.networkSecurityPerimeterName,
        )).tags?.env,
      ).toEqual("test");

      const updated = yield* stack.deploy(program("prod"));
      expect(updated.perimeter.networkSecurityPerimeterId).toEqual(
        perimeter.networkSecurityPerimeterId,
      );
      expect(
        (yield* getPerimeter(
          group.resourceGroupName,
          perimeter.networkSecurityPerimeterName,
        )).tags?.env,
      ).toEqual("prod");

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
  { tags, timeout: 600_000 },
);
