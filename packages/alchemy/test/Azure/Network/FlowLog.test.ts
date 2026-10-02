import * as Azure from "@/Azure";
import * as Test from "@/Test/Alchemy";
import * as network from "@distilled.cloud/azure/network";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { logLevel, subscriptionId, tags, untilGone } from "./helpers.ts";

const { test } = Test.make({ providers: Azure.providers() });

const getFlowLog = (
  resourceGroupName: string,
  networkWatcherName: string,
  flowLogName: string,
) =>
  Effect.flatMap(subscriptionId, (subscriptionId) =>
    network.GetFlowLog({
      subscriptionId,
      resourceGroupName,
      networkWatcherName,
      flowLogName,
    }),
  );

// VNet flow logs bill per GB collected; an idle VNet logs nothing, and the
// empty storage account is free. The test owns the region's watcher, so it
// runs in a region without VNets and creates the VNet after the watcher.
const REGION = "canadacentral";

const program = (props: { retentionDays: number; env: string }) =>
  Effect.gen(function* () {
    const group = yield* Azure.Resources.ResourceGroup("Group", {
      location: REGION,
    });
    const watcher = yield* Azure.Network.NetworkWatcher("Watcher", {
      resourceGroup: group.resourceGroupName,
      location: REGION,
    });
    const vnet = yield* Azure.Network.VirtualNetwork("Vnet", {
      resourceGroup: group.resourceGroupName,
      location: REGION,
      addressPrefixes: ["10.0.0.0/16"],
      // Order the VNet after the watcher so Azure does not auto-create one.
      tags: { watcher: watcher.networkWatcherName },
    });
    const account = yield* Azure.Storage.StorageAccount("Logs", {
      resourceGroup: group.resourceGroupName,
      location: REGION,
    });
    const flowLog = yield* Azure.Network.FlowLog("VnetFlows", {
      resourceGroup: group.resourceGroupName,
      networkWatcher: watcher.networkWatcherName,
      location: REGION,
      targetResourceId: vnet.virtualNetworkId,
      storageId: account.storageAccountId,
      retentionDays: props.retentionDays,
      tags: { env: props.env },
    });
    return { group, watcher, flowLog };
  });

test.provider(
  "create, update, and delete a VNet flow log",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const { group, watcher, flowLog } = yield* stack.deploy(
        program({ retentionDays: 7, env: "test" }),
      );
      expect(flowLog.enabled).toEqual(true);
      expect(flowLog.retentionDays).toEqual(7);

      const updated = yield* stack.deploy(
        program({ retentionDays: 14, env: "prod" }),
      );
      expect(updated.flowLog.flowLogId).toEqual(flowLog.flowLogId);
      const observed = yield* getFlowLog(
        group.resourceGroupName,
        watcher.networkWatcherName,
        flowLog.flowLogName,
      );
      expect(observed.properties?.retentionPolicy?.days).toEqual(14);
      expect(observed.tags?.env).toEqual("prod");

      yield* stack.destroy();
      expect(
        yield* untilGone(
          getFlowLog(
            group.resourceGroupName,
            watcher.networkWatcherName,
            flowLog.flowLogName,
          ),
        ),
      ).toEqual("gone");
    }).pipe(logLevel),
  { tags, timeout: 900_000 },
);
