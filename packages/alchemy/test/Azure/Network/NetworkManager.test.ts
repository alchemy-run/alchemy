import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import {
  logLevel,
  subscriptionId,
  tags,
  untilGone,
  withNetworkManager,
} from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getManager = (resourceGroupName: string, networkManagerName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetNetworkManager({
      subscriptionId,
      resourceGroupName,
      networkManagerName,
    }),
  );

// A network manager with nothing deployed is free.
const program = (props: { description: string; env: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: "eastus",
    });
    const manager = yield* Azure.Network.NetworkManager("Manager", {
      resourceGroup: group.resourceGroupName,
      description: props.description,
      scopeAccesses: ["SecurityAdmin"],
      tags: { env: props.env },
    });
    return { group, manager };
  });

test.provider(
  "create, update, and delete a network manager",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, manager } = yield* stack.deploy(
        program({ description: "one", env: "test" }),
      );
      const sub = yield* subscriptionId;
      expect(manager.subscriptions).toEqual([`/subscriptions/${sub}`]);
      expect(manager.scopeAccesses).toEqual(["SecurityAdmin"]);
      const observed = yield* getManager(
        group.resourceGroupName,
        manager.networkManagerName,
      );
      expect(observed.properties?.description).toEqual("one");
      expect(observed.tags?.env).toEqual("test");

      const updated = yield* stack.deploy(
        program({ description: "two", env: "prod" }),
      );
      expect(updated.manager.networkManagerId).toEqual(
        manager.networkManagerId,
      );
      const reobserved = yield* getManager(
        group.resourceGroupName,
        manager.networkManagerName,
      );
      expect(reobserved.properties?.description).toEqual("two");
      expect(reobserved.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getManager(group.resourceGroupName, manager.networkManagerName),
        ),
      ).toEqual("gone");
    }).pipe(withNetworkManager, logLevel),
  { tags, timeout: 600_000 },
);
