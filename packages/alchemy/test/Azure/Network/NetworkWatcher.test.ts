import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getWatcher = (resourceGroupName: string, networkWatcherName: string) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetNetworkWatcher({
      subscriptionId,
      resourceGroupName,
      networkWatcherName,
    }),
  );

// Network watchers are free. A subscription holds one watcher per region,
// and Azure auto-creates one in any region that gets a VNet, so the test
// uses a region the test subscription has no VNets in.
const REGION = "canadaeast";

const program = (env: string) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: REGION,
    });
    const watcher = yield* Azure.Network.NetworkWatcher("Watcher", {
      resourceGroup: group.resourceGroupName,
      location: REGION,
      tags: { env },
    });
    return { group, watcher };
  });

test.provider(
  "create, update, and delete a network watcher",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, watcher } = yield* stack.deploy(program("test"));
      expect(watcher.location).toEqual(REGION);
      expect(
        (yield* getWatcher(group.resourceGroupName, watcher.networkWatcherName))
          .tags?.env,
      ).toEqual("test");

      const updated = yield* stack.deploy(program("prod"));
      expect(updated.watcher.networkWatcherId).toEqual(
        watcher.networkWatcherId,
      );
      expect(
        (yield* getWatcher(group.resourceGroupName, watcher.networkWatcherName))
          .tags?.env,
      ).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getWatcher(group.resourceGroupName, watcher.networkWatcherName),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 600_000 },
);
